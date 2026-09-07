"""Read-only progress report for the exact prepare-only catalog recovery."""
# Probe generation 22: verify recovery lock released after pause.
import base64
import json
from pathlib import Path
import sqlite3
import subprocess
import sys

WORKSPACE = '00000000-0000-4000-8000-000000000001'
MARKER = Path('/var/lib/taha-ai/ops-recovery/catalog-lifestyle-v3.json')
REPLAN = Path('/var/lib/taha-ai/ops-recovery/catalog-six-image-replan-v1.json')
REPAIR = Path('/var/lib/taha-ai/ops-recovery/catalog-six-image-recovery-v1-retries.json')


def safe_marker(path, ids):
    if not path.is_file() or (path.stat().st_mode & 0o777) != 0o600: return None
    try: value = json.loads(path.read_text())
    except ValueError: return {'invalid': True}
    if value.get('runIds') != ids: return {'invalid': True}
    result = {'stage': value.get('stage'), 'updatedAt': value.get('updatedAt'), 'appliedAt': value.get('appliedAt')}
    if isinstance(value.get('states'), dict):
        result['states'] = {stage: sum(item == stage for item in value['states'].values())
                            for stage in sorted(set(value['states'].values()))}
    if isinstance(value.get('attempts'), dict): result['attempts'] = sum(value['attempts'].values())
    return result


def main():
    runtime = subprocess.run(
        ['docker', 'inspect', 'taha-ai', '--format',
         '{{.Config.Image}}|{{.Image}}|{{.State.Status}}|{{index .Config.Labels "org.opencontainers.image.revision"}}'],
        check=True, capture_output=True, text=True, timeout=30,
    ).stdout.strip()
    products = json.loads(MARKER.read_text()).get('products')
    if not isinstance(products, list) or len(products) != 15:
        raise RuntimeError('CATALOG_PROGRESS_MARKER_CHANGED')
    ids = [row.get('runId') for row in products]
    if len(set(ids)) != 15 or any(not isinstance(value, str) for value in ids):
        raise RuntimeError('CATALOG_PROGRESS_MARKER_CHANGED')
    placeholders = ','.join('?' for _ in ids)
    for database in Path('/var/lib/taha-ai').rglob('*.sqlite'):
        with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
            db.row_factory = sqlite3.Row
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {'automation_runs', 'automation_steps', 'products', 'content_drafts', 'schedules', 'publish_jobs'}.issubset(tables):
                continue
            rows = [dict(row) for row in db.execute(
                f"SELECT r.id,p.base_sku,r.status,r.error_code,r.requested_image_count,r.completed_image_count "
                f"FROM automation_runs r JOIN products p ON p.id=r.product_id AND p.workspace_id=r.workspace_id "
                f"WHERE r.workspace_id=? AND r.id IN ({placeholders}) ORDER BY p.base_sku",
                [WORKSPACE, *ids],
            )]
            if len(rows) != 15:
                continue
            drafts = db.execute(
                f"SELECT count(*) FROM content_drafts WHERE workspace_id=? AND "
                f"json_extract(generation_meta_json,'$.automationRunId') IN ({placeholders})",
                [WORKSPACE, *ids],
            ).fetchone()[0]
            creators = ['automation:' + value for value in ids]
            schedules = db.execute(
                f"SELECT count(*) FROM schedules WHERE workspace_id=? AND created_by IN ({placeholders})",
                [WORKSPACE, *creators],
            ).fetchone()[0]
            jobs = db.execute(
                f"SELECT count(*) FROM publish_jobs j JOIN schedules s ON s.id=j.schedule_id "
                f"WHERE j.workspace_id=? AND s.created_by IN ({placeholders})",
                [WORKSPACE, *creators],
            ).fetchone()[0]
            steps = [dict(row) for row in db.execute(
                f"SELECT step_type,status,count(*) AS total FROM automation_steps "
                f"WHERE workspace_id=? AND run_id IN ({placeholders}) GROUP BY step_type,status "
                f"ORDER BY step_type,status",
                [WORKSPACE, *ids],
            )]
            competitors = [dict(row) for row in db.execute(
                f"SELECT r.id,p.base_sku,r.request_key,r.status,r.target_providers_json,r.content_json "
                f"FROM automation_runs r JOIN products p ON p.id=r.product_id AND p.workspace_id=r.workspace_id "
                f"WHERE r.workspace_id=? AND r.product_id IN (SELECT product_id FROM automation_runs "
                f"WHERE workspace_id=? AND id IN ({placeholders})) AND r.id NOT IN ({placeholders}) "
                f"AND r.status IN ('queued','processing') ORDER BY r.created_at",
                [WORKSPACE, WORKSPACE, *ids, *ids],
            )]
            safe_competitors = []
            for row in competitors:
                try:
                    content = json.loads(row['content_json'] or '{}')
                    targets = json.loads(row['target_providers_json'] or '[]')
                except ValueError:
                    content, targets = {}, []
                safe_competitors.append({
                    'idB64': base64.b64encode(row['id'].encode()).decode(),
                    'sku': row['base_sku'],
                    'kind': row['request_key'].split(':', 1)[0],
                    'status': row['status'],
                    'prepareOnly': content.get('prepareOnly') is True,
                    'targets': targets,
                })
            timer = subprocess.run(
                ['systemctl', 'is-active', 'taha-ai-cron.timer'], capture_output=True, text=True, timeout=15,
            ).stdout.strip()
            print('CATALOG_PROGRESS=' + json.dumps({
                'states': [{'sku': row['base_sku'], 'status': row['status'],
                            'code': row['error_code'], 'requestedImages': row['requested_image_count'],
                            'images': row['completed_image_count']} for row in rows],
                'drafts': drafts,
                'schedules': schedules,
                'publishJobs': jobs,
                'steps': steps,
                'competitors': safe_competitors,
                'cronTimer': timer,
                'recoveryLockHeld': subprocess.run(
                    ['flock', '-n', '/var/lock/taha-ai-release.lock', 'true'], timeout=10).returncode != 0,
                'replan': safe_marker(REPLAN, ids),
                'repair': safe_marker(REPAIR, ids),
                'runtimeB64': base64.b64encode(runtime.encode()).decode(),
            }, separators=(',', ':')), flush=True)
            return
    raise RuntimeError('CATALOG_PROGRESS_DATABASE_MISSING')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('CATALOG_PROGRESS_FAILED', file=sys.stderr)
        sys.exit(1)
