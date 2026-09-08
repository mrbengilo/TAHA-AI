"""Finish Facebook template-v2 recovery runs created by migration 0006."""
import argparse
import fcntl
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

WORKSPACE = '00000000-0000-4000-8000-000000000001'
REPO = Path('/var/www/taha-ai')
ENV = Path('/etc/taha-ai/.dev.vars')


def require(value, code):
    if not value:
        raise RuntimeError(code)


def command(args, timeout=60):
    result = subprocess.run(args, capture_output=True, timeout=timeout)
    require(result.returncode == 0, 'FACEBOOK_TEMPLATE_COMMAND_FAILED')
    return result.stdout


def query(sql):
    raw = command([
        'docker', 'exec', 'taha-ai', 'pnpm', 'exec', 'wrangler', 'd1', 'execute', 'DB',
        '--local', '--persist-to=/data', '--config=/app/wrangler.vps.jsonc',
        '--json', '--command', sql,
    ], timeout=90)
    try:
        payload = json.loads(raw)
        rows = payload[0]['results']
    except (ValueError, IndexError, KeyError, TypeError):
        raise RuntimeError('FACEBOOK_TEMPLATE_QUERY_INVALID') from None
    require(isinstance(rows, list), 'FACEBOOK_TEMPLATE_QUERY_INVALID')
    return rows


def recovery_rows():
    return query(f"""SELECT r.id,p.base_sku AS sku,r.status,COALESCE(r.error_code,'') AS errorCode,
      r.prompt_version AS promptVersion,
      (SELECT COUNT(*) FROM content_drafts d WHERE d.workspace_id=r.workspace_id
        AND json_extract(d.generation_meta_json,'$.automationRunId')=r.id) AS drafts,
      (SELECT COUNT(*) FROM schedules s WHERE s.workspace_id=r.workspace_id
        AND s.created_by='automation:' || r.id) AS schedules
    FROM automation_runs r JOIN products p ON p.id=r.product_id AND p.workspace_id=r.workspace_id
    WHERE r.workspace_id='{WORKSPACE}'
      AND json_extract(r.content_json,'$.templateRecovery')='facebook-structure-v2'
    ORDER BY p.base_sku,r.created_at""")


def visible_sku_rows():
    return query(f"""SELECT p.base_sku AS sku,r.status,COALESCE(r.error_code,'') AS errorCode,
      r.prompt_version AS promptVersion
    FROM automation_runs r JOIN products p ON p.id=r.product_id AND p.workspace_id=r.workspace_id
    WHERE r.workspace_id='{WORKSPACE}' AND p.base_sku IN ('PH0014','PH0018','PH0021','PH0022')
      AND NOT EXISTS (SELECT 1 FROM automation_runs newer WHERE newer.workspace_id=r.workspace_id
        AND newer.product_id=r.product_id AND (newer.created_at>r.created_at
          OR (newer.created_at=r.created_at AND newer.id>r.id)))
    ORDER BY p.base_sku""")


def read_secret():
    require(ENV.is_file() and not ENV.is_symlink(), 'FACEBOOK_TEMPLATE_ENV_INVALID')
    for line in ENV.read_text().splitlines():
        key, separator, value = line.partition('=')
        if separator and key.strip() == 'INTERNAL_API_SECRET':
            secret = value.strip().strip('"\'')
            require(secret, 'FACEBOOK_TEMPLATE_SECRET_MISSING')
            return secret
    raise RuntimeError('FACEBOOK_TEMPLATE_SECRET_MISSING')


def tick(secret, run_ids):
    request = Request(
        'http://127.0.0.1:8787/api/internal/automation/tick',
        method='POST',
        data=json.dumps({'runIds': run_ids}).encode(),
        headers={'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json'},
    )
    try:
        with urlopen(request, timeout=360) as response:
            payload = json.load(response)
    except HTTPError as error:
        raise RuntimeError('FACEBOOK_TEMPLATE_API_HTTP_' + str(error.code)) from None
    except (OSError, ValueError):
        raise RuntimeError('FACEBOOK_TEMPLATE_API_UNAVAILABLE') from None
    try:
        result = payload['data']['automation']
    except (KeyError, TypeError):
        raise RuntimeError('FACEBOOK_TEMPLATE_API_INVALID') from None
    require(isinstance(result, dict), 'FACEBOOK_TEMPLATE_API_INVALID')
    return result


