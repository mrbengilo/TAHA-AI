// Read production readiness logic against SQLite in read-only mode. No writes or network.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';

const ROOT = '/app';
const DATA = '/data';
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
function sqliteFiles(directory, output = [], depth = 0) {
  requireState(depth < 20 && output.length < 100, 'CATALOG_DATABASE_SEARCH_LIMIT');
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) sqliteFiles(filename, output, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.sqlite')) output.push(filename);
  }
  return output;
}
function discoverDatabase() {
  const matches = [];
  for (const filename of sqliteFiles(DATA)) {
    let sqlite;
    try {
      const resolved = realpathSync(filename);
      requireState(resolved.startsWith(DATA + '/'), 'CATALOG_DATABASE_PATH_INVALID');
      sqlite = new DatabaseSync(resolved, { readOnly: true, allowExtension: false });
      const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('products','workspaces','content_drafts','channel_connections','product_media','media_assets','product_variants')").all();
      if (tables.length === 7 && sqlite.prepare('SELECT id FROM workspaces WHERE id=?').get(W)) {
        matches.push(sqlite);
        sqlite = null;
      }
    } catch { /* Not the production application database. */ }
    finally { sqlite?.close(); }
  }
  if (matches.length !== 1) {
    for (const sqlite of matches) sqlite.close();
    throw Error('CATALOG_DATABASE_AMBIGUOUS');
  }
  return matches[0];
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
  const sqlite = discoverDatabase();
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
