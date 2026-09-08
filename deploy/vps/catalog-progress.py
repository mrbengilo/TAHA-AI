"""Read-only progress report for the exact prepare-only catalog recovery."""
# Probe generation 35: verify 16 stale SKU and size jobs quarantined.
import base64
import json
import re
from pathlib import Path
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.request

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


def website_probe():
    result = {'status': None, 'allow': None, 'reachable': False, 'apiPaths': [], 'apiOrigins': [], 'productApiContext': [], 'contractContext': [], 'formBuilderContext': [], 'vhostOnAutomationVps': False}
    request = urllib.request.Request('https://tahashoes.vn/api/taha/publish', method='GET')
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            result.update(status=response.status, allow=response.headers.get('Allow'), reachable=True)
    except urllib.error.HTTPError as error:
        result.update(status=error.code, allow=error.headers.get('Allow'), reachable=True)
    except Exception:
        pass
    try:
        html = urllib.request.urlopen('https://tahashoes.vn/', timeout=10).read().decode('utf-8', 'replace')
        scripts = re.findall(r'<script[^>]+src=["\\\']([^"\\\']+)', html)
        main = next((value for value in scripts if '/static/js/main.' in value), None)
        if main:
            bundle = urllib.request.urlopen('https://tahashoes.vn' + main, timeout=20).read().decode('utf-8', 'replace')
            paths = sorted(set(re.findall(r'/(?:api|admin)/[A-Za-z0-9_?=&.{}:$%\\/-]{2,160}', bundle)))
            result['apiPaths'] = [value for value in paths if not re.search(r'(token|secret|password|key)=', value, re.I)][:80]
            origins = sorted(set(re.findall(r'https://[A-Za-z0-9.-]+(?::[0-9]+)?', bundle)))
            result['apiOrigins'] = [value for value in origins if 'taha' in value.lower()][:20]
            contexts = []
            needle = '/admin/products'
            start = 0
            while len(contexts) < 8:
                index = bundle.find(needle, start)
                if index < 0: break
                sample = bundle[max(0, index - 260):index + 420]
                sample = re.sub(r'[A-Za-z0-9_-]{32,}', '<redacted>', sample)
                contexts.append(sample)
                start = index + len(needle)
            result['productApiContext'] = contexts
            contract_contexts = []
            for needle in ('baseURL', 'Authorization', 'shortDescription', 'soldCount', 'reviewCount', 'originalPrice', 'costPrice', 'descriptionDetail', 'technicalSpecs'):
                index = bundle.find(needle)
                if index < 0: continue
                sample = bundle[max(0, index - 360):index + 720]
                sample = re.sub(r'[A-Za-z0-9_-]{32,}', '<redacted>', sample)
                contract_contexts.append({'needle': needle, 'sample': sample})
            result['contractContext'] = contract_contexts
            builder_contexts = []
            for needle in ('L=async()=>', 'const ia=', 'interceptors.request.use', 'isSecondHand'):
                start = 0
                while len(builder_contexts) < 10:
                    index = bundle.find(needle, start)
                    if index < 0: break
                    sample = bundle[max(0, index - 700):index + 2600]
                    sample = re.sub(r'[A-Za-z0-9_-]{32,}', '<redacted>', sample)
                    builder_contexts.append({'needle': needle, 'sample': sample})
                    start = index + len(needle)
                    if needle != 'isSecondHand': break
            result['formBuilderContext'] = builder_contexts
    except Exception:
        pass
    try:
        check = subprocess.run(['grep', '-Rsl', 'server_name[^;]*tahashoes\\.vn', '/etc/nginx'],
                               capture_output=True, text=True, timeout=10)
        result['vhostOnAutomationVps'] = check.returncode == 0 and bool(check.stdout.strip())
    except Exception:
        pass
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
                'websiteProbe': website_probe(),
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
