"""Read-only permission and runtime diagnosis; never print credentials."""
import json
from pathlib import Path
import sqlite3
import subprocess
from urllib.error import HTTPError
from urllib.request import Request, urlopen

settings = {}
for line in Path('/etc/taha-ai/.dev.vars').read_text().splitlines():
    key, sep, value = line.partition('=')
    if sep: settings[key.strip()] = value.strip().strip('"\'')
configured = settings.get('GOOGLE_OAUTH_SCOPES', '').split()
write_scopes = {'https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.file'}
print('GOOGLE_CONSENT_REQUESTS_WRITE=' + str(not configured or bool(write_scopes.intersection(configured))).lower())
for path in Path('/var/lib/taha-ai').rglob('*.sqlite'):
    with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='channel_connections'").fetchone(): continue
        for row in db.execute("SELECT status, scopes_json, last_error FROM channel_connections WHERE provider='google'"):
            scopes = json.loads(row['scopes_json'] or '[]')
            print('GOOGLE_PERMISSION_STATE=' + json.dumps({'status': row['status'], 'hasWrite': bool(write_scopes.intersection(scopes)), 'lastError': row['last_error']}, separators=(',', ':')))
        rows = [dict(row) for row in db.execute("SELECT p.base_sku AS sku, r.status, r.error_code AS code, r.completed_image_count AS images FROM automation_runs r JOIN products p ON p.id=r.product_id AND p.workspace_id=r.workspace_id WHERE r.request_key LIKE 'catalog:taha-lifestyle-v3:%' ORDER BY r.created_at")]
        print('CATALOG_RUN_STATE=' + json.dumps(rows, separators=(',', ':')))
result = subprocess.run(['docker', 'inspect', 'taha-ai', '--format', '{{.State.Status}}|{{.State.OOMKilled}}|{{.RestartCount}}|{{.Config.Image}}'], check=True, capture_output=True, text=True, timeout=15)
print('TAHA_RUNTIME=' + result.stdout.strip())
for authenticated in [False, True]:
    headers = {'Authorization': 'Bearer ' + settings['INTERNAL_API_SECRET']} if authenticated else {}
    request = Request('http://127.0.0.1:8787/api/integrations', headers=headers)
    try:
        with urlopen(request, timeout=15) as response: code = response.status
    except HTTPError as error: code = error.code
    except OSError: code = 'unavailable'
    print(('TAHA_AUTH_HTTP=' if authenticated else 'TAHA_UNAUTH_HTTP=') + str(code))
