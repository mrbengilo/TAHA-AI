import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { harness as sqliteHarness, ROOT, WORKSPACE } from "./sqlite-harness.mjs";

function harness() {
  const h = sqliteHarness();
  h.overrides.set(path.join(ROOT, "lib/integrations/facebook-permissions.ts"), {
    verifyFacebookConnection: async () => ({ ready: true }),
  });
  return h;
}

async function prepare() {
  const h = harness(); h.seedProduct();
  const automation = h.load("lib/automation.ts");
  const run = await automation.queueAutomationRun({ productId: "product-1", idempotencyKey: "confirmation-product-1", targetProviders: ["facebook"], imageCount: 0 });
  const content = await automation.runAutomationWorker();
  assert.equal(content.completed, 1, JSON.stringify(content));
  const optimize = await automation.runAutomationWorker();
  assert.equal(optimize.completed, 1, JSON.stringify(optimize));
  const finish = await automation.runAutomationWorker();
  assert.equal(finish.completed, 1, JSON.stringify(finish));
  const draft = h.sqlite.prepare("SELECT * FROM content_drafts").get();
  const schedule = h.sqlite.prepare("SELECT * FROM schedules").get();
  return { ...h, automation, run, draft, schedule };
}
function publishers(sent) {
  return {
    async facebook(input) { sent.push(input); return { externalId: "page_post", externalUrl: "https://www.facebook.com/page/posts/post", providerResponse: {} }; },
    async recordFacebook() { return true; }, async recordTikTokShop() { return true; },
  };
}
async function enqueue(h) { return h.load("lib/scheduler.ts").runSchedulerTick({ now: h.schedule.run_at + 1 }); }
async function dispatch(h, sent) { return h.load("lib/dispatcher.ts").runPublishDispatcher({ now: h.schedule.run_at + 1, publishers: publishers(sent) }); }

