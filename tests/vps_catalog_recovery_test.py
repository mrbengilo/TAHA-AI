import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).resolve().parents[1] / 'deploy/vps/resume-catalog.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class CatalogRecoverySafetyTests(unittest.TestCase):
    def test_requires_exactly_fifteen_unique_run_ids(self):
        ids = [f'00000000-0000-4000-8000-{index:012d}' for index in range(15)]
        self.assertEqual(recovery.marker_run_ids({'products': [{'runId': value} for value in ids]}), ids)
        for products in ([{'runId': value} for value in ids[:-1]], [{'runId': ids[0]}] * 15):
            with self.assertRaises(RuntimeError): recovery.marker_run_ids({'products': products})

    def test_retry_contract_rejects_any_publish_capable_run(self):
        ids = ['00000000-0000-4000-8000-000000000001']
        safe = {'id': ids[0], 'request_key': 'catalog:taha-lifestyle-v3:product:hash',
                'requested_image_count': 4, 'prompt_version': 'taha-lifestyle-v3',
                'content_json': json.dumps({'prepareOnly': True, 'targetConnections': {}}),
                'target_providers_json': json.dumps(['facebook']), 'status': 'failed',
                'error_code': 'GOOGLE_WRITE_SCOPE_REQUIRED'}
        recovery.validate_run_contract([safe], ids)
        for change in ({'content_json': json.dumps({'prepareOnly': False})},
                       {'request_key': 'daily:product'}, {'requested_image_count': 3}):
            with self.assertRaises(RuntimeError): recovery.validate_run_contract([{**safe, **change}], ids)
        with self.assertRaises(RuntimeError):
            recovery.validate_run_contract([{**safe, 'error_code': 'OPENAI_BILLING_ERROR'}], ids)
        with self.assertRaises(RuntimeError):
            recovery.validate_run_contract([{**safe, 'error_code': 'CONNECTION_NOT_FOUND'}], ids)

    def test_original_media_may_remain_safe_web_format_but_generated_media_is_jpeg(self):
        for value in ('image/jpeg', 'image/png', 'image/webp'):
            self.assertTrue(recovery.media_type_allowed(value, False))
        self.assertFalse(recovery.media_type_allowed('image/gif', False))
        self.assertTrue(recovery.media_type_allowed('image/jpeg', True))
        self.assertFalse(recovery.media_type_allowed('image/png', True))

    def test_final_state_requires_one_draft_for_every_run(self):
        ids = ['run-1', 'run-2']
        recovery.validate_final_drafts([
            {'run_id': 'run-1', 'status': 'draft', 'total': 1},
            {'run_id': 'run-2', 'status': 'draft', 'total': 1},
        ], ids)
        for rows in ([{'run_id': 'run-1', 'status': 'draft', 'total': 1}],
                     [{'run_id': 'run-1', 'status': 'approved', 'total': 1},
                      {'run_id': 'run-2', 'status': 'draft', 'total': 1}]):
            with self.assertRaises(RuntimeError): recovery.validate_final_drafts(rows, ids)

    def test_post_drain_retry_rechecks_the_exact_failure_code(self):
        self.assertEqual(recovery.retryable_ids([
            {'id': 'run-1', 'status': 'failed', 'error_code': 'GOOGLE_WRITE_SCOPE_REQUIRED'},
            {'id': 'run-2', 'status': 'processing', 'error_code': None},
        ]), ['run-1'])
        with self.assertRaises(RuntimeError):
            recovery.retryable_ids([{'id': 'run-2', 'status': 'failed', 'error_code': 'OPENAI_RATE_LIMIT'}])


if __name__ == '__main__': unittest.main()
