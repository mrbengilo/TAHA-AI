"""Prepare the authorized SKU catalog; never call a publish endpoint."""
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

WORKSPACE = '00000000-0000-4000-8000-000000000001'
TRIAL_PRODUCT = 'f71003d5-0009-42d8-8ea2-d94496fa3758'
MARKER = Path('/var/lib/taha-ai/ops-recovery/catalog-lifestyle-v3.json')


def read_settings():
    values = {}
    for line in Path('/etc/taha-ai/.dev.vars').read_text().splitlines():
        key, sep, value = line.partition('=')
        if sep: values[key.strip()] = value.strip().strip('"\'')
    secret = values.get('INTERNAL_API_SECRET')
    if not secret: raise RuntimeError('INTERNAL_API_SECRET_MISSING')
    return secret


def api(secret, path, body=None, timeout=240):
    request = Request('http://127.0.0.1:8787' + path, method='POST' if body is not None else 'GET',
                      data=None if body is None else json.dumps(body).encode(),
                      headers={'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json'})
    try:
        with urlopen(request, timeout=timeout) as response: result = json.load(response)
    except HTTPError as error:
        raise RuntimeError('CATALOG_API_HTTP_' + str(error.code)) from None
    except (OSError, ValueError):
        raise RuntimeError('CATALOG_API_UNAVAILABLE') from None
    if not result.get('data'): raise RuntimeError('CATALOG_API_EMPTY_RESPONSE')
    return result['data']


def trial_cursor():
    for path in Path('/var/lib/taha-ai').rglob('*.sqlite'):
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='products'").fetchone(): continue
            if not db.execute("SELECT 1 FROM products WHERE id=? AND base_sku='PH0014' AND workspace_id=? AND status='active' AND deleted_at IS NULL", (TRIAL_PRODUCT, WORKSPACE)).fetchone():
                raise RuntimeError('CATALOG_TRIAL_PRODUCT_CHANGED')
            previous = db.execute("SELECT id FROM products WHERE workspace_id=? AND status='active' AND deleted_at IS NULL AND id < ? ORDER BY id DESC LIMIT 1", (WORKSPACE, TRIAL_PRODUCT)).fetchone()
            return previous[0] if previous else ''
    raise RuntimeError('CATALOG_DATABASE_MISSING')


def save_marker(data):
    MARKER.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = MARKER.with_suffix('.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(data, output, ensure_ascii=False)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, MARKER)


def verify_completed_product(secret, product_id):
    folder = api(secret, '/api/products/' + product_id, timeout=90)
    originals, generated = folder['images'], folder['generatedImages']
    if folder.get('validationError') or folder.get('imageValidationError'):
        raise RuntimeError('CATALOG_FOLDER_VALIDATION_FAILED')
    if not originals or any(not image['optimized'] or not 0 < image['byteSize'] < 300000 for image in originals):
        raise RuntimeError('CATALOG_ORIGINAL_IMAGE_LIMIT_FAILED')
    if len(generated) != 4 or any(not 0 < image['byteSize'] < 200000 for image in generated):
        raise RuntimeError('CATALOG_GENERATED_IMAGE_LIMIT_FAILED')
    if product_id == TRIAL_PRODUCT:
        for image in generated + originals:
            route = image['previewUrl']
            if not route.startswith('/api/media/') or '://' in route:
                raise RuntimeError('CATALOG_MEDIA_ROUTE_INVALID')
            request = Request('http://127.0.0.1:8787' + route, headers={'Authorization': 'Bearer ' + secret})
            with urlopen(request, timeout=90) as response:
                content = response.read(300001)
            if len(content) != image['byteSize']:
                raise RuntimeError('CATALOG_MEDIA_BYTES_MISMATCH')
    receipt = {'sku': folder['product']['base_sku'], 'originalImages': len(originals),
               'generatedImages': len(generated), 'maxOriginalBytes': max(image['byteSize'] for image in originals),
               'maxGeneratedBytes': max(image['byteSize'] for image in generated)}
    print('CATALOG_SKU_VERIFIED=' + json.dumps(receipt, separators=(',', ':')), flush=True)
    return receipt


def main():
    secret = read_settings()
    first = api(secret, '/api/automation-catalog', {'cursor': trial_cursor(), 'limit': 1})
    if len(first['results']) != 1 or first['results'][0]['productId'] != TRIAL_PRODUCT:
        raise RuntimeError('CATALOG_TRIAL_SELECTION_CHANGED')
    by_product = {first['results'][0]['productId']: first['results'][0]}
    cursor = ''
    for _ in range(100):
        page = api(secret, '/api/automation-catalog', {'cursor': cursor, 'limit': 5})
        by_product.update({row['productId']: row for row in page['results']})
        if page['nextCursor'] is None: break
        if page['nextCursor'] <= cursor: raise RuntimeError('CATALOG_CURSOR_DID_NOT_ADVANCE')
        cursor = page['nextCursor']
    else: raise RuntimeError('CATALOG_BATCH_LIMIT_REACHED')
    queued = list(by_product.values())
    save_marker({'queuedAt': int(time.time()), 'products': queued})
    print('CATALOG_PREPARED=' + json.dumps(queued, separators=(',', ':')), flush=True)
    ids = {row['runId'] for row in queued if row.get('runId')}
    deadline = time.monotonic() + 30 * 60
    previous = None
    verified = {}
    while time.monotonic() < deadline:
        runs = api(secret, '/api/automation-runs?limit=50', timeout=30)['runs']
        selected = [run for run in runs if run['id'] in ids]
        for run in selected:
            if run['status'] == 'completed' and run['productId'] not in verified:
                verified[run['productId']] = verify_completed_product(secret, run['productId'])
        status = {'requestedSkus': len(queued), 'queuedSkus': len(ids), 'visibleRuns': len(selected),
                  'completed': sum(run['status'] == 'completed' for run in selected),
                  'failed': sum(run['status'] in ('failed', 'cancelled') for run in selected),
                  'generatedImages': sum(run['completedImageCount'] for run in selected)}
        if status != previous:
            print('CATALOG_PROGRESS=' + json.dumps(status, separators=(',', ':')), flush=True)
            save_marker({'products': queued, 'progress': status, 'verified': verified, 'updatedAt': int(time.time())})
            previous = status
        if len(selected) == len(ids) and all(run['status'] in ('completed', 'failed', 'cancelled') for run in selected):
            break
        # Use the existing authenticated worker. Its persisted leases coordinate
        # safely with the already-enabled system timer.
        try:
            tick = api(secret, '/api/internal/cron/tick', {}, timeout=300)
            errors = tick.get('automation', {}).get('errors', [])
            if errors: print('CATALOG_WORKER_ERRORS=' + json.dumps(errors, separators=(',', ':')), flush=True)
        except RuntimeError as error:
            print(str(error), flush=True)
            time.sleep(10)
        time.sleep(2)
    print('CATALOG_BACKGROUND_TIMER_CONTINUES=yes', flush=True)
    if any(row.get('errorCode') for row in queued):
        print('CATALOG_SKUS_REQUIRE_REVIEW=' + json.dumps([row for row in queued if row.get('errorCode')], separators=(',', ':')), flush=True)
    if previous and previous['failed']:
        print('CATALOG_FAILED_RUNS=' + json.dumps([{'id': run['id'], 'productId': run['productId'], 'code': run.get('errorCode')} for run in selected if run['status'] == 'failed'], separators=(',', ':')), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error)
        print(message if message.startswith(('CATALOG_', 'INTERNAL_API_')) and len(message) < 120 else 'CATALOG_PREPARATION_FAILED', file=sys.stderr)
        sys.exit(1)
