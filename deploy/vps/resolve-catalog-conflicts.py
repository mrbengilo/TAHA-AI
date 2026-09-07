"""Cancel the two exact publish-capable runs blocking the authorized prepare-only catalog."""
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

WORKSPACE = '00000000-0000-4000-8000-000000000001'
IMAGE = 'tahashoes-taha-ai:010c0193ab4ed57991a60e17aee2925a729ac117'
IMAGE_ID = 'sha256:3c4035316ec16398880dbceab5bc422c0824279f7816ef01625f91dba1f7b434'
CATALOG = Path('/var/lib/taha-ai/ops-recovery/catalog-lifestyle-v3.json')
RESOLUTION = Path('/var/lib/taha-ai/ops-recovery/catalog-conflicts-v3-resolved.json')
PROMPT_VERSION = 'taha-lifestyle-v3'
EXPECTED = {
    'PH0014': {'id': '82af7bf1-2c99-479d-8922-afb90d595217', 'kind': 'product', 'target': 'website'},
    'PH0021': {'id': 'cdf173a1-4729-4fef-bd48-3c4e9c6abf3c', 'kind': 'confirm', 'target': 'facebook'},
}


def read_secret():
    for line in Path('/etc/taha-ai/.dev.vars').read_text().splitlines():
        key, sep, value = line.partition('=')
        if sep and key.strip() == 'INTERNAL_API_SECRET':
            secret = value.strip().strip('"\'')
            if secret:
                return secret
    raise RuntimeError('INTERNAL_API_SECRET_MISSING')


def post(secret, path):
    request = Request('http://127.0.0.1:8787' + path, method='POST', data=b'{}',
                      headers={'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json'})
    try:
        with urlopen(request, timeout=60) as response:
            result = json.load(response)
    except HTTPError as error:
        raise RuntimeError('CATALOG_CONFLICT_CANCEL_HTTP_' + str(error.code)) from None
    if not result.get('data'):
        raise RuntimeError('CATALOG_CONFLICT_CANCEL_EMPTY')


def catalog_ids():
    data = json.loads(CATALOG.read_text())
    products = data.get('products')
    if not isinstance(products, list) or len(products) != 15:
        raise RuntimeError('CATALOG_CONFLICT_MARKER_CHANGED')
    ids = [row.get('runId') for row in products if isinstance(row, dict)]
    if len(set(ids)) != 15 or any(not isinstance(value, str) or not re.fullmatch(r'[0-9a-f-]{36}', value) for value in ids):
        raise RuntimeError('CATALOG_CONFLICT_MARKER_CHANGED')
    return ids


def find_database(ids):
    placeholders = ','.join('?' for _ in ids)
    required = {'automation_runs', 'automation_steps', 'products', 'content_drafts', 'schedules', 'publish_jobs'}
    for path in Path('/var/lib/taha-ai').rglob('*.sqlite'):
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not required.issubset(tables):
                continue
            count = db.execute(
                f"SELECT count(*) FROM automation_runs WHERE workspace_id=? AND id IN ({placeholders})",
                [WORKSPACE, *ids],
            ).fetchone()[0]
            if count == 15:
                return path
    raise RuntimeError('CATALOG_CONFLICT_DATABASE_MISSING')


def conflicting_rows(database, catalog_run_ids, selected_ids=None):
    placeholders = ','.join('?' for _ in catalog_run_ids)
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        if selected_ids is None:
            rows = db.execute(
                f"SELECT r.id,p.base_sku,r.request_key,r.status,r.error_code,r.requested_image_count,"
                f"r.target_providers_json,r.prompt_version,r.content_json FROM automation_runs r "
                f"JOIN products p ON p.id=r.product_id AND p.workspace_id=r.workspace_id "
                f"WHERE r.workspace_id=? AND r.product_id IN (SELECT product_id FROM automation_runs "
                f"WHERE workspace_id=? AND id IN ({placeholders})) AND r.id NOT IN ({placeholders}) "
                f"AND r.status IN ('queued','processing') ORDER BY p.base_sku",
                [WORKSPACE, WORKSPACE, *catalog_run_ids, *catalog_run_ids],
            )
        else:
            selected = ','.join('?' for _ in selected_ids)
            rows = db.execute(
                f"SELECT r.id,p.base_sku,r.request_key,r.status,r.error_code,r.requested_image_count,"
                f"r.target_providers_json,r.prompt_version,r.content_json FROM automation_runs r "
                f"JOIN products p ON p.id=r.product_id AND p.workspace_id=r.workspace_id "
                f"WHERE r.workspace_id=? AND r.id IN ({selected}) ORDER BY p.base_sku",
                [WORKSPACE, *selected_ids],
            )
        return [dict(row) for row in rows]


def validate_conflicts(rows, allow_cancelled=False):
    if {row.get('base_sku') for row in rows} != set(EXPECTED) or len(rows) != 2:
        raise RuntimeError('CATALOG_CONFLICT_SET_CHANGED')
    for row in rows:
        spec = EXPECTED[row['base_sku']]
        try:
            targets = json.loads(row['target_providers_json'] or '[]')
            content = json.loads(row['content_json'] or '{}')
        except ValueError:
            raise RuntimeError('CATALOG_CONFLICT_CONTRACT_CHANGED') from None
        states = {'queued', 'processing', 'cancelled'} if allow_cancelled else {'queued', 'processing'}
        connections = content.get('targetConnections')
        if (row['id'] != spec['id'] or row['status'] not in states or row['error_code'] is not None
                or not row['request_key'].startswith(spec['kind'] + ':')
                or row['requested_image_count'] != 4 or row['prompt_version'] != PROMPT_VERSION
                or targets != [spec['target']] or content.get('prepareOnly') is not False
                or not isinstance(connections, dict) or set(connections) != {spec['target']}
                or not isinstance(connections[spec['target']], str) or not connections[spec['target']]):
            raise RuntimeError('CATALOG_CONFLICT_CONTRACT_CHANGED')
    return rows


