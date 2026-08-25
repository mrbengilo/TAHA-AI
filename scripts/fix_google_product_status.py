from pathlib import Path

sync = Path('lib/integrations/google-sync.ts')
text = sync.read_text()
old = '''    const rawStatus = normalizeHeader(valueFor(row, headers, ["trang thai", "status"]));
    const status = rawStatus.includes("ready") || rawStatus.includes("active") || rawStatus.includes("san sang") ? "active" : rawStatus.includes("pause") || rawStatus.includes("tam dung") ? "paused" : "draft";
'''
new = '''    const status = normalizeCatalogStatus(valueFor(row, headers, ["trang thai", "status"]));
'''
if old not in text:
    raise SystemExit('status parser anchor not found')
helper_anchor = '''export function parseGoogleCatalogRows(rows: unknown[][]) {\n'''
helper = '''function normalizeCatalogStatus(value: unknown): CatalogProduct["status"] {
  const rawStatus = normalizeHeader(value).replace(/đ/g, "d");
  // The existing TAHA Sheet may not have a status column. In that case the
  // catalog row is sellable by default; explicit stop/draft values still win.
  if (!rawStatus) return "active";
  const pausedSignals = ["pause", "paused", "tam dung", "ngung ban", "inactive", "disabled", "stop", "stopped", "het hang", "sold out"];
  if (pausedSignals.some((signal) => rawStatus.includes(signal))) return "paused";
  const draftSignals = ["draft", "nhap", "chua san sang", "chua ban"];
  if (draftSignals.some((signal) => rawStatus.includes(signal))) return "draft";
  const activeSignals = ["ready", "active", "san sang", "dang ban", "con hang", "available", "published", "hoat dong", "dang kinh doanh", "on sale"];
  if (activeSignals.some((signal) => rawStatus.includes(signal))) return "active";
  return "draft";
}

export function parseGoogleCatalogRows(rows: unknown[][]) {
'''
if helper_anchor not in text:
    raise SystemExit('helper anchor not found')
text = text.replace(helper_anchor, helper, 1).replace(old, new, 1)
sync.write_text(text)

test_file = Path('tests/google-sync-pricing.test.mjs')
tests = test_file.read_text()
addition = r'''

test("defaults missing status and common selling statuses to active", async () => {
  const { parseGoogleCatalogRows } = await loadGoogleSync();
  const products = plain(parseGoogleCatalogRows([
    ["SKU", "Tên sản phẩm", "Trạng thái"],
    ["TAHA-NO-STATUS", "Không ghi trạng thái", ""],
    ["TAHA-SELLING", "Đang bán", "Đang bán"],
    ["TAHA-STOCK", "Còn hàng", "Còn hàng"],
    ["TAHA-READY", "Sẵn sàng", "Sẵn sàng"],
  ]));
  assert.deepEqual(products.map((item) => item.status), ["active", "active", "active", "active"]);
});

test("honors explicit paused and draft product statuses", async () => {
  const { parseGoogleCatalogRows } = await loadGoogleSync();
  const products = plain(parseGoogleCatalogRows([
    ["SKU", "Tên sản phẩm", "Trạng thái"],
    ["TAHA-PAUSE", "Tạm dừng", "Tạm dừng"],
    ["TAHA-STOP", "Ngừng bán", "Ngừng bán"],
    ["TAHA-SOLDOUT", "Hết hàng", "Hết hàng"],
    ["TAHA-DRAFT", "Bản nháp", "Nháp"],
    ["TAHA-NOTREADY", "Chưa sẵn sàng", "Chưa sẵn sàng"],
    ["TAHA-UNKNOWN", "Trạng thái lạ", "Chờ duyệt nội bộ"],
  ]));
  assert.deepEqual(products.map((item) => item.status), ["paused", "paused", "paused", "draft", "draft", "draft"]);
});
'''
if 'defaults missing status and common selling statuses to active' not in tests:
    tests += addition
test_file.write_text(tests)
print('Google product status parser patch applied')
