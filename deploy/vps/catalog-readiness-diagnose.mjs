// Read the configured production D1 through SELECT-only Wrangler queries.
// Reconstruct only a transient in-memory snapshot; production data is never written.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';

const ROOT = '/app';
const W = '00000000-0000-4000-8000-000000000001';
const requirePackage = createRequire('/app/package.json');
const ts = requirePackage('typescript');
const approvedModules = new Set(['lib/website-backfill.ts', 'lib/product-integrity.ts',
  'lib/website-product.ts', 'lib/ai/shoe-content.ts', 'lib/image-compression.ts',
  'lib/integrations/env.ts', 'lib/integrations/store.ts', 'lib/integrations/crypto.ts',
  'lib/integrations/google-drive.ts']);
function requireState(value, code) { if (!value) throw Error(code); }
function code(error) {
  return /^(?:PRODUCT_|SKU_|WEBSITE_|CONTENT_|CATALOG_)[A-Z_]+$/.test(error?.message || '')
    ? error.message : 'CATALOG_READINESS_CHECK_FAILED';
}
function snapshotDatabase() {
  const tables = ['products', 'workspaces', 'content_drafts', 'channel_connections',
    'product_media', 'media_assets', 'product_variants'];
  const statements = ["SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ("
    + tables.map(table => "'" + table + "'").join(',') + ')',
  ...tables.map(table => `SELECT * FROM ${table} WHERE ${table === 'workspaces' ? 'id' : 'workspace_id'}='${W}'`)];
  // One CLI invocation resolves DB using its actual Wrangler configuration,
  // avoiding accidental selection among old local D1 SQLite files.
  const raw = execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'DB', '--local',
    '--persist-to=/data', '--config=/app/wrangler.vps.jsonc', '--json', '--command', statements.join(';')],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  const results = JSON.parse(raw);
  requireState(Array.isArray(results) && results.length === tables.length + 1
    && results.every(result => result.success === true && Array.isArray(result.results)), 'CATALOG_SNAPSHOT_INVALID');
  const schemas = results[0].results;
  requireState(schemas.length === tables.length && new Set(schemas.map(row => row.name)).size === tables.length
    && schemas.every(row => tables.includes(row.name) && typeof row.sql === 'string'
      && /^CREATE TABLE\s/iu.test(row.sql) && !row.sql.includes(';')), 'CATALOG_SCHEMA_INVALID');
  requireState(results[2].results.length === 1 && results[2].results[0].id === W, 'CATALOG_WORKSPACE_INVALID');
  const sqlite = new DatabaseSync(':memory:', { allowExtension: false });
  try {
    sqlite.exec('PRAGMA foreign_keys=OFF');
    for (const schema of schemas) sqlite.exec(schema.sql);
    for (const [index, table] of tables.entries()) {
      for (const row of results[index + 1].results) {
        requireState(row && (table === 'workspaces' ? row.id : row.workspace_id) === W, 'CATALOG_SNAPSHOT_SCOPE_INVALID');
        const columns = Object.keys(row);
        requireState(columns.length > 0 && columns.every(column => /^[A-Za-z_][A-Za-z0-9_]*$/.test(column)), 'CATALOG_COLUMN_INVALID');
        const insert = sqlite.prepare(`INSERT INTO "${table}" (${columns.map(column => '"' + column + '"').join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
        insert.run(...columns.map(column => row[column]));
      }
    }
    sqlite.exec('PRAGMA query_only=ON');
    return sqlite;
  } catch (error) { sqlite.close(); throw error; }
}

function readDatabase(sqlite) {
  return { prepare(sql) {
    requireState(/^\s*SELECT\b/iu.test(sql) && !sql.includes(';'), 'CATALOG_SELECT_ONLY');
    const statement = sqlite.prepare(sql);
    let values = [];
    return {
      bind(...next) { values = next; return this; },
      async first() { return statement.get(...values) ?? null; },
      async all() { return { results: statement.all(...values) }; },
      async run() { throw Error('CATALOG_READ_ONLY'); },
    };
  }, async batch() { throw Error('CATALOG_READ_ONLY'); } };
}
function loader(runtime) {
  const cache = new Map();
  const context = vm.createContext({ Error, crypto: globalThis.crypto, TextEncoder, TextDecoder,
    URL, Request, Response, Headers, Blob, FormData, AbortSignal, Uint8Array, ArrayBuffer, atob, btoa,
    fetch() { throw Error('CATALOG_NETWORK_DISABLED'); },
    console: { log() { throw Error('CATALOG_MODULE_OUTPUT_DISABLED'); }, error() { throw Error('CATALOG_MODULE_OUTPUT_DISABLED'); } },
  });
  function load(relative) {
    requireState(approvedModules.has(relative), 'CATALOG_MODULE_NOT_APPROVED');
    if (cache.has(relative)) return cache.get(relative).exports;
    const filename = path.join(ROOT, relative);
    requireState(realpathSync(filename) === filename, 'CATALOG_MODULE_PATH_INVALID');
    let source = readFileSync(filename, 'utf8');
    if (relative === 'lib/website-backfill.ts') source += '\nexport { preparedListing };\n';
    const compiled = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText;
    const compiledModule = { exports: {} };
    cache.set(relative, compiledModule);
    const localRequire = (specifier) => {
      if (specifier === 'cloudflare:workers') return { env: runtime };
      requireState(specifier.startsWith('.'), 'CATALOG_MODULE_NOT_APPROVED');
      return load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier + '.ts')));
    };
    const execute = new vm.Script('(function(module,exports,require){\n' + compiled + '\n})', { filename }).runInContext(context);
    execute(compiledModule, compiledModule.exports, localRequire);
    return compiledModule.exports;
  }
  return load;
}
function stringCount(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;\n|]+/u) : [];
  return new Set(values.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim().slice(0, 160))).size;
}
async function main() {
  const sqlite = snapshotDatabase();
  try {
    const db = readDatabase(sqlite);
    const runtime = { ...parseEnv(readFileSync('/app/.dev.vars', 'utf8')), DB: db };
    const load = loader(runtime);
    const { preparedListing } = load('lib/website-backfill.ts');
    const { productSources, productFingerprint, objectJson } = load('lib/product-integrity.ts');
    const { customerCopyViolation } = load('lib/ai/shoe-content.ts');
    const candidates = sqlite.prepare(`SELECT d.id,p.id AS product_id,p.base_sku,p.description,p.metadata_json,
      p.updated_at AS product_updated_at,d.target_provider,d.title,d.body,d.hashtags_json,d.platform_data_json,d.version,d.updated_at,
      (SELECT MIN(v.price_minor) FROM product_variants v WHERE v.product_id=p.id AND v.workspace_id=p.workspace_id AND v.status='active') AS price_minor,
      (SELECT COUNT(*) FROM product_media pm JOIN media_assets m ON m.id=pm.media_id AND m.workspace_id=pm.workspace_id
        WHERE pm.product_id=p.id AND pm.workspace_id=p.workspace_id AND m.origin='source' AND m.media_type='image' AND m.status='ready') AS source_image_count
      FROM products p LEFT JOIN content_drafts d ON d.id=(
        SELECT latest.id FROM content_drafts latest WHERE latest.workspace_id=p.workspace_id AND latest.product_id=p.id
          AND latest.target_provider IN ('facebook','website') AND latest.archived_at IS NULL
          AND latest.status IN ('draft','in_review','approved') AND COALESCE(latest.generator,'')!='website-backfill'
        ORDER BY latest.updated_at DESC,(latest.target_provider='website') DESC,latest.id DESC LIMIT 1)
        AND d.workspace_id=p.workspace_id
      WHERE p.workspace_id=? AND p.deleted_at IS NULL AND p.status='active' ORDER BY p.base_sku`).all(W);
    for (const source of candidates) {
      const report = {
        sku: /^[A-Za-z0-9_-]{1,120}$/.test(source.base_sku) ? source.base_sku : 'INVALID_SKU',
        sourceImageCount: source.source_image_count,
        positivePrice: Number.isSafeInteger(source.price_minor) && source.price_minor > 0,
        sizeCount: stringCount(objectJson(source.metadata_json).website?.sizes),
        hasDescription: Boolean(source.description?.trim()), copyViolation: null, ready: false, errorCode: null,
      };
      try {
        const listing = await preparedListing(source, db);
        report.ready = Boolean(listing);
        const sources = await productSources(source.product_id, db);
        report.sourceImageCount = sources.images.length;
        const platform = objectJson(source.platform_data_json);
        const currentCopy = platform.sourceFingerprint === await productFingerprint(sources.product) && platform.sku === sources.sku;
        let body = currentCopy ? source.target_provider === 'website' ? source.body?.trim() || ''
          : typeof platform.productDescription === 'string' && platform.productDescription.trim()
            ? platform.productDescription.trim() : source.body?.trim() || '' : '';
        let hashtags = [];
        try { const parsed = JSON.parse(source.hashtags_json || '[]'); if (Array.isArray(parsed)) hashtags = parsed.filter(item => typeof item === 'string'); } catch { /* Empty legacy hashtags. */ }
        let title = currentCopy && source.target_provider === 'website' ? source.title || sources.product.name : sources.product.name;
        if (!body || customerCopyViolation({ title, body, hashtags })) {
          body = sources.product.description.trim(); title = sources.product.name; hashtags = [];
        }
        report.copyViolation = customerCopyViolation({ title, body, hashtags });
        if (!listing) {
          const incompleteImage = sources.images.some(image => !image.mime_type?.startsWith('image/')
            || !(objectJson(image.metadata_json).md5Checksum || objectJson(image.metadata_json).modifiedTime));
          report.errorCode = !report.positivePrice ? 'WEBSITE_PRODUCT_PRICE_REQUIRED'
            : incompleteImage ? 'PRODUCT_SOURCE_IMAGE_METADATA_INCOMPLETE'
              : !body ? 'WEBSITE_PRODUCT_DESCRIPTION_REQUIRED'
                : report.copyViolation || 'CATALOG_READINESS_RETURNED_NULL';
        }
      } catch (error) { report.errorCode = code(error); }
      console.log('CATALOG_READINESS=' + JSON.stringify(report));
    }
  } finally { sqlite.close(); }
}
try { await main(); } catch (error) {
  console.error(code(error));
  process.exitCode = 1;
}
