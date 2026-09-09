"""Safely republish the single PH0015 Facebook job blocked by the fingerprint v2 rollout."""
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
SKU = 'PH0015'
MARKER = 'product-copy-v2-compat-20260909'
REPO = Path('/var/www/taha-ai')
ENV = Path('/etc/taha-ai/.dev.vars')


def require(value, code):
    if not value:
        raise RuntimeError(code)


def command(args, timeout=60):
    result = subprocess.run(args, capture_output=True, timeout=timeout)
    require(result.returncode == 0, 'FACEBOOK_STALE_COMMAND_FAILED')
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
        raise RuntimeError('FACEBOOK_STALE_QUERY_INVALID') from None
    require(isinstance(rows, list), 'FACEBOOK_STALE_QUERY_INVALID')
    return rows


def target_rows():
    return query(f"""SELECT j.id,j.status,COALESCE(j.error_code,'') AS errorCode,
      COALESCE(j.external_post_id,'') AS externalPostId,COALESCE(j.external_url,'') AS externalUrl,
      j.available_at AS availableAt,
      COALESCE(json_extract(j.payload_snapshot_json,'$.platformData.fingerprintRecovery'),'') AS marker
    FROM publish_jobs j
    JOIN products p ON p.id=j.product_id AND p.workspace_id=j.workspace_id
    JOIN channel_connections c ON c.id=j.connection_id AND c.workspace_id=j.workspace_id
    WHERE j.workspace_id='{WORKSPACE}' AND p.base_sku='{SKU}'
      AND c.provider='facebook' AND c.status='connected' AND c.publish_mode='api'
      AND (
        json_extract(j.payload_snapshot_json,'$.platformData.fingerprintRecovery')='{MARKER}'
        OR (j.status='blocked' AND j.error_code='PRODUCT_CONTENT_STALE'
          AND j.external_post_id IS NULL AND COALESCE(j.provider_response_json,'{{}}')='{{}}')
      )
    ORDER BY j.scheduled_for DESC,j.created_at DESC""")


def job_row(job_id):
    safe_id = job_id.replace("'", "''")
    rows = query(f"""SELECT id,status,COALESCE(error_code,'') AS errorCode,
      COALESCE(external_post_id,'') AS externalPostId,COALESCE(external_url,'') AS externalUrl,
      available_at AS availableAt,
      COALESCE(json_extract(payload_snapshot_json,'$.platformData.fingerprintRecovery'),'') AS marker
    FROM publish_jobs WHERE workspace_id='{WORKSPACE}' AND id='{safe_id}' LIMIT 1""")
    require(len(rows) == 1, 'FACEBOOK_STALE_JOB_CHANGED')
    return rows[0]


def requeue(job_id):
    safe_id = job_id.replace("'", "''")
    rows = query(f"""UPDATE publish_jobs SET status='queued',available_at=unixepoch()*1000,
      attempt_count=0,lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,error_message=NULL,
      completed_at=NULL,updated_at=unixepoch()*1000,
      payload_snapshot_json=json_set(payload_snapshot_json,
        '$.platformData.fingerprintRecovery','{MARKER}')
    WHERE id='{safe_id}' AND workspace_id='{WORKSPACE}' AND status='blocked'
      AND error_code='PRODUCT_CONTENT_STALE' AND external_post_id IS NULL
      AND COALESCE(provider_response_json,'{{}}')='{{}}'
    RETURNING id,status""")
    require(len(rows) == 1 and rows[0]['status'] == 'queued', 'FACEBOOK_STALE_REQUEUE_REJECTED')


def read_secret():
    require(ENV.is_file() and not ENV.is_symlink(), 'FACEBOOK_STALE_ENV_INVALID')
    for line in ENV.read_text().splitlines():
        key, separator, value = line.partition('=')
        if separator and key.strip() == 'INTERNAL_API_SECRET':
            secret = value.strip().strip('"\'')
            require(secret, 'FACEBOOK_STALE_SECRET_MISSING')
            return secret
    raise RuntimeError('FACEBOOK_STALE_SECRET_MISSING')


