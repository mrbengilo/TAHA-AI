import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { ROOT } from "./sqlite-harness.mjs";

test("admin date and time fields open their picker from the whole input", () => {
  const panel = readFileSync(path.join(ROOT, "app/automation/FacebookSchedulingPanel.tsx"), "utf8");
  assert.match(panel, /event\.currentTarget\.showPicker\?\.\(\)/);
  assert.equal((panel.match(/onClick=\{openNativePicker\}/g) ?? []).length, 4);
});

test("calendar groups every concrete product by date and channel", () => {
  const page = readFileSync(path.join(ROOT, "app/calendar/page.tsx"), "utf8");
  assert.match(page, /Lịch đăng chi tiết theo ngày/);
  assert.match(page, /\{day\.entries\.length\} bài/);
  assert.match(page, /\{entries\.length\} bài/);
  assert.match(page, /productLabel\(entry\)/);
});

test("activity has five channel tabs and uses the complete history source", () => {
  const page = readFileSync(path.join(ROOT, "app/activity/page.tsx"), "utf8");
  assert.match(page, /PUBLISHING_PROVIDERS\.map/);
  assert.match(page, /activity\?channel=/);
  assert.match(page, /day\.entries\.length\} bài/);
  const source = readFileSync(path.join(ROOT, "lib/publishing-history.ts"), "utf8");
  assert.doesNotMatch(source, /ORDER BY COALESCE\(j\.completed_at, j\.scheduled_for, j\.updated_at\)[\s\S]*LIMIT 5/);
});
