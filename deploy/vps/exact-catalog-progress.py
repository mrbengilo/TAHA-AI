"""Read-only progress for the exact SKU/size catalog accelerator. Probe 41."""
import json
from pathlib import Path
import sqlite3
import subprocess
import sys

WORKSPACE = '00000000-0000-4000-8000-000000000001'
REVISION = '4ef44959e6ffd29d966136922e3857c6a2119b86'
RECEIPT = Path('/var/lib/taha-ai/ops-recovery/catalog-exact-sku-size-v1.json')


def main():
    runtime = subprocess.run(
        ['docker', 'inspect', 'taha-ai', '--format',
         '{{.Config.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.State.Status}}'],
        check=True, capture_output=True, text=True, timeout=30,
    ).stdout.strip()
    if runtime != 'tahashoes-taha-ai:' + REVISION + '|' + REVISION + '|running':
        raise RuntimeError('EXACT_PROGRESS_REVISION_MISMATCH')
    receipt = json.loads(RECEIPT.read_text())
    products = receipt.get('products')
    if not isinstance(products, list) or len(products) != 15:
        raise RuntimeError('EXACT_PROGRESS_RECEIPT_INVALID')
    expected = {row.get('runId'): row for row in products if isinstance(row, dict)}
    if len(expected) != 15 or any(not isinstance(run_id, str) for run_id in expected):
        raise RuntimeError('EXACT_PROGRESS_RECEIPT_INVALID')
    ids = list(expected)
    placeholders = ','.join('?' for _ in ids)
    for path in Path('/var/lib/taha-ai').rglob('*.sqlite'):
        if 'ops-recovery' in path.parts:
            continue
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
            db.row_factory = sqlite3.Row
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {'automation_runs', 'automation_steps', 'products', 'content_drafts',
                    'content_draft_media', 'schedules', 'publish_jobs'}.issubset(tables):
                continue
            rows = [dict(row) for row in db.execute(
                f"SELECT r.id,p.base_sku,r.status,r.error_code,r.requested_image_count,r.completed_image_count "
                f"FROM automation_runs r JOIN products p ON p.id=r.product_id AND p.workspace_id=r.workspace_id "
                f"WHERE r.workspace_id=? AND r.id IN ({placeholders}) ORDER BY p.base_sku",
                [WORKSPACE, *ids],
            )]
            if len(rows) != 15:
                continue
            steps = [dict(row) for row in db.execute(
                f"SELECT step_type,status,error_code,count(*) AS total FROM automation_steps WHERE workspace_id=? "
                f"AND run_id IN ({placeholders}) GROUP BY step_type,status,error_code ORDER BY step_type,status,error_code",
                [WORKSPACE, *ids],
            )]
            drafts = [dict(row) for row in db.execute(
                f"SELECT p.base_sku,d.status,count(DISTINCT dm.media_id) AS images "
                f"FROM content_drafts d JOIN products p ON p.id=d.product_id AND p.workspace_id=d.workspace_id "
                f"LEFT JOIN content_draft_media dm ON dm.draft_id=d.id AND dm.workspace_id=d.workspace_id "
                f"WHERE d.workspace_id=? AND json_extract(d.generation_meta_json,'$.automationRunId') IN ({placeholders}) "
                f"GROUP BY p.base_sku,d.status ORDER BY p.base_sku",
                [WORKSPACE, *ids],
            )]
            schedules = [dict(row) for row in db.execute(
                f"SELECT p.base_sku,s.status,s.run_at FROM schedules s JOIN content_drafts d ON d.id=s.draft_id "
                f"AND d.workspace_id=s.workspace_id JOIN products p ON p.id=d.product_id AND p.workspace_id=d.workspace_id "
                f"WHERE s.workspace_id=? AND s.created_by IN ({','.join('?' for _ in ids)}) ORDER BY s.run_at",
                [WORKSPACE, *['automation:' + run_id for run_id in ids]],
            )]
            jobs = db.execute(
                f"SELECT count(*) FROM publish_jobs j JOIN schedules s ON s.id=j.schedule_id "
                f"WHERE j.workspace_id=? AND s.created_by IN ({','.join('?' for _ in ids)})",
                [WORKSPACE, *['automation:' + run_id for run_id in ids]],
            ).fetchone()[0]
            ph0014 = [dict(row) for row in db.execute(
                "SELECT d.id,d.target_provider,d.content_type,d.status,d.created_at,d.updated_at,"
                "json_extract(d.generation_meta_json,'$.automationRunId') AS run_id,"
                "substr(d.body,1,500) AS body_preview,count(DISTINCT dm.media_id) AS images,"
                "group_concat(DISTINCT s.status) AS schedule_statuses,"
                "group_concat(DISTINCT s.id) AS schedule_ids,"
                "group_concat(DISTINCT j.status) AS job_statuses,"
                "group_concat(DISTINCT j.external_post_id) AS external_post_ids "
                "FROM content_drafts d JOIN products p ON p.id=d.product_id AND p.workspace_id=d.workspace_id "
                "LEFT JOIN content_draft_media dm ON dm.draft_id=d.id AND dm.workspace_id=d.workspace_id "
                "LEFT JOIN schedules s ON s.draft_id=d.id AND s.workspace_id=d.workspace_id "
                "LEFT JOIN publish_jobs j ON j.draft_id=d.id AND j.workspace_id=d.workspace_id "
                "WHERE d.workspace_id=? AND p.base_sku='PH0014' "
                "GROUP BY d.id,d.target_provider,d.content_type,d.status,d.created_at,d.updated_at,d.generation_meta_json,d.body "
                "ORDER BY d.created_at DESC", [WORKSPACE],
            )]
            print('EXACT_CATALOG_PROGRESS=' + json.dumps({
                'runs': [{'sku': row['base_sku'], 'status': row['status'], 'code': row['error_code'],
                          'requestedImages': row['requested_image_count'], 'generatedImages': row['completed_image_count']}
                         for row in rows],
                'steps': steps,
                'readyDrafts': drafts,
                'scheduled': schedules,
                'publishJobs': jobs,
                'ph0014Candidates': ph0014,
                'cronTimer': subprocess.run(['systemctl', 'is-active', 'taha-ai-cron.timer'],
                                             capture_output=True, text=True, timeout=15).stdout.strip(),
                'releaseLockHeld': subprocess.run(['flock', '-n', '/var/lock/taha-ai-release.lock', 'true'],
                                                  timeout=10).returncode != 0,
            }, separators=(',', ':')), flush=True)
            return
    raise RuntimeError('EXACT_PROGRESS_DATABASE_MISSING')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('EXACT_CATALOG_PROGRESS_FAILED', file=sys.stderr)
        raise SystemExit(1)
