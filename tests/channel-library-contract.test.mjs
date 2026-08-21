import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("channel APIs are authenticated, workspace-scoped, and keep blobs private in R2", async () => {
  const [collectionRoute, detailRoute, draftRoute, uploadRoute, importRoute, library, schema, migration] = await Promise.all([
    readFile(new URL("app/api/channels/route.ts", root), "utf8"),
    readFile(new URL("app/api/channels/[channel]/route.ts", root), "utf8"),
    readFile(new URL("app/api/channels/[channel]/drafts/route.ts", root), "utf8"),
    readFile(new URL("app/api/channels/[channel]/upload/route.ts", root), "utf8"),
    readFile(new URL("app/api/channels/[channel]/media/import/route.ts", root), "utf8"),
    readFile(new URL("lib/channel-library.ts", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("drizzle/0002_same_domino.sql", root), "utf8"),
  ]);

  for (const route of [collectionRoute, detailRoute]) {
    assert.match(route, /isViewerRequest\(request\)/);
    assert.match(route, /return fail\("UNAUTHORIZED"/);
  }

  for (const route of [draftRoute, uploadRoute, importRoute]) {
    assert.match(route, /isOperatorRequest\(request\)/);
    assert.match(route, /return fail\("UNAUTHORIZED"/);
  }

  assert.match(library, /TAHA_WORKSPACE_ID/);
  assert.match(library, /workspace_id = \?/);
  assert.match(library, /channel_id = \?/);
  assert.match(library, /bucket\.put\(storageKey/);
  assert.match(library, /bucket\.delete\(storageKey\)/);
  assert.match(library, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(library, /FILE_SIGNATURE_MISMATCH/);
  assert.match(library, /ON CONFLICT\(workspace_id, channel_id, media_id\) DO NOTHING/);
  assert.match(library, /COUNT\(DISTINCT media_id\)/);
  assert.match(library, /payload: sanitizeJobPayload/);
  assert.match(library, /const status = primary\?\.status \?\? "not_connected"/);
  assert.doesNotMatch(library, /auth_ciphertext|accessToken|refreshToken/);
  assert.match(schema, /channelId: text\("channel_id"/);
  assert.match(schema, /channelMediaLinks = sqliteTable\("channel_media_links"/);
  assert.match(migration, /ALTER TABLE `media_assets` ADD `channel_id` text/);
  assert.match(migration, /idx_media_assets_workspace_channel_created/);
  assert.match(migration, /CREATE TABLE `channel_media_links`/);
  assert.match(migration, /INSERT OR IGNORE INTO `channel_media_links`/);
  assert.match(migration, /JOIN `content_drafts`/);
});
