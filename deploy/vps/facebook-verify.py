"""Refresh readiness for the existing trial destination; never create or retry a post."""
import json
from pathlib import Path
import subprocess
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

settings = {}
for line in Path('/etc/taha-ai/.dev.vars').read_text().splitlines():
    key, sep, value = line.partition('=')
    if sep:
        settings[key.strip()] = value.strip().strip('"\'')
secret = settings.get('INTERNAL_API_SECRET')
if not secret:
    sys.exit('INTERNAL_API_SECRET_MISSING')

sql = """SELECT DISTINCT s.connection_id FROM schedules s
JOIN automation_runs r ON s.created_by='automation:' || r.id AND s.workspace_id=r.workspace_id
JOIN channel_connections c ON c.id=s.connection_id AND c.workspace_id=s.workspace_id
WHERE r.request_key='trial:drive-only-facebook-v2' AND c.provider='facebook'
AND r.workspace_id='00000000-0000-4000-8000-000000000001'"""
try:
    completed = subprocess.run(['docker', 'exec', 'taha-ai', 'pnpm', 'exec', 'wrangler', 'd1', 'execute', 'DB',
                                '--local', '--persist-to=/data', '--config=/app/wrangler.vps.jsonc',
                                '--json', '--command', sql], capture_output=True, text=True, timeout=45, check=True)
    rows = json.loads(completed.stdout)[0].get('results', [])
except (subprocess.SubprocessError, ValueError, IndexError, KeyError):
    sys.exit('FACEBOOK_VERIFY_LOOKUP_FAILED')
if not rows:
    print('FACEBOOK_VERIFY=NO_EXISTING_TRIAL')
for row in rows:
    request = Request('http://127.0.0.1:8787/api/integrations/facebook/verify', method='POST',
                      data=json.dumps({'connectionId': row['connection_id']}).encode(),
                      headers={'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json'})
    try:
        with urlopen(request, timeout=90) as response:
            result = json.load(response)['data']
    except HTTPError as error:
        sys.exit('FACEBOOK_VERIFY_API_HTTP=' + str(error.code))
    except (OSError, ValueError, KeyError):
        sys.exit('FACEBOOK_VERIFY_API_UNAVAILABLE')
    print('FACEBOOK_VERIFY=' + json.dumps({
        'ready': result.get('ready'), 'code': result.get('code'),
        'missingScopes': result.get('missingScopes', []),
    }, separators=(',', ':')), flush=True)
