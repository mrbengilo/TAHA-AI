"""Sync Google sources and fail closed unless every catalog SKU has exact sizes."""
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

WORKSPACE = '00000000-0000-4000-8000-000000000001'
REVISION = '4ef44959e6ffd29d966136922e3857c6a2119b86'
SKUS = ['PH0014', 'PH0015', 'PH0018', 'PH0020', 'PH0021', 'PH0022', 'PH0023', 'PH0024',
        'PH0027', 'PH0028', 'PH0029', 'PH0058', 'PH0059', 'PH0060', 'PH0072']


def command(*args, check=True, timeout=45):
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=timeout)


def secret():
    for line in Path('/etc/taha-ai/.dev.vars').read_text().splitlines():
        key, sep, value = line.partition('=')
        if sep and key.strip() == 'INTERNAL_API_SECRET':
            result = value.strip().strip('\"\'')
            if result:
                return result
    raise RuntimeError('SKU_SIZE_INTERNAL_SECRET_MISSING')


def sync_sources(token):
    request = Request('http://127.0.0.1:8787/api/integrations/google/sync', method='POST', data=b'{}',
                      headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        with urlopen(request, timeout=180) as response:
            payload = json.load(response)
    except HTTPError as error:
        raise RuntimeError('SKU_SIZE_GOOGLE_SYNC_HTTP_' + str(error.code)) from None
    except (OSError, ValueError):
        raise RuntimeError('SKU_SIZE_GOOGLE_SYNC_UNAVAILABLE') from None
    data = payload.get('data')
    if not isinstance(data, dict):
        raise RuntimeError('SKU_SIZE_GOOGLE_SYNC_INVALID')
    return {key: data.get(key) for key in ('products', 'media', 'skippedMedia', 'productsWithoutImages',
                                            'matchedSkuFolders', 'unmatchedRootImages', 'syncedAt')}


def database():
    placeholders = ','.join('?' for _ in SKUS)
    for path in Path('/var/lib/taha-ai').rglob('*.sqlite'):
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {'products', 'product_media', 'media_assets'}.issubset(tables):
                continue
            count = db.execute(
                f"SELECT count(*) FROM products WHERE workspace_id=? AND base_sku IN ({placeholders}) "
                "AND deleted_at IS NULL", [WORKSPACE, *SKUS],
            ).fetchone()[0]
            if count == len(SKUS):
                return path
    raise RuntimeError('SKU_SIZE_DATABASE_MISSING')


def rows(path):
    placeholders = ','.join('?' for _ in SKUS)
    with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        values = db.execute(
            f"SELECT p.id,p.base_sku,p.name,p.metadata_json,count(DISTINCT m.id) AS images "
            f"FROM products p LEFT JOIN product_media pm ON pm.product_id=p.id AND pm.workspace_id=p.workspace_id "
            f"LEFT JOIN media_assets m ON m.id=pm.media_id AND m.workspace_id=p.workspace_id AND m.status='ready' "
            f"WHERE p.workspace_id=? AND p.base_sku IN ({placeholders}) AND p.deleted_at IS NULL "
            f"GROUP BY p.id,p.base_sku,p.name,p.metadata_json ORDER BY p.base_sku",
            [WORKSPACE, *SKUS],
        ).fetchall()
    result = []
    for value in values:
        try:
            metadata = json.loads(value['metadata_json'] or '{}')
        except ValueError:
            metadata = {}
        website = metadata.get('website') if isinstance(metadata.get('website'), dict) else {}
        sizes = website.get('sizes') if isinstance(website.get('sizes'), list) else []
        colors = website.get('colors') if isinstance(website.get('colors'), list) else []
        result.append({'productId': value['id'], 'sku': value['base_sku'], 'name': value['name'],
                       'sizes': [str(item) for item in sizes], 'colors': [str(item) for item in colors],
                       'images': int(value['images'])})
    return result


def main():
    runtime = command('docker', 'inspect', 'taha-ai', '--format',
                      '{{.Config.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.State.Status}}').stdout.strip()
    if runtime != 'tahashoes-taha-ai:' + REVISION + '|' + REVISION + '|running':
        raise RuntimeError('SKU_SIZE_PRODUCTION_REVISION_MISMATCH')
    if command('systemctl', 'is-active', '--quiet', 'taha-ai-cron.timer', check=False).returncode == 0:
        raise RuntimeError('SKU_SIZE_CRON_MUST_REMAIN_INACTIVE')
    sync = sync_sources(secret())
    products = rows(database())
    missing_sizes = [item['sku'] for item in products if not item['sizes']]
    missing_images = [item['sku'] for item in products if item['images'] < 1]
    print('SKU_SIZE_SYNC=' + json.dumps({'sync': sync, 'products': products,
          'missingSizes': missing_sizes, 'missingImages': missing_images, 'cronTimer': 'inactive'},
          ensure_ascii=False, separators=(',', ':')), flush=True)
    if missing_sizes:
        raise RuntimeError('SKU_SIZE_VALUES_REQUIRED')
    if missing_images:
        raise RuntimeError('SKU_SOURCE_IMAGES_REQUIRED')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error)
        print(message if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', message) else 'SKU_SIZE_INSPECTION_FAILED', file=sys.stderr)
        raise SystemExit(1)