def wait_for_cron_idle():
    for _ in range(90):
        state = command(['systemctl', 'show', '-p', 'ActiveState', '--value', 'taha-ai-cron.service']).strip()
        if state not in (b'active', b'activating', b'deactivating'):
            return
        time.sleep(2)
    raise RuntimeError('FACEBOOK_TEMPLATE_CRON_BUSY')


def main(args):
    require(re.fullmatch(r'[0-9a-f]{40}', args.expected_release_sha), 'FACEBOOK_TEMPLATE_RELEASE_REQUIRED')
    require(command(['git', '-C', str(REPO), 'rev-parse', 'HEAD']).decode().strip() == args.expected_release_sha,
            'FACEBOOK_TEMPLATE_RELEASE_CHANGED')
    app = json.loads(command(['docker', 'inspect', 'taha-ai']))[0]
    require(
        app['Config']['Image'] == 'tahashoes-taha-ai:' + args.expected_release_sha
        and app['State']['Running'],
        'FACEBOOK_TEMPLATE_APP_CHANGED',
    )
    secret = read_secret()

    with open('/var/lock/taha-ai-release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        timer_was_active = subprocess.run(
            ['systemctl', 'is-active', '--quiet', 'taha-ai-cron.timer'],
            capture_output=True, timeout=10,
        ).returncode == 0
        command(['systemctl', 'stop', 'taha-ai-cron.timer'])
        try:
            wait_for_cron_idle()
            rows = recovery_rows()
            print('FACEBOOK_TEMPLATE_RECOVERY_TARGETS=' + json.dumps(
                [{'sku': row['sku'], 'status': row['status']} for row in rows],
                separators=(',', ':'),
            ), flush=True)
            deadline = time.monotonic() + 30 * 60
            previous = None
            while rows and any(row['status'] in ('queued', 'processing') for row in rows):
                require(time.monotonic() < deadline, 'FACEBOOK_TEMPLATE_RECOVERY_TIMEOUT')
                active_ids = [row['id'] for row in rows if row['status'] in ('queued', 'processing')]
                result = tick(secret, active_ids)
                errors = result.get('errors') if isinstance(result.get('errors'), list) else []
                if errors:
                    print('FACEBOOK_TEMPLATE_WORKER_ERRORS=' + json.dumps(errors, separators=(',', ':')), flush=True)
                time.sleep(2)
                rows = recovery_rows()
                progress = [{'sku': row['sku'], 'status': row['status'], 'drafts': row['drafts'],
                             'schedules': row['schedules'], 'errorCode': row['errorCode']} for row in rows]
                if progress != previous:
                    print('FACEBOOK_TEMPLATE_PROGRESS=' + json.dumps(progress, separators=(',', ':')), flush=True)
                    previous = progress
            require(all(row['status'] == 'completed' for row in rows), 'FACEBOOK_TEMPLATE_RECOVERY_FAILED')
            require(all(int(row['drafts']) >= 1 for row in rows), 'FACEBOOK_TEMPLATE_DRAFT_MISSING')
            print('FACEBOOK_TEMPLATE_RECOVERY_COMPLETE=' + json.dumps(
                [{'sku': row['sku'], 'drafts': row['drafts'], 'schedules': row['schedules']} for row in rows],
                separators=(',', ':'),
            ), flush=True)
            print('FACEBOOK_TEMPLATE_LATEST_SKUS=' + json.dumps(visible_sku_rows(), separators=(',', ':')), flush=True)
        finally:
            if timer_was_active:
                command(['systemctl', 'enable', '--now', 'taha-ai-cron.timer'])
                require(subprocess.run(
                    ['systemctl', 'is-active', '--quiet', 'taha-ai-cron.timer'],
                    capture_output=True, timeout=10,
                ).returncode == 0, 'FACEBOOK_TEMPLATE_TIMER_RESTART_FAILED')
                print('FACEBOOK_TEMPLATE_TIMER_ACTIVE=yes', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-release-sha', required=True)
    try:
        main(parser.parse_args())
    except Exception as error:
        message = str(error)
        sys.exit(message if re.fullmatch(r'FACEBOOK_TEMPLATE_[A-Z0-9_]+', message) else 'FACEBOOK_TEMPLATE_RECOVERY_FAILED')
