"""Read-only catalog verification; optionally export the PH0014 review images."""
import io
import json
from pathlib import Path
import sqlite3
import sys
import time
from urllib.request import Request, urlopen
import zipfile

PRODUCT = 'f71003d5-0009-42d8-8ea2-d94496fa3758'
MARKER = Path('/var/lib/taha-ai/ops-recovery/catalog-lifestyle-v3.json')


def status():
    if not MARKER.exists(): return {'state': 'waiting_for_preparation'}
    data = json.loads(MARKER.read_text())
    ids = {item['runId'] for item in data.get('products', []) if item.get('runId')}
    for path in Path('/var/lib/taha-ai').rglob('*.sqlite'):
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
            db.row_factory = sqlite3.Row
            if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='automation_runs'").fetchone(): continue
            rows = [dict(row) for row in db.execute("SELECT id, product_id, status, completed_image_count, error_code FROM automation_runs") if row['id'] in ids]
            data['runs'] = rows
            data['state'] = 'prepared'
            data['completed'] = sum(row['status'] == 'completed' for row in rows)
            data['generatedImages'] = sum(row['completed_image_count'] for row in rows)
            return data
    raise RuntimeError('CATALOG_DATABASE_MISSING')


def export_pilot(data):
    secret = None
    for line in Path('/etc/taha-ai/.dev.vars').read_text().splitlines():
        key, sep, value = line.partition('=')
        if sep and key.strip() == 'INTERNAL_API_SECRET': secret = value.strip().strip('"\'')
    if not secret: raise RuntimeError('INTERNAL_API_SECRET_MISSING')

    def download(route, ceiling):
        if not route.startswith('/api/') or '://' in route: raise RuntimeError('CATALOG_REVIEW_ROUTE_INVALID')
        request = Request('http://127.0.0.1:8787' + route, headers={'Authorization': 'Bearer ' + secret})
        with urlopen(request, timeout=90) as response: content = response.read(ceiling + 1)
        if not content or len(content) >= ceiling: raise RuntimeError('CATALOG_REVIEW_SIZE_INVALID')
        return content

    folder = json.loads(download('/api/products/' + PRODUCT, 1000000))['data']
    if folder['product']['base_sku'] != 'PH0014' or len(folder['generatedImages']) != 4:
        raise RuntimeError('CATALOG_REVIEW_SKU_MISMATCH')
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('verification.json', json.dumps(data, ensure_ascii=False, indent=2))
        for image in folder['generatedImages']:
            if image['variant'] not in ['cycling', 'running', 'climbing', 'stream']: raise RuntimeError('CATALOG_REVIEW_VARIANT_INVALID')
            archive.writestr('PH0014-' + image['variant'] + '.jpg', download(image['previewUrl'], 200000))
        archive.writestr('PH0014-source.jpg', download(folder['images'][0]['previewUrl'], 300000))
    sys.stdout.buffer.write(output.getvalue())


def main():
    pilot = '--pilot' in sys.argv
    deadline = time.monotonic() + (12 * 60 if pilot else 30 * 60)
    while time.monotonic() < deadline:
        data = status()
        rows = data.get('runs', [])
        selected = next((row for row in rows if row['product_id'] == PRODUCT), None)
        if pilot and selected and selected['status'] in ('failed', 'cancelled'):
            print('CATALOG_PILOT_FAILED=' + str(selected.get('error_code')), file=sys.stderr, flush=True)
            return 2
        if pilot and PRODUCT in data.get('verified', {}):
            export_pilot(data)
            return 0
        if not pilot and rows and all(row['status'] in ('completed', 'failed', 'cancelled') for row in rows):
            print(json.dumps(data, ensure_ascii=False))
            return 0
        time.sleep(10)
    if pilot:
        print('CATALOG_PILOT_PENDING=' + json.dumps(data, ensure_ascii=False), file=sys.stderr)
        return 3
    print(json.dumps(data, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    try: sys.exit(main())
    except Exception:
        print('CATALOG_STATUS_UNAVAILABLE', file=sys.stderr)
        sys.exit(1)
