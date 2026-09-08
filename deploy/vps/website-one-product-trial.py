"""Bounded PH0015 trial using its original key; no global cron tick or direct DB writes.

Default mode only checks whether a trial can proceed. --apply queues/resumes the
same request after state checks. Ambiguous outcomes require read-only diagnosis.
"""
import argparse
import importlib.util
import json
import re
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, build_opener

_spec = importlib.util.spec_from_file_location('website_repair', Path(__file__).with_name('website-runtime-repair.py'))
repair = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(repair)
require = repair.require
GuardError = repair.GuardError

PRODUCT = '03052129-8a8e-4695-b68a-f5442d50a6bd'
CONNECTION = 'de367230-7460-4964-ba4c-5754819efce6'
KEY = 'owner-website-trial-PH0015-2026-09-08-v1'
TRIAL_INPUT = {'productId': PRODUCT, 'imageCount': 0, 'targetProviders': ['website'],
               'connectionIds': {'website': CONNECTION}, 'idempotencyKey': KEY, 'prepareOnly': False}


def exact_receipt(job):
    post_id = job.get('external_post_id')
    require(isinstance(post_id, str) and re.fullmatch(r'[0-9a-f]{24}', post_id) is not None,
            'WEBSITE_TRIAL_RECEIPT_ID_INVALID')
    expected_url = 'https://tahashoes.vn/product/' + post_id
    if 'external_url' in job:
        require(job['external_url'] == expected_url, 'WEBSITE_TRIAL_RECEIPT_URL_INVALID')
    else:
        require(job.get('hasPublicProductUrl') == 1, 'WEBSITE_TRIAL_RECEIPT_URL_INVALID')
    return {'sku': 'PH0015', 'id': post_id, 'url': expected_url}


def decision(state):
    require(state.get('backfillEnabled') is False,
            'WEBSITE_TRIAL_BACKFILL_NOT_DISABLED')
    require(len(state.get('dailyWebsiteConnections', [])) == 1
            and state['dailyWebsiteConnections'][0].get('count') == 0,
            'WEBSITE_TRIAL_DAILY_WEBSITE_AUTOMATION_ACTIVE')
    products = state.get('products', [])
    require(len(products) == 1 and products[0].get('id') == PRODUCT
            and products[0].get('base_sku') == 'PH0015' and products[0].get('status') == 'active',
            'WEBSITE_TRIAL_PRODUCT_CHANGED')
    connections = state.get('connection', [])
    require(len(connections) == 1 and connections[0].get('id') == CONNECTION
            and connections[0].get('provider') == 'website' and connections[0].get('status') == 'connected'
            and connections[0].get('publish_mode') == 'api' and connections[0].get('hasCredentials') == 1
            and connections[0].get('endpointMatches') == 1, 'WEBSITE_TRIAL_CONNECTION_CHANGED')
    require(all(isinstance(state.get(field), list) and len(state[field]) < 30
                for field in ('runs', 'jobs', 'schedules')), 'WEBSITE_TRIAL_STATE_TRUNCATED_OR_UNKNOWN')
    runs = [row for row in state['runs'] if row.get('isExactTrialKey') == 1]
    require(len(runs) <= 1, 'WEBSITE_TRIAL_KEY_AMBIGUOUS')
    for row in state['runs']:
        if row.get('isExactTrialKey') != 1:
            require(row.get('status') not in ('queued', 'processing') and row.get('websiteOnly') == 0,
                    'WEBSITE_TRIAL_OTHER_AUTOMATION_EXISTS')
    require(all(row.get('isExactTrialKey') == 1 and row.get('connection_id') == CONNECTION
                for row in state['jobs']), 'WEBSITE_TRIAL_OTHER_PUBLICATION_EXISTS')
    require(all(row.get('isExactTrialKey') == 1 for row in state['schedules']),
            'WEBSITE_TRIAL_OTHER_SCHEDULE_EXISTS')
    require(len(state['jobs']) <= 1 and len(state['schedules']) <= 1, 'WEBSITE_TRIAL_MULTIPLE_PUBLICATIONS')
    run = runs[0] if runs else None
    if not run:
        require(not state['jobs'] and not state['schedules'], 'WEBSITE_TRIAL_ORPHAN_PUBLICATION')
        repair.guard_no_backlog(state)
        return 'create', None, None
    require(run.get('product_id') == PRODUCT and run.get('websiteOnly') == 1
            and run.get('requested_image_count') == 0 and run.get('completed_image_count') == 0
            and run.get('connectionMatches') == 1 and run.get('prepareOnly') == 0,
            'WEBSITE_TRIAL_KEY_REQUEST_MISMATCH')
    require(run.get('status') in ('queued', 'processing', 'completed'), 'WEBSITE_TRIAL_RUN_STOPPED')
    if state['jobs']:
        job = state['jobs'][0]
        if job.get('status') == 'published':
            return 'published', run['id'], exact_receipt(job)
        # Do not requeue/alter any request whose publication may already have been attempted.
        require(job.get('status') == 'queued' and job.get('attempt_count') == 0
                and not job.get('external_post_id') and job.get('hasPublicProductUrl') == 0,
                'WEBSITE_TRIAL_PUBLICATION_UNCERTAIN_REVIEW_RECEIVER')
    for field, expected in (
        ('activeWebsiteRuns', int(run['status'] in ('queued', 'processing'))),
        ('activeWebsiteSchedules', sum(row.get('status') == 'active' for row in state['schedules'])),
    ):
        require(len(state.get(field, [])) == 1 and state[field][0].get('count') == expected,
                'WEBSITE_TRIAL_OTHER_ACTIVE_WORK')
    for row in state.get('websiteJobsByStatus', []):
        require(row.get('status') in repair.ACTIVE_JOBS | {'published', 'blocked', 'failed', 'cancelled'},
                'WEBSITE_TRIAL_UNKNOWN_JOB_STATUS')
        if row['status'] in repair.ACTIVE_JOBS:
            expected = sum(job.get('status') == row['status'] for job in state['jobs'])
            require(row.get('count') == expected, 'WEBSITE_TRIAL_OTHER_ACTIVE_WORK')
    return 'resume', run['id'], None


