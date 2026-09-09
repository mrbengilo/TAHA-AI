import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeUrl = new URL("../app/api/internal/automation/tick/route.ts", import.meta.url);
const publishRouteUrl = new URL("../app/api/internal/publish/tick/route.ts", import.meta.url);

test("internal automation tick runs only one filtered worker step", async () => {
  const source = await readFile(routeUrl, "utf8");
  assert.match(source, /runAutomationWorker\(\{ limit: 1, runIds \}\)/);
  assert.doesNotMatch(source, /ensureDailyProductAutomation|runSchedulerTick|runPublishDispatcher/);
  assert.match(source, /INTERNAL_API_SECRET/);
  assert.match(source, /constantTimeEqual/);
  assert.match(source, /request\.arrayBuffer\(\)/);
  assert.match(source, /AUTOMATION_RUN_FILTER_INVALID/);
  assert.match(source, /cache-control/);
});

test("internal publish tick runs only one explicitly filtered delivery", async () => {
  const source = await readFile(publishRouteUrl, "utf8");
  assert.match(source, /runPublishDispatcher\(\{ limit: 1, jobIds \}\)/);
  assert.doesNotMatch(source, /runSchedulerTick|ensureDailyProductAutomation|runAutomationWorker/);
  assert.match(source, /INTERNAL_API_SECRET/);
  assert.match(source, /constantTimeEqual/);
  assert.match(source, /request\.arrayBuffer\(\)/);
  assert.match(source, /DISPATCHER_FILTER_INVALID/);
  assert.match(source, /cache-control/);
});