test("one confirmation, one Drive image -> caption/hashtags -> schedule -> exactly one Facebook post", async () => {
  const h = await prepare();
  assert.equal(h.run.run.requestedImageCount, 0);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM automation_steps WHERE step_type = 'image'").get().n, 0);
  assert.equal(h.generated.length, 1);
  assert.equal(h.generated[0].product.sku, "PH0001");
  assert.equal(h.draft.status, "approved");
  assert.equal(h.schedule.status, "active");
  assert.equal(h.schedule.connection_id, "facebook-1");
  const ids = h.sqlite.prepare("SELECT media_id FROM content_draft_media").all().map((r) => r.media_id);
  assert.deepEqual(ids, ["image-product-1"]);
  const replay = await h.automation.queueAutomationRun({ productId: "product-1", idempotencyKey: "confirmation-product-1", targetProviders: ["facebook"], imageCount: 0 });
  assert.equal(replay.replayed, true);
  assert.equal((await enqueue(h)).enqueued, 1);
  assert.equal((await enqueue(h)).enqueued, 0);
  const sent = [];
  assert.equal((await dispatch(h, sent)).published, 1);
  assert.equal((await dispatch(h, sent)).published, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /PH0001/);
  assert.match(sent[0].message, /#TAHA/);
  assert.deepEqual(Array.from(sent[0].mediaIds), ["image-product-1"]);
  const result = await h.automation.getAutomationRun(h.run.run.id);
  assert.equal(result.jobs[0].external_post_id, "page_post");
});

test("different SKU media and stale product descriptions fail closed", async () => {
  const h = await prepare(); h.seedProduct("product-2", "PH0002");
  const integrity = h.load("lib/product-integrity.ts");
  await assert.rejects(integrity.assertProductMedia("product-1", ["image-product-2"]), /PRODUCT_MEDIA_MISMATCH/);
  h.sqlite.prepare("UPDATE products SET description = 'Mô tả đã thay đổi' WHERE id = 'product-1'").run();
  await enqueue(h);
  const sent = []; const outcome = await dispatch(h, sent);
  assert.equal(sent.length, 0);
  assert.equal(outcome.errors[0].code, "PRODUCT_CONTENT_STALE");
});

test("an existing Facebook schedule picks up every current original and publishes its 27-photo album once", async () => {
  const h = await prepare();
  for (let i = 1; i < 27; i++) {
    const id = `extra-original-${i}`;
    h.sqlite.prepare(`INSERT INTO media_assets (id,workspace_id,source_connection_id,channel_id,media_type,origin,storage_provider,
      external_id,mime_type,status,metadata_json,created_at,updated_at)
      SELECT ?,workspace_id,source_connection_id,channel_id,media_type,origin,storage_provider,?,mime_type,status,
        json_set(metadata_json,'$.googleDriveSource.driveFileId',?),created_at,updated_at
      FROM media_assets WHERE id='image-product-1'`).run(id, id, id);
    h.sqlite.prepare("INSERT INTO product_media (id,workspace_id,product_id,media_id,role,sort_order,created_at) VALUES (?,?,'product-1',?,'source',?,1)")
      .run(`pm-${id}`, WORKSPACE, id, i);
  }
  await enqueue(h);
  const sent = [];
  assert.equal((await dispatch(h, sent)).published, 1);
  assert.equal(sent[0].mediaIds.length, 27);
  const snapshot = JSON.parse(h.sqlite.prepare("SELECT payload_snapshot_json FROM publish_jobs").get().payload_snapshot_json);
  assert.equal(snapshot.mediaIds.length, 27);
  assert.equal(snapshot.platformData.generatedImageCount, 0);
  assert.equal((await dispatch(h, sent)).published, 0);
  assert.equal(sent.length, 1);
});

test("requires a real exact SKU folder and connected Facebook destination before spending AI", async () => {
  const h = harness(); h.seedProduct(); const automation = h.load("lib/automation.ts");
  const input = { productId: "product-1", idempotencyKey: "confirm-preflight", targetProviders: ["facebook"] };
  h.sqlite.prepare("UPDATE channel_connections SET status = 'expired' WHERE provider = 'facebook'").run();
  await assert.rejects(automation.queueAutomationRun(input), /PUBLISH_CONNECTION_REQUIRED/);
  h.sqlite.prepare("UPDATE channel_connections SET status = 'connected' WHERE provider = 'facebook'").run();
  h.sqlite.prepare("UPDATE media_assets SET metadata_json = json_set(metadata_json, '$.googleDriveSource.skuKey', 'PH0002')").run();
  await assert.rejects(automation.queueAutomationRun(input), /SKU_SOURCE_IMAGES_REQUIRED/);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM automation_runs").get().n, 0);
  assert.equal(h.generated.length, 0);
});

test("missing live Facebook grants block AI preparation and media upload despite a connected flag", async () => {
  const h = harness(); h.seedProduct();
  h.overrides.set(path.join(ROOT, "lib/integrations/facebook-permissions.ts"), {
    verifyFacebookConnection: async () => ({ ready: false, code: "FACEBOOK_SCOPES_MISSING", message: "Cần cấp quyền đăng bài." }),
  });
  await assert.rejects(h.load("lib/automation.ts").queueAutomationRun({ productId: "product-1", idempotencyKey: "missing-facebook-grants", targetProviders: ["facebook"] }), (error) => error.code === "FACEBOOK_SCOPES_MISSING");
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM automation_runs").get().n, 0);
  assert.equal(h.generated.length, 0);
  let uploads = 0;
  h.runtime.TEST_FETCH = async () => { uploads += 1; throw new Error("Must not upload without permission"); };
  await assert.rejects(h.load("lib/publishing.ts").sendFacebookPost({ connectionId: "facebook-1", message: "PH0001", mediaIds: ["image-product-1"] }), (error) => error.code === "FACEBOOK_SCOPES_MISSING" && error.retryable === false);
  assert.equal(uploads, 0);
});

test("Facebook verification SQL preserves concurrent settings and never overwrites a reconnect", async () => {
  const h = sqliteHarness();
  Object.assign(h.runtime, { META_APP_ID: "app-1", META_APP_SECRET: "test-app-secret", META_GRAPH_API_VERSION: "v26.0", INTEGRATION_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url") });
  const encrypted = await h.load("lib/integrations/crypto.ts").encryptCredentials({ accessToken: "test-page-token" });
  h.sqlite.prepare("UPDATE channel_connections SET external_account_id='123', config_json=?, auth_ciphertext=?, auth_iv=? WHERE id='facebook-1'").run(JSON.stringify({ tasks: ["CREATE_CONTENT"] }), encrypted.ciphertext, encrypted.iv);
  const data = { is_valid: true, type: "PAGE", app_id: "app-1", profile_id: "123", scopes: ["pages_show_list"] };
  h.runtime.TEST_FETCH = async () => {
    h.sqlite.prepare("UPDATE channel_connections SET config_json=json_set(config_json,'$.dailyAutomationEnabled',1) WHERE id='facebook-1'").run();
    return Response.json({ data });
  };
  const verifier = h.load("lib/integrations/facebook-permissions.ts");
  const denied = await verifier.verifyFacebookConnection("facebook-1");
  assert.equal(denied.code, "FACEBOOK_SCOPES_MISSING");
  const row = h.sqlite.prepare("SELECT status,config_json,scopes_json FROM channel_connections WHERE id='facebook-1'").get();
  assert.equal(row.status, "error");
  assert.equal(JSON.parse(row.config_json).dailyAutomationEnabled, 1);
  assert.equal(JSON.parse(row.config_json).facebookPermissionVerification.ready, false);
  assert.deepEqual(JSON.parse(row.scopes_json), ["pages_show_list"]);
  h.runtime.TEST_FETCH = async () => {
    h.sqlite.prepare("UPDATE channel_connections SET auth_ciphertext='new-credential', auth_iv='new-iv', status='connected', last_error=NULL WHERE id='facebook-1'").run();
    return Response.json({ data });
  };
  const stale = await verifier.verifyFacebookConnection("facebook-1");
  assert.equal(stale.code, "FACEBOOK_CONNECTION_CHANGED");
  const changed = h.sqlite.prepare("SELECT status,auth_ciphertext,last_error FROM channel_connections WHERE id='facebook-1'").get();
  assert.equal(changed.status, "connected");
  assert.equal(changed.auth_ciphertext, "new-credential");
  assert.equal(changed.last_error, null);
});

test("concurrent confirmations never create two active runs", async () => {
  const h = harness(); h.seedProduct(); const automation = h.load("lib/automation.ts");
  const results = await Promise.allSettled(["first-confirm", "second-confirm"].map((idempotencyKey) => automation.queueAutomationRun({ productId: "product-1", targetProviders: ["facebook"], idempotencyKey })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "AUTOMATION_ALREADY_RUNNING");
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM automation_runs").get().n, 1);
});

test("admin rejection cancels a queued post and prevents scheduler recreation", async () => {
  const h = await prepare(); await enqueue(h);
  await h.load("lib/content-review.ts").reviewContentDraft(h.draft.id, { action: "reject", version: 1 }, "admin");
  const sent = []; await enqueue(h); await dispatch(h, sent);
  assert.equal(sent.length, 0);
  assert.equal(h.sqlite.prepare("SELECT status FROM publish_jobs").get().status, "cancelled");
  assert.equal(h.sqlite.prepare("SELECT status FROM schedules").get().status, "paused");
});

test("admin rejection between scheduler selection and insert creates no post", async () => {
  const h = await prepare();
  h.hooks.beforeBatch = () => h.load("lib/content-review.ts").reviewContentDraft(h.draft.id, { action: "reject", version: 1 }, "admin");
  assert.equal((await enqueue(h)).enqueued, 0);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM publish_jobs").get().n, 0);
});

test("admin editing between scheduler select and insert preserves schedule and sends updated content", async () => {
  const h = await prepare();
  h.hooks.beforeBatch = () => h.load("lib/content-review.ts").reviewContentDraft(h.draft.id, { action: "edit", version: 1, title: "Tiêu đề mới", body: "Nội dung mới PH0001", hashtags: ["#PH0001"] }, "admin");
  assert.equal((await enqueue(h)).enqueued, 0);
  assert.equal(h.sqlite.prepare("SELECT status FROM schedules").get().status, "active");
  assert.equal((await enqueue(h)).enqueued, 1);
  const sent = []; await dispatch(h, sent);
  assert.match(sent[0].message, /Nội dung mới PH0001/);
});

test("admin edit before worker lease invalidates stale candidate; next tick publishes updated text", async () => {
  const h = await prepare(); await enqueue(h);
  h.hooks.beforeFirst = async (sql) => {
    if (!sql.includes("SET status = 'publishing'")) return;
    h.hooks.beforeFirst = null;
    await h.load("lib/content-review.ts").reviewContentDraft(h.draft.id, { action: "edit", version: 1, title: "Mới", body: "Bài đã sửa PH0001", hashtags: ["#PH0001"] }, "admin");
  };
  const sent = [];
  assert.equal((await dispatch(h, sent)).published, 0);
  assert.equal((await dispatch(h, sent)).published, 1);
  assert.equal(sent.length, 1); assert.match(sent[0].message, /Bài đã sửa PH0001/);
});

test("admin cannot report a successful block once Facebook send has begun; viewers cannot edit", async () => {
  const h = await prepare(); await enqueue(h);
  h.sqlite.prepare("UPDATE publish_jobs SET status = 'publishing'").run();
  await assert.rejects(h.load("lib/content-review.ts").reviewContentDraft(h.draft.id, { action: "reject", version: 1 }, "admin"), /CONTENT_REVIEW_CONFLICT/);
  assert.equal(h.sqlite.prepare("SELECT status FROM content_drafts").get().status, "approved");
  const route = h.load("app/api/content-drafts/[id]/route.ts");
  const response = await route.PATCH(new Request("https://tahashoes.store/api/content-drafts/x", { method: "PATCH", body: JSON.stringify({ action: "reject", version: 1 }) }), { params: Promise.resolve({ id: h.draft.id }) });
  assert.equal(response.status, 401);
});

test("folder returns only this SKU's photos and articles with receipt", async () => {
  const h = await prepare(); h.seedProduct("product-2", "PH0002");
  const folder = await h.load("lib/product-folder.ts").getProductFolder("product-1");
  assert.equal(folder.product.base_sku, "PH0001");
  assert.deepEqual(Array.from(folder.images, (i) => i.id), ["image-product-1"]);
  assert.equal(folder.drafts.length, 1); assert.equal(folder.schedules.length, 1);
  assert.match(folder.drafts[0].productDescription, /PH0001/);
  assert.equal(h.sqlite.prepare("SELECT workspace_id FROM products LIMIT 1").get().workspace_id, WORKSPACE);
});

test("refreshes Sheets and reconciles every original image without an import cap", async () => {
  const h = harness(); h.seedProduct(); h.seedProduct("product-2", "PH0002");
  h.sqlite.prepare("UPDATE products SET metadata_json = json_set(metadata_json, '$.googleSource.sheetId', 'old-sheet', '$.googleSource.sheetRange', 'Old!A:Z') WHERE id = 'product-2'").run();
  h.overrides.delete(path.join(ROOT, "lib/integrations/google-sync.ts"));
  h.overrides.set(path.join(ROOT, "lib/integrations/connection-secrets.ts"), {
    getConnectedIntegration: async () => ({ id: "google-1", config: { sheetId: "sheet-1", folderId: "root" } }),
    getGoogleAccessToken: async () => "test-token",
  });
  h.sqlite.prepare("UPDATE media_assets SET external_id = 'file-24', metadata_json = json_set(metadata_json, '$.googleDriveSource.driveFileId', 'file-24') WHERE id = 'image-product-1'").run();
  h.runtime.TEST_FETCH = async (input) => {
    const url = new URL(input);
    if (url.hostname === "sheets.googleapis.com") return Response.json({ values: [["SKU", "Tên sản phẩm", "Mô tả", "Giá"], ["PH0001", "Giày mới", "Mô tả mới", "490000"]] });
    if (url.searchParams.get("q").includes("'root'")) return Response.json({ files: [{ id: "folder-PH0001", name: "SKU PH0001", mimeType: "application/vnd.google-apps.folder" }] });
    return Response.json({ files: Array.from({ length: 25 }, (_, i) => ({ id: `file-${i}`, name: `${String(i).padStart(2, "0")}.jpg`, mimeType: "image/jpeg", parents: ["folder-PH0001"] })) });
  };
  const sync = h.load("lib/integrations/google-sync.ts");
  await sync.syncGoogleCatalog("google-1");
  assert.equal(h.sqlite.prepare("SELECT description FROM products WHERE id = 'product-1'").get().description, "Mô tả mới");
  assert.equal(h.sqlite.prepare("SELECT status FROM products WHERE id = 'product-2'").get().status, "paused");
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM product_media WHERE product_id = 'product-1'").get().n, 25);
  h.sqlite.prepare("UPDATE media_assets SET external_id = 'removed-file' WHERE id = 'image-product-1'").run();
  await sync.syncGoogleCatalog("google-1");
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM product_media WHERE media_id = 'image-product-1'").get().n, 0);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM product_media WHERE product_id = 'product-1'").get().n, 25);
});

test("a Drive image moved to another SKU folder is rejected before downloading or posting", async () => {
  const h = harness(); h.seedProduct();
  h.overrides.set(path.join(ROOT, "lib/integrations/connection-secrets.ts"), {
    getConnectedIntegration: async () => ({ id: "google-1" }), getGoogleAccessToken: async () => "test-token",
  });
  const urls = [];
  h.runtime.TEST_FETCH = async (url) => { urls.push(String(url)); return Response.json({ id: "file-product-1", parents: ["folder-PH0002"], mimeType: "image/jpeg" }); };
  await assert.rejects(h.load("lib/media.ts").loadMedia("image-product-1"), /PRODUCT_MEDIA_MISMATCH/);
  assert.equal(urls.length, 1);
  assert.ok(!urls[0].includes("alt=media"));
});

test("rollout migration cancels old image work and pauses its posts while retaining originals", async () => {
  const h = await prepare(); await enqueue(h);
  h.sqlite.prepare("UPDATE automation_runs SET requested_image_count = 6, status = 'queued'").run();
  h.sqlite.prepare("UPDATE schedules SET status = 'active'").run();
  h.sqlite.prepare("UPDATE media_assets SET origin = 'generated'").run();
  h.sqlite.exec(readFileSync(path.join(ROOT, "drizzle/0004_drive_only_automation.sql"), "utf8"));
  assert.equal(h.sqlite.prepare("SELECT status FROM automation_runs").get().status, "cancelled");
  assert.equal(h.sqlite.prepare("SELECT status FROM publish_jobs").get().status, "cancelled");
  assert.equal(h.sqlite.prepare("SELECT status FROM schedules").get().status, "paused");
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM media_assets").get().n, 1);
});

test("transient Google source failure retries then publishes exactly once", async () => {
  const h = await prepare(); await enqueue(h);
  let requests = 0;
  h.overrides.get(path.join(ROOT, "lib/integrations/google-sync.ts")).syncGoogleCatalog = async () => {
    if (++requests === 1) throw new Error("GOOGLE_DRIVE_TEMPORARY_FAILURE");
  };
  const sent = [];
  assert.equal((await dispatch(h, sent)).retrying, 1);
  const waiting = h.sqlite.prepare("SELECT available_at FROM publish_jobs").get();
  const result = await h.load("lib/dispatcher.ts").runPublishDispatcher({ now: waiting.available_at + 1, publishers: publishers(sent) });
  assert.equal(result.published, 1); assert.equal(sent.length, 1);
});

test("Facebook receipt survives lease recovery immediately after remote acceptance", async () => {
  const h = await prepare(); await enqueue(h);
  const dispatcher = h.load("lib/dispatcher.ts");
  let posts = 0;
  const configured = publishers([]);
  configured.facebook = async () => {
    posts++;
    h.sqlite.prepare("UPDATE publish_jobs SET lease_expires_at = 1").run();
    await dispatcher.runPublishDispatcher({ now: h.schedule.run_at + 2, publishers: publishers([]) });
    return { externalId: "accepted-once", externalUrl: "https://www.facebook.com/accepted-once", providerResponse: {} };
  };
  const result = await dispatcher.runPublishDispatcher({ now: h.schedule.run_at + 1, publishers: configured });
  assert.equal(result.published, 1, JSON.stringify(result));
  const saved = h.sqlite.prepare("SELECT status, external_post_id FROM publish_jobs").get();
  assert.equal(saved.status, "published"); assert.equal(saved.external_post_id, "accepted-once"); assert.equal(posts, 1);
});

test("Facebook never submits feed after losing lease or receiving no photo ID", async () => {
  for (const failure of ["lease", "photo-id"]) {
    const h = await prepare(); await enqueue(h);
    h.runtime.META_GRAPH_API_VERSION = "v-test";
    h.overrides.set(path.join(ROOT, "lib/integrations/connection-secrets.ts"), {
      getConnectedIntegration: async () => ({ externalAccountId: "page-1", credentials: { accessToken: "test-token" } }),
    });
    h.overrides.set(path.join(ROOT, "lib/media.ts"), { sourcePhotoBlob: async () => ({ blob: new Blob(["test"], { type: "image/jpeg" }), filename: "PH0001.jpg" }) });
    const requests = [];
    h.runtime.TEST_FETCH = async (url, init) => {
      requests.push(String(url)); assert.ok(init.signal);
      if (failure === "lease") h.sqlite.prepare("UPDATE publish_jobs SET status = 'blocked', error_code = 'DELIVERY_OUTCOME_UNKNOWN', lease_expires_at = NULL").run();
      return Response.json(failure === "lease" ? { id: "photo-1" } : {});
    };
    const result = await h.load("lib/dispatcher.ts").runPublishDispatcher({ now: h.schedule.run_at + 1 });
    assert.equal(result.published, 0);
    assert.equal(requests.length, 1); assert.ok(requests[0].endsWith("/photos"));
  }
});

test("retry sync can repair locally invalid source metadata without a separate manual sync", async () => {
  const h = harness(); h.seedProduct(); const automation = h.load("lib/automation.ts");
  await automation.queueAutomationRun({ productId: "product-1", targetProviders: ["facebook"], idempotencyKey: "source-repair-test" });
  h.sqlite.prepare("UPDATE products SET status = 'paused'").run();
  h.overrides.get(path.join(ROOT, "lib/integrations/google-sync.ts")).syncGoogleCatalog = async () => h.sqlite.prepare("UPDATE products SET status = 'active'").run();
  assert.equal((await automation.runAutomationWorker()).completed, 1);
});

test("idempotency cannot replay a confirmation for a different Facebook page", async () => {
  const h = harness(); h.seedProduct();
  h.sqlite.prepare(`INSERT INTO channel_connections (id,workspace_id,provider,role,display_name,status,publish_mode,created_at,updated_at)
    VALUES ('facebook-2',?,'facebook','both','Second Page','connected','api',1,1)`).run(WORKSPACE);
  const automation = h.load("lib/automation.ts");
  const results = await Promise.allSettled(["facebook-1", "facebook-2"].map((id) => automation.queueAutomationRun({
    productId: "product-1", targetProviders: ["facebook"], connectionIds: { facebook: id }, idempotencyKey: "same-key-two-pages",
  })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "IDEMPOTENCY_KEY_REUSED");
});

test("a concurrent source configuration change aborts sync and cannot pause or publish the new catalog", async () => {
  for (const boundary of ["acquire", "commit", "same-config-overwrite"]) {
    const h = harness(); h.seedProduct(); h.seedProduct("product-2", "PH0002");
    h.overrides.delete(path.join(ROOT, "lib/integrations/google-sync.ts"));
    h.overrides.set(path.join(ROOT, "lib/integrations/connection-secrets.ts"), {
      getConnectedIntegration: async () => ({ id: "google-1", config: { sheetId: "sheet-1", folderId: "root" } }), getGoogleAccessToken: async () => "test-token",
    });
    const change = () => boundary === "same-config-overwrite"
      ? h.sqlite.prepare("UPDATE channel_connections SET config_json = ? WHERE id = 'google-1'").run(JSON.stringify({ sheetId: "sheet-1", folderId: "root" }))
      : h.sqlite.prepare("UPDATE channel_connections SET config_json = json_set(config_json, '$.sheetId', 'new-sheet') WHERE id = 'google-1'").run();
    if (boundary === "acquire") h.hooks.beforeFirst = (sql) => {
      if (sql.includes("COALESCE(json_extract(config_json, '$._catalogSyncExpiresAt')")) { h.hooks.beforeFirst = null; change(); }
    };
    else h.hooks.beforeBatch = change;
    h.runtime.TEST_FETCH = async (input) => {
      const url = new URL(input);
      if (url.hostname === "sheets.googleapis.com") return Response.json({ values: [["SKU", "Tên sản phẩm"], ["PH0001", "Giày"]] });
      if (url.searchParams.get("q").includes("'root'")) return Response.json({ files: [{ id: "folder-PH0001", name: "SKU PH0001", mimeType: "application/vnd.google-apps.folder" }] });
      return Response.json({ files: [{ id: "file-product-1", name: "01.jpg", mimeType: "image/jpeg", parents: ["folder-PH0001"] }] });
    };
    await assert.rejects(h.load("lib/integrations/google-sync.ts").syncGoogleCatalog("google-1"), /GOOGLE_SYNC_IN_PROGRESS/);
    assert.equal(h.sqlite.prepare("SELECT status FROM products WHERE id = 'product-2'").get().status, "active");
    assert.equal(h.sqlite.prepare("SELECT last_synced_at FROM channel_connections WHERE id = 'google-1'").get().last_synced_at, null);
    await assert.rejects(h.load("lib/product-integrity.ts").productSources("product-1"), /PRODUCT_SOURCE_CHANGED/);
  }
});
