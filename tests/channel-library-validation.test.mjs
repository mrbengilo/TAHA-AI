import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadChannelLibrary() {
  const source = await readFile(new URL("../lib/channel-library.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const commonJsModule = { exports: {} };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    console,
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    URL,
    require(specifier) {
      if (specifier === "./integrations/env") return { getRuntimeEnv: () => ({}) };
      if (specifier === "./integrations/store") {
        return {
          ensureWorkspace: async () => undefined,
          TAHA_WORKSPACE_ID: "workspace-test",
        };
      }
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  new vm.Script(compiled, { filename: "channel-library.cjs" }).runInContext(context);
  return commonJsModule.exports;
}

test("channel IDs are explicit and Google Drive/Sheets remain separate libraries", async () => {
  const library = await loadChannelLibrary();
  assert.deepEqual(Array.from(library.channelIds), [
    "google_drive",
    "google_sheets",
    "facebook",
    "zalo_personal",
    "tiktok_shop",
    "shopee",
    "website",
  ]);
  assert.equal(library.channelDefinitions.google_drive.connectionProvider, "google");
  assert.equal(library.channelDefinitions.google_sheets.connectionProvider, "google");
  assert.notEqual(library.channelDefinitions.google_drive.id, library.channelDefinitions.google_sheets.id);
  assert.equal(library.requireChannelId("facebook"), "facebook");
  assert.throws(() => library.requireChannelId("facebook_private"), (error) => error.code === "CHANNEL_NOT_FOUND" && error.status === 404);
});

test("draft validation applies per-channel content types and bounded text", async () => {
  const library = await loadChannelLibrary();
  const facebook = library.validateDraftInput("facebook", {
    productId: "product-1",
    body: "Bài Facebook",
    hashtags: ["#TAHA", "SanPham"],
  });
  assert.equal(facebook.contentType, "social_post");
  assert.deepEqual(Array.from(facebook.hashtags), ["TAHA", "SanPham"]);

  const tiktok = library.validateDraftInput("tiktok_shop", {
    productId: "product-1",
    title: "Video mới",
  });
  assert.equal(tiktok.contentType, "short_video_caption");

  assert.throws(
    () => library.validateDraftInput("facebook", { productId: "product-1", body: "Bài", contentType: "product_listing" }),
    (error) => error.code === "CONTENT_TYPE_NOT_ALLOWED",
  );
  assert.throws(
    () => library.validateDraftInput("website", { productId: "", body: "Bài" }),
    (error) => error.code === "PRODUCT_REQUIRED",
  );
  assert.throws(
    () => library.validateDraftInput("website", { productId: "product-1", body: "" }),
    (error) => error.code === "CONTENT_REQUIRED",
  );
});

test("list limits and upload signatures are validated", async () => {
  const library = await loadChannelLibrary();
  assert.equal(library.normalizeListLimit(null), 50);
  assert.equal(library.normalizeListLimit("250"), 100);
  assert.throws(() => library.normalizeListLimit("0"), (error) => error.code === "INVALID_LIMIT");

  assert.equal(library.matchesFileSignature("image/jpeg", Uint8Array.from([0xff, 0xd8, 0xff, 0x00])), true);
  assert.equal(library.matchesFileSignature("image/png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
  assert.equal(library.matchesFileSignature("image/jpeg", Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), false);
  assert.equal(library.matchesFileSignature("video/webm", Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])), true);
});

test("media import accepts bounded source reuse targets only", async () => {
  const library = await loadChannelLibrary();
  const input = library.validateMediaImportInput("facebook", { mediaIds: ["drive-1", "drive-1", "drive-2"] });
  assert.equal(input.channelId, "facebook");
  assert.deepEqual(Array.from(input.mediaIds), ["drive-1", "drive-2"]);
  assert.throws(
    () => library.validateMediaImportInput("google_drive", { mediaIds: ["drive-1"] }),
    (error) => error.code === "CHANNEL_IMPORT_NOT_ALLOWED" && error.status === 409,
  );
  assert.throws(
    () => library.validateMediaImportInput("website", { mediaIds: [] }),
    (error) => error.code === "INVALID_MEDIA_IDS" && error.status === 422,
  );
  assert.throws(
    () => library.validateMediaImportInput("website", { mediaIds: Array.from({ length: 21 }, (_, index) => `media-${index}`) }),
    (error) => error.code === "INVALID_MEDIA_IDS",
  );
});

test("job payload exposes only a bounded message and media IDs", async () => {
  const library = await loadChannelLibrary();
  const payload = library.sanitizeJobPayload(JSON.stringify({
    message: "Caption Zalo",
    mediaIds: ["media-1", "media-1", "media-2", 123],
    accessToken: "must-not-leak",
    arbitrary: { private: true },
  }));
  assert.equal(payload.message, "Caption Zalo");
  assert.deepEqual(Array.from(payload.mediaIds), ["media-1", "media-2"]);
  assert.equal("accessToken" in payload, false);
  assert.equal(library.sanitizeJobPayload("{}"), null);
});
