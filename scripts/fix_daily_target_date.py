from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(rel, old, new):
    path = ROOT / rel
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{rel}: expected one match, got {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "lib/automation.ts",
    '''function nextLocalSlot(now: number, hour: number) {
  const offset = 7 * 60 * 60 * 1_000;
  const local = new Date(now + offset);
  let candidate = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, 0) - offset;
  if (candidate <= now + 30 * 60 * 1_000) candidate += 24 * 60 * 60 * 1_000;
  return candidate;
}''',
    '''function publicationDayFromRequestKey(requestKey: string) {
  const match = /^daily:(\\d{4})-(\\d{2})-(\\d{2}):/.exec(requestKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
  return { year, month, day };
}

function nextLocalSlot(now: number, hour: number, requestKey?: string) {
  const offset = 7 * 60 * 60 * 1_000;
  const targetDay = requestKey ? publicationDayFromRequestKey(requestKey) : null;
  if (targetDay) {
    const planned = Date.UTC(targetDay.year, targetDay.month - 1, targetDay.day, hour, 0) - offset;
    // If a daily run finishes late, publish shortly after completion rather than silently rolling
    // the content into another calendar day. Normal runs are prepared before their target day.
    return planned <= now + 5 * 60 * 1_000 ? now + 5 * 60 * 1_000 : planned;
  }
  const local = new Date(now + offset);
  let candidate = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, 0) - offset;
  if (candidate <= now + 30 * 60 * 1_000) candidate += 24 * 60 * 60 * 1_000;
  return candidate;
}''',
)

replace_once(
    "lib/automation.ts",
    '''        const runAt = nextLocalSlot(now, scheduleHour);''',
    '''        const runAt = nextLocalSlot(now, scheduleHour, current.request_key);''',
)

# Add a regression assertion to the existing TAHA end-to-end contract test.
path = ROOT / "tests/taha-e2e-fixes.test.mjs"
text = path.read_text(encoding="utf-8")
needle = '''  assert.match(cron, /runAutomationWorker\\(\\{ limit: 8 \\}\\)/);
  assert.match(publishing, /slice\\(0, 8\\)/);'''
replacement = '''  assert.match(cron, /runAutomationWorker\\(\\{ limit: 8 \\}\\)/);
  assert.match(publishing, /slice\\(0, 8\\)/);
  const automation = read("lib/automation.ts");
  assert.match(automation, /publicationDayFromRequestKey/);
  assert.match(automation, /nextLocalSlot\\(now, scheduleHour, current\\.request_key\\)/);'''
if text.count(needle) != 1:
    raise RuntimeError("tests/taha-e2e-fixes.test.mjs: target block not found")
path.write_text(text.replace(needle, replacement, 1), encoding="utf-8")

print("Daily target-date scheduling fixed")
