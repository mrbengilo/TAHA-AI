"""Recover the known unsent September 8 PH0027 post through normal review/publish APIs."""
import fcntl
import hashlib
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
SOURCE_RECEIPT = RECEIPT.with_name('facebook-sep8-source-refresh.json')


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
            result['_db_path'] = str(path)
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


def digest(value):
    # Matches productFingerprint's JSON.stringify for this string/integer product record.
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def refresh_source_draft(job):
    """Rebuild this approved source-only caption after the SKU-size schema change.

    No publish job, source image, optimization or generation metadata is changed.
    The normal publish API subsequently validates current catalog, source media and copy.
    """
    with sqlite3.connect(job['_db_path'], timeout=10) as db:
        db.row_factory = sqlite3.Row
        db.execute('BEGIN IMMEDIATE')
        draft = db.execute('SELECT * FROM content_drafts WHERE id=? AND workspace_id=?', [DRAFT_ID, WORKSPACE]).fetchone()
        current = db.execute('SELECT * FROM publish_jobs WHERE id=? AND workspace_id=?', [JOB_ID, WORKSPACE]).fetchone()
        if (not draft or not current or draft['status'] != 'approved' or draft['target_provider'] != 'facebook'
                or draft['product_id'] != job['product_id'] or current['draft_id'] != DRAFT_ID
                or current['product_id'] != job['product_id'] or current['connection_id'] != job['connection_id']
                or current['status'] != 'failed' or current['error_code'] != 'CONTENT_PRICE_FORBIDDEN'
                or current['external_post_id'] or current['external_url'] or current['lease_owner']
                or json.loads(current['provider_response_json'] or '{}')):
            raise RuntimeError('SOURCE_REFRESH_JOB_CHANGED')
        mapping = db.execute("""SELECT id FROM channel_mappings WHERE workspace_id=? AND connection_id=?
            AND entity_type='post' AND entity_id=? LIMIT 1""", [WORKSPACE,job['connection_id'],JOB_ID]).fetchone()
        if mapping:
            raise RuntimeError('SOURCE_REFRESH_MAPPING_EXISTS')
        competing = db.execute("""SELECT id FROM publish_jobs WHERE workspace_id=? AND connection_id=?
            AND product_id=? AND id<>? AND (
              (status IN ('queued','retry_wait','publishing','blocked','awaiting_confirmation') AND scheduled_for<?)
              OR ((status='published' OR external_post_id IS NOT NULL OR external_url IS NOT NULL
                OR provider_response_json<>'{}') AND completed_at>=? AND completed_at<?)) LIMIT 1""",
            [WORKSPACE, job['connection_id'], job['product_id'], JOB_ID, DAY_END, DAY_START, DAY_END]).fetchone()
        if competing:
            raise RuntimeError('SOURCE_REFRESH_COMPETING_JOB')
        scheduled = db.execute("""SELECT s.id FROM schedules s JOIN content_drafts d ON d.id=s.draft_id
            AND d.workspace_id=s.workspace_id WHERE s.workspace_id=? AND s.connection_id=? AND d.product_id=?
            AND s.draft_id<>? AND s.status='active' AND s.next_run_at<? LIMIT 1""",
            [WORKSPACE,job['connection_id'],job['product_id'],DRAFT_ID,DAY_END]).fetchone()
        if scheduled:
            raise RuntimeError('SOURCE_REFRESH_COMPETING_SCHEDULE')
        product = db.execute("""SELECT p.*,COALESCE(MIN(v.price_minor),0) AS price_minor,
            MAX(v.compare_at_price_minor) AS compare_at_price_minor FROM products p
            LEFT JOIN product_variants v ON v.product_id=p.id AND v.workspace_id=p.workspace_id AND v.status='active'
            WHERE p.id=? AND p.workspace_id=? AND p.status='active' AND p.deleted_at IS NULL GROUP BY p.id""",
            [job['product_id'], WORKSPACE]).fetchone()
        if not product or product['base_sku'] != 'PH0027':
            raise RuntimeError('SOURCE_REFRESH_PRODUCT_CHANGED')
        metadata = json.loads(product['metadata_json'])
        sizes = metadata.get('website', {}).get('sizes')
        if sizes != ['36', '37', '38', '39', '40']:
            raise RuntimeError('SOURCE_REFRESH_SIZES_CHANGED')
        product_fields = [product[key] for key in ['base_sku','name','description','brand','category',
                                                  'currency','price_minor','compare_at_price_minor']]
        fingerprint = digest(product_fields + [sizes])
        data = json.loads(draft['platform_data_json'])
        if data.get('sourceImageCount') != 3 or data.get('generatedImageCount') != 0:
            raise RuntimeError('SOURCE_REFRESH_REQUIRES_SOURCE_ONLY')
        media = db.execute("""SELECT m.*,dm.sort_order FROM content_draft_media dm
            JOIN media_assets m ON m.id=dm.media_id AND m.workspace_id=dm.workspace_id
            JOIN product_media pm ON pm.media_id=m.id AND pm.workspace_id=m.workspace_id AND pm.product_id=?
            WHERE dm.draft_id=? AND dm.workspace_id=? ORDER BY dm.sort_order,dm.created_at""",
            [job['product_id'], DRAFT_ID, WORKSPACE]).fetchall()
        source = metadata.get('googleSource', {})
        if len(media) != 3 or len({row['id'] for row in media}) != 3:
            raise RuntimeError('SOURCE_REFRESH_MEDIA_CHANGED')
        for row in media:
            drive = json.loads(row['metadata_json']).get('googleDriveSource', {})
            if (row['origin'] != 'source' or row['status'] != 'ready' or row['storage_provider'] != 'google_drive'
                    or row['source_connection_id'] != product['source_connection_id'] or not row['external_id']
                    or drive.get('driveFileId') != row['external_id'] or drive.get('skuKey') != 'PH0027'
                    or drive.get('connectionId') != source.get('connectionId') or drive.get('matchKind') != 'sku_folder'
                    or not source.get('driveFolderId') or drive.get('driveFolderId') != source.get('driveFolderId')):
                raise RuntimeError('SOURCE_REFRESH_MEDIA_INVALID')
        title = product['name'].strip()
        if not title or len(title) > 180:
            raise RuntimeError('SOURCE_REFRESH_TITLE_INVALID')
        body = title + '\n\nMã sản phẩm: PH0027\nSize: ' + ', '.join(sizes) + '\n\nNhắn tin TAHA SHOES để được tư vấn chọn size phù hợp.'
        tags = ['TAHASHOES', 'PH0027']
        marker = 'sep8-ph0027-size-refresh-v1'
        generation = json.loads(draft['generation_meta_json'])
        if generation.get('operatorSourceRefresh') == marker:
            if draft['body'] != body or data.get('sourceFingerprint') != fingerprint or json.loads(draft['hashtags_json']) != tags:
                raise RuntimeError('SOURCE_REFRESH_REPLAY_CHANGED')
            return
        original = json.loads(RECEIPT.read_text())
        if (draft['body'] != corrected_body(original['originalBody'])
                or draft['version'] != job['version']
                or data.get('sourceFingerprint') not in (digest(product_fields), digest(product_fields + [[]]))):
            raise RuntimeError('SOURCE_REFRESH_NOT_SIZE_ONLY')
        if not SOURCE_RECEIPT.exists():
            fd = os.open(SOURCE_RECEIPT, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as output:
                json.dump({'jobId': JOB_ID, 'draft': dict(draft), 'mediaIds': [row['id'] for row in media],
                           'media': [dict(row) for row in media], 'newBody': body, 'newFingerprint': fingerprint}, output, ensure_ascii=False)
        else:
            backup = json.loads(SOURCE_RECEIPT.read_text())
            if backup.get('draft') != dict(draft) or backup.get('newFingerprint') != fingerprint:
                raise RuntimeError('SOURCE_REFRESH_BACKUP_CHANGED')
        data.update(sourceFingerprint=fingerprint, productDescription=body)
        generation.update(operatorSourceRefresh=marker)
        now = int(time.time() * 1000)
        changed = db.execute("""UPDATE content_drafts SET title=?,body=?,hashtags_json=?,platform_data_json=?,
            generation_meta_json=?,version=version+1,updated_at=? WHERE id=? AND workspace_id=? AND version=? AND status='approved'""",
            [title,body,json.dumps(tags),json.dumps(data,ensure_ascii=False),json.dumps(generation),now,DRAFT_ID,WORKSPACE,draft['version']]).rowcount
        if changed != 1:
            raise RuntimeError('SOURCE_REFRESH_CONFLICT')
        db.execute("""INSERT INTO audit_logs (id,workspace_id,actor_type,actor_id,actor_label,action,entity_type,entity_id,metadata_json,created_at)
            VALUES (?,?, 'system','operator','Operator recovery','content.source_refreshed','content_draft',?,?,?)""",
            [marker,WORKSPACE,DRAFT_ID,json.dumps({'jobId':JOB_ID,'previousVersion':draft['version'],'version':draft['version']+1,
              'previousFingerprint':json.loads(draft['platform_data_json']).get('sourceFingerprint'),'sourceFingerprint':fingerprint,
              'sizes':sizes,'sourceImageCount':3,'generatedImageCount':0}),now])
        db.commit()
        report('FACEBOOK_SOURCE_REFRESHED', {'sku':'PH0027','sizes':sizes,'sourceImages':3,'generatedImages':0})


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
            else:
                expected_body = corrected_body(job['body'])
                RECEIPT.parent.mkdir(parents=True, exist_ok=True)
                fd = os.open(RECEIPT, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                receipt = {'jobId': JOB_ID, 'draftId': DRAFT_ID, 'version': job['version'],
                           'originalBody': job['body'], 'revision': revision}
                with os.fdopen(fd, 'w') as output:
                    json.dump(receipt, output)
            if job['body'] == receipt['originalBody']:
                call_api('/api/content-drafts/' + DRAFT_ID, {'action': 'edit', 'version': job['version'],
                         'title': job['title'], 'body': expected_body, 'hashtags': json.loads(job['hashtags_json'])}, secret, 'PATCH')
                report('FACEBOOK_RECOVERY_CONTENT', {'jobId': JOB_ID, 'removedPriceLines': 1, 'removedInternalLines': 1})
            refresh_source_draft(job)
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