def assert_no_outputs(database, ids):
    placeholders = ','.join('?' for _ in ids)
    creators = ['automation:' + value for value in ids]
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
        drafts = db.execute(
            f"SELECT count(*) FROM content_drafts WHERE workspace_id=? AND "
            f"json_extract(generation_meta_json,'$.automationRunId') IN ({placeholders})",
            [WORKSPACE, *ids],
        ).fetchone()[0]
        schedules = db.execute(
            f"SELECT count(*) FROM schedules WHERE workspace_id=? AND created_by IN ({placeholders})",
            [WORKSPACE, *creators],
        ).fetchone()[0]
        jobs = db.execute(
            f"SELECT count(*) FROM publish_jobs j JOIN schedules s ON s.id=j.schedule_id "
            f"WHERE j.workspace_id=? AND s.created_by IN ({placeholders})",
            [WORKSPACE, *creators],
        ).fetchone()[0]
    if drafts or schedules or jobs:
        raise RuntimeError('CATALOG_CONFLICT_ALREADY_HAS_OUTPUTS')


def replace_resolution(value):
    temporary = RESOLUTION.with_name(RESOLUTION.name + '.tmp-' + str(os.getpid()))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output, separators=(',', ':'))
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, RESOLUTION)
    directory = os.open(RESOLUTION.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def main():
    with open('/var/lock/taha-ai-release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        runtime = subprocess.run(
            ['docker', 'inspect', 'taha-ai', '--format', '{{.Config.Image}}|{{.Image}}|{{.State.Status}}'],
            check=True, capture_output=True, text=True, timeout=30,
        ).stdout.strip()
        tag_id = subprocess.run(
            ['docker', 'image', 'inspect', IMAGE, '--format', '{{.Id}}'],
            check=True, capture_output=True, text=True, timeout=30,
        ).stdout.strip()
        revision = subprocess.run(
            ['docker', 'image', 'inspect', IMAGE_ID, '--format',
             '{{index .Config.Labels "org.opencontainers.image.revision"}}'],
            check=True, capture_output=True, text=True, timeout=30,
        ).stdout.strip()
        if runtime != IMAGE + '|' + IMAGE_ID + '|running' or tag_id != IMAGE_ID \
                or revision != IMAGE.removeprefix('tahashoes-taha-ai:'):
            raise RuntimeError('CATALOG_CONFLICT_DEPLOYMENT_CHANGED')
        if subprocess.run(['systemctl', 'is-active', '--quiet', 'taha-ai-cron.timer']).returncode == 0:
            raise RuntimeError('CATALOG_CONFLICT_CRON_NOT_HELD')
        service = subprocess.run(
            ['systemctl', 'show', 'taha-ai-cron.service', '-p', 'ActiveState', '--value'],
            check=True, capture_output=True, text=True, timeout=30,
        ).stdout.strip()
        if service in ('active', 'activating', 'deactivating'):
            raise RuntimeError('CATALOG_CONFLICT_CRON_NOT_DRAINED')

        ids = catalog_ids()
        database = find_database(ids)
        if RESOLUTION.exists():
            marker = json.loads(RESOLUTION.read_text())
            selected_ids = marker.get('runIds')
            if marker.get('catalogRunIds') != ids or not isinstance(selected_ids, list) or len(selected_ids) != 2:
                raise RuntimeError('CATALOG_CONFLICT_RESOLUTION_CHANGED')
            rows = validate_conflicts(conflicting_rows(database, ids, selected_ids), allow_cancelled=True)
        else:
            rows = validate_conflicts(conflicting_rows(database, ids))
            selected_ids = [row['id'] for row in rows]
            assert_no_outputs(database, selected_ids)
            replace_resolution({'stage': 'planned', 'catalogRunIds': ids, 'runIds': selected_ids,
                                'contracts': [{'sku': row['base_sku'], **EXPECTED[row['base_sku']]} for row in rows]})

        assert_no_outputs(database, selected_ids)
        secret = read_secret()
        for row in rows:
            if row['status'] in ('queued', 'processing'):
                post(secret, '/api/automation-runs/' + row['id'] + '/cancel')
        final = validate_conflicts(conflicting_rows(database, ids, selected_ids), allow_cancelled=True)
        if any(row['status'] != 'cancelled' for row in final):
            raise RuntimeError('CATALOG_CONFLICT_CANCEL_INCOMPLETE')
        assert_no_outputs(database, selected_ids)
        if conflicting_rows(database, ids):
            raise RuntimeError('CATALOG_CONFLICT_ACTIVE_REMAINS')
        replace_resolution({'stage': 'applied', 'catalogRunIds': ids, 'runIds': selected_ids,
                            'contracts': [{'sku': row['base_sku'], **EXPECTED[row['base_sku']]} for row in final]})
        print('CATALOG_CONFLICTS_CANCELLED=2', flush=True)
        print('CATALOG_CONFLICT_OUTPUTS=0', flush=True)
        print('CATALOG_CRON_REMAINS_HELD=yes', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error)
        print(message if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', message) else 'CATALOG_CONFLICT_RESOLUTION_FAILED', file=sys.stderr)
        sys.exit(1)