def internal_secret():
    source = b"import {readFileSync} from 'node:fs'; import {parseEnv} from 'node:util'; const s=parseEnv(readFileSync('/app/.dev.vars','utf8')).INTERNAL_API_SECRET; if(typeof s!=='string'||s.length<24||s.length>512||/[\\r\\n]/.test(s))process.exit(2); process.stdout.write(s);"
    return repair.private_command(['docker', 'exec', '-i', 'taha-ai', 'node', '--input-type=module'], data=source).decode()


def api(secret, path, payload=None):
    request = Request('http://127.0.0.1:8787' + path,
                      data=None if payload is None else json.dumps(payload).encode(),
                      headers={'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json'})
    try:
        with build_opener(repair.NoRedirect).open(request, timeout=150) as response:
            result = json.load(response)
            require(isinstance(result, dict) and isinstance(result.get('data'), dict), 'WEBSITE_TRIAL_API_SHAPE_CHANGED')
            return result['data']
    except HTTPError as error:
        # Error body is deliberately not logged or retried.
        raise GuardError('WEBSITE_TRIAL_API_FAILED_' + str(error.code)) from None
    except GuardError:
        raise
    except Exception:
        raise GuardError('WEBSITE_TRIAL_API_OUTCOME_UNKNOWN_READ_STATE_BEFORE_RETRY') from None


