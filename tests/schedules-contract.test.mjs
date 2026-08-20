import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("schedule API keeps authentication, workspace scope, and activation gates", async () => {
  const [collectionRoute, activateRoute, pauseRoute, schedules, docs] = await Promise.all([
    readFile(new URL("app/api/schedules/route.ts", root), "utf8"),
    readFile(new URL("app/api/schedules/[id]/activate/route.ts", root), "utf8"),
    readFile(new URL("app/api/schedules/[id]/pause/route.ts", root), "utf8"),
    readFile(new URL("lib/schedules.ts", root), "utf8"),
    readFile(new URL("docs/API.md", root), "utf8"),
  ]);

  for (const route of [collectionRoute, activateRoute, pauseRoute]) {
    assert.match(route, /isOperatorRequest\(request\)/);
    assert.match(route, /return fail\("UNAUTHORIZED"/);
  }

  assert.match(schedules, /TAHA_WORKSPACE_ID/);
  assert.match(schedules, /workspace_id = \?/);
  assert.match(schedules, /draft\.status !== "approved"/);
  assert.match(schedules, /media_assets\.status = 'ready'/);
  assert.match(schedules, /connection\.status !== "connected"/);
  assert.match(schedules, /TAHA_SCHEDULER_TIMEZONE/);
  assert.match(schedules, /nextScheduledOccurrence/);
  assert.match(schedules, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(schedules, /ON CONFLICT\(id\) DO NOTHING/);
  assert.match(schedules, /next_run_at = \?/);
  assert.match(schedules, /provider === "zalo_personal" \? "assisted"/);

  assert.match(docs, /POST \/api\/schedules\/:id\/activate/);
  assert.match(docs, /Asia\/Ho_Chi_Minh/);
  assert.match(docs, /idempotencyKey/);
});
