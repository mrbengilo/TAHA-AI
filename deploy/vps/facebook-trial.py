"""One authorized production post. Replays reuse the server's fixed rollout key."""
import json
from pathlib import Path
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


def api(path, method='GET'):
    request = Request('http://127.0.0.1:8787' + path, method=method,
                      data=b'{}' if method == 'POST' else None,
                      headers={'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json'})
    try:
        with urlopen(request, timeout=150) as response:
            return json.load(response)['data']
    except HTTPError as error:
        try:
            code = json.load(error).get('error', {}).get('code', 'HTTP_ERROR')
        except (ValueError, AttributeError):
            code = 'HTTP_ERROR'
        sys.exit(f'TRIAL_API_FAILED={error.code}:{code}')


initial = api('/api/automation-trial', 'POST')['run']
run_id = initial.get('id') or initial.get('run', {}).get('id')
if not run_id:
    sys.exit('TRIAL_RUN_ID_MISSING')
print('TRIAL_RUN_ID=' + run_id, flush=True)
deadline = time.monotonic() + 15 * 60
previous = None
while time.monotonic() < deadline:
    result = api('/api/automation-runs/' + run_id)['run']
    run = result.get('run', result)
    jobs = result.get('jobs', [])
    state = {'run': run.get('status'), 'jobs': [job.get('status') for job in jobs]}
    if state != previous:
        print('TRIAL_STATE=' + json.dumps(state, separators=(',', ':')), flush=True)
        previous = state
    if run.get('status') in ('failed', 'cancelled'):
        sys.exit('TRIAL_AUTOMATION_FAILED=' + str(run.get('errorCode') or run.get('error_code')))
    if any(draft.get('status') == 'rejected' for draft in result.get('drafts', [])):
        sys.exit('TRIAL_STOPPED_BY_ADMIN')
    published = [job for job in jobs if job.get('status') == 'published' and job.get('external_post_id')]
    if published:
        if len(published) != 1:
            sys.exit('TRIAL_UNEXPECTED_POST_COUNT')
        post = published[0]
        print('FACEBOOK_TRIAL_RECEIPT=' + json.dumps({
            'runId': run_id, 'sku': (run.get('content') or {}).get('sku'),
            'postId': post['external_post_id'], 'url': post.get('external_url'),
        }, ensure_ascii=False, separators=(',', ':')), flush=True)
        sys.exit(0)
    stopped = [job for job in jobs if job.get('status') in ('blocked', 'failed', 'cancelled', 'awaiting_confirmation')]
    if stopped:
        sys.exit('TRIAL_PUBLISH_BLOCKED=' + str(stopped[0].get('error_code')))
    time.sleep(15)
sys.exit('TRIAL_TIMEOUT_CHECK_CRON_AND_RUN=' + run_id)
