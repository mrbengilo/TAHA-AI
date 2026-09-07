import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./sqlite-harness.mjs";

test("catalog preparation uses bounded keyset pages and stable prepare-only replays", async () => {
  const h = harness();
  h.seedProduct("product-a", "PH0001");
  h.seedProduct("product-b", "PH0002");
  h.seedProduct("product-c", "PH0003");
  h.sqlite.prepare("UPDATE channel_connections SET status='expired' WHERE provider='facebook'").run();
  const catalog = h.load("lib/catalog-preparation.ts");

  const first = await catalog.prepareCatalogPage({ limit: 2 });
  assert.deepEqual(Array.from(first.results, (item) => item.productId), ["product-a", "product-b"]);
  assert.equal(first.nextCursor, "product-b");
  assert.ok(first.results.every((item) => item.replayed === false && item.runId));
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM automation_runs").get().n, 2);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM schedules").get().n, 0);
  assert.ok(h.sqlite.prepare("SELECT content_json FROM automation_runs").all()
    .every((row) => JSON.parse(row.content_json).prepareOnly === true));

  const replay = await catalog.prepareCatalogPage({ limit: 2 });
  assert.deepEqual(Array.from(replay.results, (item) => item.runId), Array.from(first.results, (item) => item.runId));
  assert.ok(replay.results.every((item) => item.replayed === true));
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM automation_runs").get().n, 2);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM schedules").get().n, 0);

  const second = await catalog.prepareCatalogPage({ cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(Array.from(second.results, (item) => item.productId), ["product-c"]);
  assert.equal(second.nextCursor, null);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM automation_runs").get().n, 3);
  await assert.rejects(catalog.prepareCatalogPage({ limit: 11 }), (error) => error.code === "INVALID_CATALOG_PAGE");
});

test("one invalid SKU is isolated and cannot associate another SKU's preparation run", async () => {
  const h = harness();
  h.seedProduct("product-a", "PH0001");
  h.seedProduct("product-b", "PH0002");
  h.seedProduct("product-c", "PH0003");
  h.sqlite.prepare("UPDATE media_assets SET metadata_json=json_set(metadata_json,'$.googleDriveSource.skuKey','PH-WRONG') WHERE id='image-product-b'").run();
  const result = await h.load("lib/catalog-preparation.ts").prepareCatalogPage({ limit: 3 });
  assert.equal(result.results[1].productId, "product-b");
  assert.equal(result.results[1].errorCode, "SKU_SOURCE_IMAGES_REQUIRED");
  assert.deepEqual(h.sqlite.prepare("SELECT product_id FROM automation_runs ORDER BY product_id").all().map((row) => row.product_id), ["product-a", "product-c"]);
  for (const row of h.sqlite.prepare("SELECT product_id,request_key,content_json FROM automation_runs").all()) {
    assert.match(row.request_key, new RegExp(`:${row.product_id}:`));
    assert.equal(JSON.parse(row.content_json).prepareOnly, true);
  }
});
