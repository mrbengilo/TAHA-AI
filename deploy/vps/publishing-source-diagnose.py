"""Inspect only PH0027 source/version metadata; no credentials or full captions."""
import json
from pathlib import Path
import sqlite3

for path in Path('/var/lib/taha-ai').rglob('*.sqlite'):
    with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='products'").fetchone():
            continue
        product = db.execute("SELECT id,base_sku,name,metadata_json FROM products WHERE workspace_id='00000000-0000-4000-8000-000000000001' AND base_sku='PH0027'").fetchone()
        if not product:
            continue
        result = {'productId': product['id'], 'sku': product['base_sku'], 'sizes': json.loads(product['metadata_json']).get('website', {}).get('sizes')}
        result['runs'] = [dict(r) for r in db.execute("SELECT id,status,error_code,request_key,requested_image_count,completed_image_count FROM automation_runs WHERE product_id=? ORDER BY created_at DESC", [product['id']])]
        result['drafts'] = []
        for row in db.execute("SELECT id,status,title,body,version,platform_data_json,generation_meta_json FROM content_drafts WHERE product_id=? AND target_provider='facebook' ORDER BY created_at DESC", [product['id']]):
            data = json.loads(row['platform_data_json'])
            result['drafts'].append({'id': row['id'], 'status': row['status'], 'title': row['title'], 'version': row['version'],
                'sourceFingerprint': data.get('sourceFingerprint'), 'sourceImageCount': data.get('sourceImageCount'),
                'generatedImageCount': data.get('generatedImageCount'), 'imagePromptVersion': data.get('imagePromptVersion'),
                'runId': json.loads(row['generation_meta_json']).get('automationRunId'),
                'sizeLines': [line for line in row['body'].splitlines() if 'size' in line.lower() or 'Size' in line]})
        result['media'] = [dict(r) for r in db.execute("SELECT m.id,m.origin,m.status,m.storage_provider,m.byte_size,json_extract(m.metadata_json,'$.optimization.sourceFingerprint') AS optimizedFingerprint,json_extract(m.metadata_json,'$.generation.sourceFingerprint') AS generatedFingerprint FROM media_assets m JOIN product_media pm ON pm.media_id=m.id WHERE pm.product_id=?", [product['id']])]
        print('PH0027_SOURCE_STATE=' + json.dumps(result,ensure_ascii=False,separators=(',',':')))
        break
