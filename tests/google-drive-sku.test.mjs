import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadGoogleDrive({ fetchImpl = fetch, database } = {}) {
  const source = await readFile(new URL("../lib/integrations/google-drive.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const commonJsModule = { exports: {} };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    console,
    crypto: globalThis.crypto,
    fetch: fetchImpl,
    URL,
    Blob,
    Response,
    Headers,
    AbortSignal,
    require(specifier) {
      if (specifier === "./env") return { getRuntimeEnv: () => ({ DB: database }) };
      if (specifier === "./store") return { TAHA_WORKSPACE_ID: "workspace-test" };
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  new vm.Script(compiled, { filename: "google-drive.cjs" }).runInContext(context);
  return commonJsModule.exports;
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

test("normalizes SKU typography without collapsing distinct SKU punctuation", async () => {
  const { normalizeSkuKey } = await loadGoogleDrive();
  assert.equal(normalizeSkuKey("  taha‑001   black "), "TAHA-001 BLACK");
  assert.equal(normalizeSkuKey("TAHA_001"), "TAHA_001");
  assert.notEqual(normalizeSkuKey("TAHA_001"), normalizeSkuKey("TAHA-001"));
});

test("matches filename SKU on token boundaries and prefers the longest SKU", async () => {
  const { matchSkuFromFilename } = await loadGoogleDrive();
  const skus = ["TAHA-001", "TAHA-001-BLACK"];
  assert.equal(matchSkuFromFilename("TAHA-001_front.jpg", skus), "TAHA-001");
  assert.equal(matchSkuFromFilename("campaign-TAHA-001-BLACK-main.png", skus), "TAHA-001-BLACK");
  assert.equal(matchSkuFromFilename("TAHA-0010.jpg", skus), null);
});

test("indexes exact SKU folders plus root filenames and skips prior generated exports", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    const query = url.searchParams.get("q") ?? "";
    if (query.includes("'root' in parents")) {
      return jsonResponse({
        files: [
          { id: "folder-a", name: "taha-001", mimeType: "application/vnd.google-apps.folder" },
          { id: "root-a", name: "TAHA-001_side.jpg", mimeType: "image/jpeg", parents: ["root"] },
          { id: "root-black", name: "TAHA-001-BLACK_main.png", mimeType: "image/png", parents: ["root"] },
          { id: "wrong-boundary", name: "TAHA-0010.jpg", mimeType: "image/jpeg", parents: ["root"] },
          { id: "generated", name: "TAHA-001-AI.png", mimeType: "image/png", appProperties: { tahaMediaId: "media-1" } },
        ],
      });
    }
    if (query.includes("'folder-a' in parents")) {
      return jsonResponse({ files: [{ id: "folder-image", name: "front.jpg", mimeType: "image/jpeg", parents: ["folder-a"] }] });
    }
    throw new Error(`Unexpected Drive query: ${query}`);
  };
  const { indexGoogleDriveAssets } = await loadGoogleDrive({ fetchImpl });
  const index = await indexGoogleDriveAssets("root", ["TAHA-001", "TAHA-001-BLACK"], "token");
  const beige = index.bySku.get("TAHA-001");
  const black = index.bySku.get("TAHA-001-BLACK");

  assert.equal(beige.targetFolderId, "folder-a");
  assert.equal(beige.targetKind, "sku_folder");
  assert.equal(beige.files[0].id, "folder-image");
  assert.deepEqual([...beige.files].map((file) => file.id).sort(), ["folder-image", "root-a"]);
  assert.equal(black.targetFolderId, "root");
  assert.deepEqual(JSON.parse(JSON.stringify(black.files.map((file) => file.id))), ["root-black"]);
  assert.equal(index.matchedRootFiles, 2);
  assert.equal(index.unmatchedRootImages, 1);
});

test("refuses duplicate normalized SKU folders instead of attaching an arbitrary folder", async () => {
  const fetchImpl = async () => jsonResponse({
    files: [
      { id: "folder-a", name: "TAHA-001", mimeType: "application/vnd.google-apps.folder" },
      { id: "folder-b", name: "taha‑001", mimeType: "application/vnd.google-apps.folder" },
    ],
  });
  const { indexGoogleDriveAssets } = await loadGoogleDrive({ fetchImpl });
  await assert.rejects(
    indexGoogleDriveAssets("root", ["TAHA-001"], "token"),
    (error) => error.code === "GOOGLE_DUPLICATE_SKU_FOLDERS" && error.status === 409,
  );
});

test("uses multipart upload for small images and targets the selected SKU folder", async () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    return jsonResponse({ id: "drive-file", name: "TAHA-001-AI.png", mimeType: "image/png", parents: ["folder-a"] });
  };
  const { uploadGoogleDriveImage } = await loadGoogleDrive({ fetchImpl });
  const file = await uploadGoogleDriveImage({
    token: "secret-token",
    folderId: "folder-a",
    filename: "TAHA-001-AI.png",
    mimeType: "image/png",
    blob: new Blob(["image-bytes"], { type: "image/png" }),
    appProperties: { tahaMediaId: "media-1" },
  });

  assert.equal(file.id, "drive-file");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.searchParams.get("uploadType"), "multipart");
  assert.equal(calls[0].init.method, "POST");
  assert.match(calls[0].init.headers["content-type"], /^multipart\/related; boundary=taha_/);
  const payload = await calls[0].init.body.text();
  assert.match(payload, /"parents":\["folder-a"\]/);
  assert.match(payload, /"tahaMediaId":"media-1"/);
});

test("missing drive.file scope expires the connection and returns a reauth state", async () => {
  const updates = [];
  const database = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              return { scopes_json: JSON.stringify(["https://www.googleapis.com/auth/drive.readonly"]) };
            },
            async run() {
              updates.push({ sql, values });
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const { requireGoogleDriveWriteScope } = await loadGoogleDrive({ database });
  await assert.rejects(
    requireGoogleDriveWriteScope("connection-1"),
    (error) => error.code === "GOOGLE_WRITE_SCOPE_REQUIRED" && error.details.requiredScope.endsWith("/drive.file"),
  );
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /status = 'expired'/);
  assert.equal(updates[0].values[0], "GOOGLE_WRITE_SCOPE_REQUIRED");
});

test("Google Drive import route is authenticated and delegates to the high-level idempotent export", async () => {
  const route = await readFile(new URL("../app/api/integrations/google/drive/import/route.ts", import.meta.url), "utf8");
  const sync = await readFile(new URL("../lib/integrations/google-sync.ts", import.meta.url), "utf8");
  assert.match(route, /isOperatorRequest\(request\)/);
  assert.match(route, /application\/json/);
  assert.match(route, /exportGeneratedImageToGoogleDrive\(input, actorId\)/);
  assert.match(sync, /appProperties:[\s\S]*tahaMediaId: mediaId/);
  assert.match(sync, /googleDriveExports/);
  assert.match(sync, /media\.origin IN \('generated', 'derived'\)/);
});

test("catalog sync never detaches valid Drive media merely because a SKU exceeds the local image cap", async () => {
  const input = await readFile(new URL("../lib/integrations/google-sync.ts", import.meta.url), "utf8");
  assert.match(input, /files\.length <= MAX_PRODUCT_SOURCE_IMAGES\s*\?\s*\(linkedAssets\.results/);
});