def validate_run(run, run_id):
    require(run.get('id') == run_id and run.get('productId') == PRODUCT
            and run.get('targetProviders') == ['website'] and run.get('requestedImageCount') == 0
            and run.get('completedImageCount') == 0, 'WEBSITE_TRIAL_RUN_IDENTITY_CHANGED')
    require(all(step.get('step_type') != 'image' for step in run.get('steps', [])),
            'WEBSITE_TRIAL_IMAGE_GENERATION_UNEXPECTED')
    require(all(row.get('provider') == 'website' for row in run.get('schedules', [])),
            'WEBSITE_TRIAL_NON_WEBSITE_SCHEDULE')
    require(all(row.get('target_provider') == 'website' for row in run.get('drafts', [])),
            'WEBSITE_TRIAL_NON_WEBSITE_DRAFT')
    require(len(run.get('jobs', [])) <= 1 and len(run.get('schedules', [])) <= 1,
            'WEBSITE_TRIAL_DUPLICATE_OUTPUT')


def main(apply=False):
    action, run_id, receipt = decision(repair.state_snapshot())
    if action == 'published':
        print('WEBSITE_TRIAL_ALREADY_PUBLISHED=' + json.dumps(receipt))
        return
    if not apply:
        print('WEBSITE_TRIAL_CHECK=' + action + '; no automation or publication changed')
        return
    secret = internal_secret()
    # Re-read immediately before the only creation request; request_key remains the DB uniqueness authority.
    action, run_id, receipt = decision(repair.state_snapshot())
    if action == 'published':
        print('WEBSITE_TRIAL_ALREADY_PUBLISHED=' + json.dumps(receipt))
        return
    if action == 'create':
        initial = api(secret, '/api/automation-runs', TRIAL_INPUT)
        run_id = initial.get('run', {}).get('id')
        require(isinstance(run_id, str) and re.fullmatch(r'[0-9a-f-]{36}', run_id) is not None,
                'WEBSITE_TRIAL_QUEUE_RECEIPT_UNKNOWN')
        validate_run(initial['run'], run_id)
    print('WEBSITE_TRIAL_RUN_ID=' + run_id, flush=True)
    previous = None
    delivery_attempted = False
    deadline = time.monotonic() + 12 * 60
    while time.monotonic() < deadline:
        run = api(secret, '/api/automation-runs/' + run_id)['run']
        validate_run(run, run_id)
        jobs = run.get('jobs', [])
        state = {'run': run.get('status'), 'jobs': [job.get('status') for job in jobs]}
        require(run.get('status') in ('queued', 'processing', 'completed'), 'WEBSITE_TRIAL_AUTOMATION_STOPPED')
        require(all(job.get('status') in ('queued', 'publishing', 'published') for job in jobs),
                'WEBSITE_TRIAL_PUBLICATION_STOPPED_OR_UNCERTAIN')
        if state != previous:
            print('WEBSITE_TRIAL_STATE=' + json.dumps(state), flush=True)
            previous = state
        if jobs and jobs[0]['status'] == 'published':
            receipt = exact_receipt(jobs[0])
            final_action, final_id, final_receipt = decision(repair.state_snapshot())
            require(final_action == 'published' and final_id == run_id and final_receipt == receipt,
                    'WEBSITE_TRIAL_FINAL_STATE_MISMATCH')
            print('WEBSITE_TRIAL_PUBLISHED=' + json.dumps(receipt), flush=True)
            return
        if run['status'] in ('queued', 'processing'):
            api(secret, '/api/internal/automation/tick', {'runIds': [run_id]})
        elif not jobs or jobs[0]['status'] == 'queued':
            require(not delivery_attempted, 'WEBSITE_TRIAL_DELIVERY_NOT_CONFIRMED_READ_STATE')
            delivery_attempted = True
            result = api(secret, '/api/internal/website/deliver', {'runId': run_id})
            require(result.get('runId') == run_id and result.get('job', {}).get('status') == 'published',
                    'WEBSITE_TRIAL_DELIVERY_NOT_CONFIRMED_READ_STATE')
            exact_receipt(result['job'])
        time.sleep(8)
    raise GuardError('WEBSITE_TRIAL_TIMEOUT_READ_STATE_BEFORE_RETRY')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    try:
        main(parser.parse_args().apply)
    except GuardError as error:
        sys.exit(str(error))
    except Exception:
        sys.exit('WEBSITE_TRIAL_FAILED_WITHOUT_SAFE_DETAIL')
