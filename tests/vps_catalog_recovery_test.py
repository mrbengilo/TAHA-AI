import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
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
        for code in ('OPENAI_BILLING_ERROR', 'PRODUCT_MEDIA_MISMATCH'):
            with self.assertRaises(RuntimeError):
                recovery.validate_run_contract([{**safe, 'error_code': code}], ids)
        for code in ('GOOGLE_WRITE_SCOPE_REQUIRED', 'CONNECTION_NOT_FOUND', 'OPENAI_RATE_LIMITED'):
            recovery.validate_run_contract([{**safe, 'error_code': code}], ids)

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
            {'id': 'run-2', 'status': 'failed', 'error_code': 'CONNECTION_NOT_FOUND'},
            {'id': 'run-3', 'status': 'failed', 'error_code': 'OPENAI_RATE_LIMITED'},
        ]), ['run-1', 'run-2', 'run-3'])
        with self.assertRaises(RuntimeError):
            recovery.retryable_ids([{'id': 'run-4', 'status': 'failed', 'error_code': 'OPENAI_BILLING_ERROR'}])

    def test_durable_resumed_run_is_never_retried_again(self):
        for status in ('queued', 'processing', 'completed'):
            self.assertEqual(recovery.replay_action({'status': status}, True), 'skip')
        with self.assertRaisesRegex(RuntimeError, 'CATALOG_RECOVERY_RESUMED_RUN_FAILED'):
            recovery.replay_action({'status': 'failed', 'error_code': 'OPENAI_RATE_LIMITED'}, True)
        self.assertEqual(recovery.replay_action(
            {'status': 'failed', 'error_code': 'OPENAI_RATE_LIMITED'}, False), 'retry')
        self.assertEqual(recovery.replay_action({'status': 'processing'}, False), 'record')

    def test_recovery_marker_ids_are_bounded_to_the_catalog(self):
        catalog = ['run-1', 'run-2']
        planned = {'runIds': catalog, 'retryIds': ['run-1'], 'resumedIds': [], 'stage': 'planned'}
        self.assertEqual(recovery.validate_recovery_marker(planned, catalog), (['run-1'], []))
        for change in ({'retryIds': ['other']}, {'retryIds': ['run-1', 'run-1']},
                       {'retryIds': ['run-1', 'run-2'], 'resumedIds': ['run-2']},
                       {'resumedIds': ['run-2']}, {'runIds': list(reversed(catalog))}):
            with self.assertRaises(RuntimeError):
                recovery.validate_recovery_marker({**planned, **change}, catalog)
        with self.assertRaises(RuntimeError):
            recovery.validate_recovery_marker(
                {**planned, 'stage': 'applied', 'resumedIds': []}, catalog)

    def test_google_verifier_can_refresh_an_expired_access_token(self):
        source = Path(recovery.__file__).read_text()
        self.assertIn("credentials.refreshToken", source)
        self.assertIn("https://oauth2.googleapis.com/token'", source)
        self.assertIn("grant_type:'refresh_token'", source)

    def test_held_cron_requires_exact_applied_conflict_resolution(self):
        catalog_ids = ['catalog-run']
        with tempfile.TemporaryDirectory() as folder:
            database = Path(folder) / 'db.sqlite'
            marker = Path(folder) / 'resolution.json'
            with sqlite3.connect(database) as db:
                db.executescript('''
                    CREATE TABLE products(id TEXT, workspace_id TEXT, base_sku TEXT);
                    CREATE TABLE automation_runs(id TEXT, workspace_id TEXT, product_id TEXT, status TEXT);
                    CREATE TABLE content_drafts(workspace_id TEXT, generation_meta_json TEXT);
                    CREATE TABLE schedules(id TEXT, workspace_id TEXT, created_by TEXT);
                    CREATE TABLE publish_jobs(workspace_id TEXT, schedule_id TEXT);
                ''')
                for index, (run_id, sku) in enumerate(recovery.RESOLVED_CONFLICTS.items()):
                    product_id = f'product-{index}'
                    db.execute('INSERT INTO products VALUES(?,?,?)', (product_id, recovery.WORKSPACE, sku))
                    db.execute('INSERT INTO automation_runs VALUES(?,?,?,?)',
                               (run_id, recovery.WORKSPACE, product_id, 'cancelled'))
            marker.write_text(json.dumps({'stage': 'applied', 'catalogRunIds': catalog_ids,
                                          'runIds': list(recovery.RESOLVED_CONFLICTS)}))
            marker.chmod(0o600)
            original_marker = recovery.RESOLUTION
            original_competing = recovery.competing_active_runs
            recovery.RESOLUTION = marker
            recovery.competing_active_runs = lambda *_: []
            try:
                self.assertTrue(recovery.validate_conflict_resolution(database, catalog_ids))
                with sqlite3.connect(database) as db:
                    db.execute("UPDATE automation_runs SET status='queued' WHERE id=?",
                               (next(iter(recovery.RESOLVED_CONFLICTS)),))
                with self.assertRaisesRegex(RuntimeError, 'CATALOG_CONFLICT_RESOLUTION_INVALID'):
                    recovery.validate_conflict_resolution(database, catalog_ids)
            finally:
                recovery.RESOLUTION = original_marker
                recovery.competing_active_runs = original_competing


if __name__ == '__main__': unittest.main()
