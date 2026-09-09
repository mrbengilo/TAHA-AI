"""Refresh readiness for the existing trial destination; never create or retry a post."""
import json
from pathlib import Path
import subprocess
import sys
import time
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

sql = """SELECT j.connection_id FROM publish_jobs j
JOIN channel_connections c ON c.id=j.connection_id AND c.workspace_id=j.workspace_id
WHERE j.workspace_id='00000000-0000-4000-8000-000000000001'
AND c.provider='facebook' AND j.status='published' AND j.external_post_id IS NOT NULL
ORDER BY COALESCE(j.completed_at,j.updated_at) DESC LIMIT 1"""
rows = None
for attempt in range(6):
    try:
        completed = subprocess.run(['docker', 'exec', 'taha-ai', 'pnpm', 'exec', 'wrangler', 'd1', 'execute', 'DB',
                                    '--local', '--persist-to=/data', '--config=/app/wrangler.vps.jsonc',
                                    '--json', '--command', sql], capture_output=True, text=True, timeout=45, check=True)
        rows = json.loads(completed.stdout)[0].get('results', [])
        break
    except (subprocess.SubprocessError, ValueError, IndexError, KeyError):
        if attempt == 5:
            sys.exit('FACEBOOK_VERIFY_LOOKUP_FAILED')
        time.sleep(2)
if not rows:
    print('FACEBOOK_VERIFY=NO_PUBLISHED_DESTINATION')
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