def tick(secret, job_id):
    request = Request(
        'http://127.0.0.1:8787/api/internal/publish/tick',
        method='POST',
        data=json.dumps({'jobIds': [job_id]}).encode(),
        headers={'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json'},
    )
    try:
        with urlopen(request, timeout=360) as response:
            payload = json.load(response)
    except HTTPError as error:
        raise RuntimeError('FACEBOOK_STALE_API_HTTP_' + str(error.code)) from None
    except (OSError, ValueError):
        raise RuntimeError('FACEBOOK_STALE_API_UNAVAILABLE') from None
    try:
        result = payload['data']['dispatcher']
    except (KeyError, TypeError):
        raise RuntimeError('FACEBOOK_STALE_API_INVALID') from None
    require(isinstance(result, dict), 'FACEBOOK_STALE_API_INVALID')
    return result


def wait_for_cron_idle():
    for _ in range(90):
        state = command(['systemctl', 'show', '-p', 'ActiveState', '--value', 'taha-ai-cron.service']).strip()
        if state not in (b'active', b'activating', b'deactivating'):
            return
        time.sleep(2)
    raise RuntimeError('FACEBOOK_STALE_CRON_BUSY')


def main(args):
    require(re.fullmatch(r'[0-9a-f]{40}', args.expected_release_sha), 'FACEBOOK_STALE_RELEASE_REQUIRED')
    require(command(['git', '-C', str(REPO), 'rev-parse', 'HEAD']).decode().strip() == args.expected_release_sha,
            'FACEBOOK_STALE_RELEASE_CHANGED')
    app = json.loads(command(['docker', 'inspect', 'taha-ai']))[0]
    require(app['Config']['Image'] == 'tahashoes-taha-ai:' + args.expected_release_sha
            and app['State']['Running'], 'FACEBOOK_STALE_APP_CHANGED')
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
            rows = target_rows()
            require(len(rows) == 1, 'FACEBOOK_STALE_TARGET_COUNT_INVALID')
            row = rows[0]
            print('FACEBOOK_STALE_TARGET=' + json.dumps(
                {'sku': SKU, 'jobId': row['id'], 'status': row['status'], 'marker': row['marker']},
                separators=(',', ':'),
            ), flush=True)
            if row['status'] == 'published':
                require(row['marker'] == MARKER and row['externalPostId'], 'FACEBOOK_STALE_RECEIPT_MISSING')
            else:
                if row['marker'] != MARKER:
                    requeue(row['id'])
                deadline = time.monotonic() + 10 * 60
                previous = None
                while True:
                    require(time.monotonic() < deadline, 'FACEBOOK_STALE_TIMEOUT')
                    row = job_row(row['id'])
                    state = {'status': row['status'], 'errorCode': row['errorCode']}
                    if state != previous:
                        print('FACEBOOK_STALE_PROGRESS=' + json.dumps(state, separators=(',', ':')), flush=True)
                        previous = state
                    if row['status'] == 'published':
                        require(row['externalPostId'], 'FACEBOOK_STALE_RECEIPT_MISSING')
                        break
                    require(row['status'] in ('queued', 'retry_wait', 'publishing'),
                            'FACEBOOK_STALE_PUBLISH_FAILED')
                    if row['status'] != 'publishing' and int(row['availableAt'] or 0) <= int(time.time() * 1000):
                        result = tick(secret, row['id'])
                        errors = result.get('errors') if isinstance(result.get('errors'), list) else []
                        if errors:
                            print('FACEBOOK_STALE_WORKER_ERRORS=' + json.dumps(errors, separators=(',', ':')), flush=True)
                    time.sleep(2)
            print('FACEBOOK_STALE_RECOVERY_COMPLETE=' + json.dumps({
                'sku': SKU,
                'jobId': row['id'],
                'externalPostId': row['externalPostId'],
                'externalUrl': row['externalUrl'],
            }, separators=(',', ':')), flush=True)
        finally:
            if timer_was_active:
                command(['systemctl', 'enable', '--now', 'taha-ai-cron.timer'])
                require(subprocess.run(
                    ['systemctl', 'is-active', '--quiet', 'taha-ai-cron.timer'],
                    capture_output=True, timeout=10,
                ).returncode == 0, 'FACEBOOK_STALE_TIMER_RESTART_FAILED')
                print('FACEBOOK_STALE_TIMER_ACTIVE=yes', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-release-sha', required=True)
    try:
        main(parser.parse_args())
    except Exception as error:
        message = str(error)
        sys.exit(message if re.fullmatch(r'FACEBOOK_STALE_[A-Z0-9_]+', message) else 'FACEBOOK_STALE_RECOVERY_FAILED')
