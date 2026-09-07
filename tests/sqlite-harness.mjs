import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const WORKSPACE = "00000000-0000-4000-8000-000000000001";
export function harness() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(path.join(ROOT, "drizzle")).filter((name) => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(ROOT, "drizzle", file), "utf8"));
  const hooks = { beforeBatch: null, beforeFirst: null };
  class Statement {
    constructor(sql) { this.sql = sql; this.values = []; }
    bind(...values) { this.values = values; return this; }
    result() { const result = sqlite.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: result.changes } }; }
    async run() { return this.result(); }
    async all() { return { results: sqlite.prepare(this.sql).all(...this.values) }; }
    async first() {
      if (hooks.beforeFirst) await hooks.beforeFirst(this.sql);
      return sqlite.prepare(this.sql).get(...this.values) ?? null;
    }
  }
  const db = {
    prepare: (sql) => new Statement(sql),
    async batch(statements) {
      if (hooks.beforeBatch) { const hook = hooks.beforeBatch; hooks.beforeBatch = null; await hook(); }
      sqlite.exec("BEGIN");
      try { const results = statements.map((statement) => statement.result()); sqlite.exec("COMMIT"); return results; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  const runtime = { DB: db, OPENAI_API_KEY: "fake-test-key", INTERNAL_API_SECRET: "test-internal-secret" };
  const cache = new Map();
  const overrides = new Map();
  const nativeRequire = createRequire(import.meta.url);
  function load(relative) {
    const filename = path.resolve(ROOT, relative);
    if (overrides.has(filename)) return overrides.get(filename);
    if (cache.has(filename)) return cache.get(filename);
    const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const compiledModule = { exports: {} };
    cache.set(filename, compiledModule.exports);
    const context = vm.createContext({ module: compiledModule, exports: compiledModule.exports, console, Error, crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, Request, Response, Headers, Blob, FormData, AbortSignal, Uint8Array, ArrayBuffer, atob, btoa, setTimeout, clearTimeout,
      process: { env: { NODE_ENV: "production" } },
      fetch: (...args) => { if (runtime.TEST_FETCH) return runtime.TEST_FETCH(...args); throw new Error("Unexpected live request in regression test"); },
      require(specifier) {
        if (specifier === "cloudflare:workers") return { env: runtime };
        if (specifier.startsWith(".")) return load(path.resolve(path.dirname(filename), `${specifier}.ts`));
        return nativeRequire(specifier);
      },
    });
    new vm.Script(code, { filename }).runInContext(context);
    return compiledModule.exports;
  }
  const now = Date.now();
  sqlite.prepare("INSERT INTO workspaces (id,name,slug,created_at,updated_at) VALUES (?,?,?,?,?)").run(WORKSPACE, "TAHA", "taha", now, now);
  for (const [id, provider] of [["google-1", "google"], ["facebook-1", "facebook"]]) sqlite.prepare(`INSERT INTO channel_connections
    (id,workspace_id,provider,role,display_name,status,publish_mode,created_at,updated_at) VALUES (?,?,?,?,?,'connected','api',?,?)`).run(id, WORKSPACE, provider, "both", provider, now, now);
  sqlite.prepare("UPDATE channel_connections SET config_json = ? WHERE provider = 'google'").run(JSON.stringify({ sheetId: "sheet-1", folderId: "root" }));
  function seedProduct(id = "product-1", sku = "PH0001") {
    const source = { connectionId: "google-1", sheetId: "sheet-1", sheetRange: "Products!A:Z", driveRootFolderId: "root", indexedAt: 0, skuKey: sku, sku, driveFolderId: `folder-${sku}`, driveFolderName: `SKU ${sku}`, driveFolderMatch: "sku_folder" };
    sqlite.prepare(`INSERT INTO products (id,workspace_id,source_connection_id,base_sku,name,slug,description,status,metadata_json,created_at,updated_at)
      VALUES (?,?,'google-1',?,?,?,?,'active',?,?,?)`).run(id, WORKSPACE, sku, `Giày ${sku}`, sku, `Mô tả gốc ${sku}`, JSON.stringify({ source: "google_sheets", googleSource: source }), now, now);
    sqlite.prepare(`INSERT INTO product_variants (id,workspace_id,product_id,sku,title,price_minor,inventory_quantity,status,created_at,updated_at)
      VALUES (?,?,?,?,?,490000,10,'active',?,?)`).run(`variant-${id}`, WORKSPACE, id, sku, sku, now, now);
    const mediaId = `image-${id}`;
    const metadata = { name: `${sku}-01.jpg`, googleDriveSource: { connectionId: "google-1", driveFileId: `file-${id}`, driveFolderId: `folder-${sku}`, skuKey: sku, matchKind: "sku_folder" } };
    sqlite.prepare(`INSERT INTO media_assets (id,workspace_id,source_connection_id,channel_id,media_type,origin,storage_provider,external_id,mime_type,status,metadata_json,created_at,updated_at)
      VALUES (?,?,'google-1','google_drive','image','source','google_drive',?,'image/jpeg','ready',?,?,?)`).run(mediaId, WORKSPACE, `file-${id}`, JSON.stringify(metadata), now, now);
    sqlite.prepare("INSERT INTO product_media (id,workspace_id,product_id,media_id,role,created_at) VALUES (?,?,?,?,'primary',?)").run(`pm-${id}`, WORKSPACE, id, mediaId, now);
    return { id, sku, mediaId };
  }
  overrides.set(path.join(ROOT, "lib/integrations/google-sync.ts"), { syncGoogleCatalog: async () => ({ products: 1 }) });
  const generated = [];
  overrides.set(path.join(ROOT, "lib/ai/openai.ts"), {
    async generateProductContent(input) {
      generated.push(input);
      return { model: "test-text", content: { productDescription: `Mô tả AI ${input.product.sku}`, hashtags: ["#TAHA"], channels: Object.fromEntries(input.targetProviders.map((provider) => [provider, { title: `Giày ${input.product.sku}`, body: `Bài viết ${input.product.sku}`, hashtags: ["#TAHA", `#${input.product.sku}`] }])) } };
    },
    async editProductImage() { throw new Error("Image generation must never execute"); },
  });
  return { sqlite, db, runtime, hooks, load, seedProduct, generated, overrides };
}
