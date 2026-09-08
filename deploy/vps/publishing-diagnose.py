"""Read-only publishing state; never prints credentials or unpublished captions."""
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import time

WORKSPACE = '00000000-0000-4000-8000-000000000001'


def report(label, value):
    print(label + '=' + json.dumps(value, ensure_ascii=False, separators=(',', ':')), flush=True)


def command(*args):
    return subprocess.run(args, capture_output=True, text=True, timeout=30).stdout.strip()


def main():
    report('PUBLISH_RUNTIME', {'now': int(time.time() * 1000),
        'image': command('docker', 'inspect', 'taha-ai', '--format', '{{.Config.Image}}'),
        'timer': command('systemctl', 'is-active', 'taha-ai-cron.timer'),
        'service': command('systemctl', 'show', 'taha-ai-cron.service', '-p', 'ActiveState', '-p', 'Result', '-p', 'ExecMainStatus', '-p', 'ExecMainExitTimestamp')})
    unit = command('systemctl', 'cat', 'taha-ai-cron.service')
    scripts = re.findall(r'(/[\w/.-]+\.(?:sh|py))', unit)
    routes = re.findall(r'/api/internal/[\w/-]+', unit)
    for script in scripts:
        path = Path(script)
        if path.is_file():
            routes.extend(re.findall(r'/api/internal/[\w/-]+', path.read_text()))
    report('CRON_ROUTES', sorted(set(routes)))
    for path in Path('/var/lib/taha-ai').rglob('*.sqlite'):
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
            db.row_factory = sqlite3.Row
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {'schedules', 'publish_jobs', 'channel_connections'}.issubset(tables):
                continue
            def rows(sql):
                return [dict(r) for r in db.execute(sql, [WORKSPACE])]
            report('PUBLISH_CONNECTIONS', rows("SELECT id,provider,status,publish_mode,json_extract(config_json,'$.dailyAutomationEnabled') AS daily_enabled FROM channel_connections WHERE workspace_id=?"))
            report('PUBLISH_SCHEDULES', rows("SELECT s.id,c.provider,p.base_sku,s.status,s.run_at,s.local_time,s.next_run_at,s.last_run_at,s.timezone,s.execution_mode,d.status AS draft_status FROM schedules s JOIN channel_connections c ON c.id=s.connection_id LEFT JOIN content_drafts d ON d.id=s.draft_id LEFT JOIN products p ON p.id=d.product_id WHERE s.workspace_id=? AND c.provider IN ('facebook','zalo_personal') ORDER BY s.created_at DESC LIMIT 60"))
            report('PUBLISH_JOBS', rows("SELECT j.id,j.schedule_id,c.provider,p.base_sku,j.status,j.scheduled_for,j.attempt_count,j.error_code,j.external_post_id,j.external_url,j.completed_at,j.created_at,j.updated_at FROM publish_jobs j JOIN channel_connections c ON c.id=j.connection_id LEFT JOIN products p ON p.id=j.product_id WHERE j.workspace_id=? AND c.provider IN ('facebook','zalo_personal') ORDER BY j.created_at DESC LIMIT 60"))
            report('AUTOMATION_COUNTS', rows("SELECT status,error_code,count(*) AS total FROM automation_runs WHERE workspace_id=? GROUP BY status,error_code"))
            return
    raise RuntimeError('PUBLISH_DATABASE_MISSING')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('PUBLISH_DIAGNOSIS_FAILED', flush=True)
        raise SystemExit(1)
