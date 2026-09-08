"""Recover the known unsent September 8 PH0027 post through normal review/publish APIs."""
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

WORKSPACE = '00000000-0000-4000-8000-000000000001'
JOB_ID = '0569f8a5-faaf-484c-a1ac-7a4375faf1b4'
DRAFT_ID = 'draft_ab03ca69262f4408be0858cee3cea2ca2c96d044'
DAY_START = 1788800400000  # 2026-09-08 00:00 Asia/Ho_Chi_Minh
DAY_END = DAY_START + 86400000
PRICE_LINE = '💰 Giá: 6xx'
INTERNAL_LINE = 'Vui lòng kiểm tra mã sản phẩm PH0027 và thương hiệu LITUO SPORT để đảm bảo bạn chọn đúng sản phẩm.'
RECEIPT = Path('/var/lib/taha-ai/ops-recovery/facebook-sep8-content-recovery.json')


def report(label, value):
    print(label + '=' + json.dumps(value, ensure_ascii=False, separators=(',', ':')), flush=True)


def read_job():
    for path in Path('/var/lib/taha-ai').rglob('*.sqlite'):
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
            db.row_factory = sqlite3.Row
            if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='publish_jobs'").fetchone():
                continue
            row = db.execute("""SELECT j.*,d.title,d.body,d.hashtags_json,d.version,d.status AS draft_status,
                p.base_sku,c.provider,c.status AS connection_status FROM publish_jobs j
                JOIN content_drafts d ON d.id=j.draft_id AND d.workspace_id=j.workspace_id
                JOIN products p ON p.id=j.product_id AND p.workspace_id=j.workspace_id
                JOIN channel_connections c ON c.id=j.connection_id AND c.workspace_id=j.workspace_id
                WHERE j.id=? AND j.workspace_id=?""", [JOB_ID, WORKSPACE]).fetchone()
            if not row:
                continue
            result = dict(row)
            result['other_published_today'] = db.execute("""SELECT count(*) FROM publish_jobs
                WHERE workspace_id=? AND product_id=? AND connection_id=? AND id!=?
                  AND (status='published' OR external_post_id IS NOT NULL)
                  AND completed_at>=? AND completed_at<?""", [WORKSPACE, row['product_id'], row['connection_id'],
                  JOB_ID, DAY_START, DAY_END]).fetchone()[0]
            return result
    raise RuntimeError('RECOVERY_JOB_MISSING')


def validate_unsent(job):
    if (job['base_sku'] != 'PH0027' or job['draft_id'] != DRAFT_ID or job['provider'] != 'facebook'
            or job['status'] != 'failed' or job['error_code'] != 'CONTENT_PRICE_FORBIDDEN'
            or job['draft_status'] != 'approved' or job['connection_status'] != 'connected'
            or job['external_post_id'] or job['external_url'] or job['lease_owner']
            or json.loads(job['provider_response_json'] or '{}') or job['other_published_today']):
        raise RuntimeError('RECOVERY_UNSENT_GUARD_FAILED')


def corrected_body(body):
    lines = body.splitlines()
    if any(sum(line.strip() == clause for line in lines) != 1 for clause in (PRICE_LINE, INTERNAL_LINE)):
        raise RuntimeError('RECOVERY_PRICE_LINE_CHANGED')
    return '\n'.join(line for line in lines if line.strip() not in (PRICE_LINE, INTERNAL_LINE)).strip()


def call_api(route, body, secret, method='POST'):
    request = Request('http://127.0.0.1:8787' + route, data=json.dumps(body).encode(), method=method,
                      headers={'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json'})
    try:
        with urlopen(request, timeout=120) as response:
            payload = json.load(response)
    except HTTPError as error:
        payload = json.load(error)
        code = (payload.get('error') or {}).get('code', 'RECOVERY_API_FAILED')
        raise RuntimeError(code if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', code) else 'RECOVERY_API_FAILED') from None
    return payload['data']


def main():
    expected = sys.argv[1] if len(sys.argv) == 2 else ''
    if not re.fullmatch(r'[a-f0-9]{40}', expected):
        raise RuntimeError('RECOVERY_REVISION_REQUIRED')
    with open('/var/lock/taha-ai-release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        revision = subprocess.run(['docker', 'inspect', 'taha-ai', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}'],
                                  check=True, capture_output=True, text=True, timeout=20).stdout.strip()
        if revision != expected:
            raise RuntimeError('RECOVERY_REVISION_MISMATCH')
        job = read_job()
        if job['status'] == 'published' and job['external_post_id']:
            report('FACEBOOK_RECOVERY_RECEIPT', {'jobId': JOB_ID, 'status': 'published', 'url': job['external_url']})
            return
        if job['status'] not in ('queued', 'retry_wait', 'publishing'):
            validate_unsent(job)
            secret = None
            for line in Path('/etc/taha-ai/.dev.vars').read_text().splitlines():
                key, sep, value = line.partition('=')
                if sep and key.strip() == 'INTERNAL_API_SECRET':
                    secret = value.strip().strip('"\'')
            if not secret:
                raise RuntimeError('RECOVERY_AUTH_MISSING')
            if RECEIPT.exists():
                receipt = json.loads(RECEIPT.read_text())
                if receipt.get('jobId') != JOB_ID or receipt.get('draftId') != DRAFT_ID:
                    raise RuntimeError('RECOVERY_RECEIPT_MISMATCH')
                expected_body = corrected_body(receipt['originalBody'])
                if job['body'] not in (receipt['originalBody'], expected_body):
                    raise RuntimeError('RECOVERY_DRAFT_CHANGED')
            else:
                expected_body = corrected_body(job['body'])
                RECEIPT.parent.mkdir(parents=True, exist_ok=True)
                fd = os.open(RECEIPT, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'w') as output:
                    json.dump({'jobId': JOB_ID, 'draftId': DRAFT_ID, 'version': job['version'],
                               'originalBody': job['body'], 'revision': revision}, output)
            if job['body'] != expected_body:
                call_api('/api/content-drafts/' + DRAFT_ID, {'action': 'edit', 'version': job['version'],
                         'title': job['title'], 'body': expected_body, 'hashtags': json.loads(job['hashtags_json'])}, secret, 'PATCH')
                report('FACEBOOK_RECOVERY_CONTENT', {'jobId': JOB_ID, 'removedPriceLines': 1, 'removedInternalLines': 1})
            result = call_api('/api/publish/facebook', {'draftId': DRAFT_ID, 'connectionId': job['connection_id']}, secret)
            if result.get('status') not in ('queued', 'retry_wait', 'publishing', 'published'):
                raise RuntimeError('RECOVERY_DID_NOT_QUEUE')
            report('FACEBOOK_RECOVERY_QUEUED', {'jobId': JOB_ID, 'status': result['status']})
    # Normal cron owns dispatch; this script never directly sends or restarts a worker.
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        job = read_job()
        if job['status'] == 'published' and job['external_post_id']:
            report('FACEBOOK_RECOVERY_RECEIPT', {'jobId': JOB_ID, 'status': 'published', 'url': job['external_url']})
            return
        if job['status'] in ('failed', 'blocked', 'cancelled'):
            raise RuntimeError(job['error_code'] or 'RECOVERY_TERMINAL_FAILURE')
        time.sleep(5)
    raise RuntimeError('RECOVERY_RECEIPT_PENDING')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        print(code if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', code) else 'FACEBOOK_RECOVERY_FAILED', flush=True)
        raise SystemExit(1)
