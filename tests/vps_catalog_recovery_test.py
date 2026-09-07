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
        for count in range(5):
            candidate = {**safe, 'requested_image_count': count,
                         'prompt_version': 'taha-drive-only-v2' if count == 0 else 'taha-lifestyle-v3'}
            recovery.validate_run_contract([candidate], ids)
        for change in ({'content_json': json.dumps({'prepareOnly': False})},
                       {'request_key': 'daily:product'}, {'requested_image_count': 5},
                       {'requested_image_count': -1}):
            with self.assertRaises(RuntimeError): recovery.validate_run_contract([{**safe, **change}], ids)
        for code in ('OPENAI_BILLING_ERROR', 'PRODUCT_MEDIA_MISMATCH'):
            with self.assertRaises(RuntimeError):
                recovery.validate_run_contract([{**safe, 'error_code': code}], ids)
        for code in ('GOOGLE_WRITE_SCOPE_REQUIRED', 'CONNECTION_NOT_FOUND', 'OPENAI_RATE_LIMITED',
                     'GOOGLE_SYNC_IN_PROGRESS', 'PRODUCT_SOURCE_CHANGED', 'PRODUCT_MEDIA_CAP_CHANGED'):
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
            {'run_id': 'run-1', 'status': 'draft', 'total': 1, 'media_count': 6},
            {'run_id': 'run-2', 'status': 'draft', 'total': 1, 'media_count': 1},
        ], ids)
        for rows in ([{'run_id': 'run-1', 'status': 'draft', 'total': 1, 'media_count': 6}],
                     [{'run_id': 'run-1', 'status': 'approved', 'total': 1, 'media_count': 6},
                      {'run_id': 'run-2', 'status': 'draft', 'total': 1, 'media_count': 1}],
                     [{'run_id': 'run-1', 'status': 'draft', 'total': 1, 'media_count': 7},
                      {'run_id': 'run-2', 'status': 'draft', 'total': 1, 'media_count': 1}]):
            with self.assertRaises(RuntimeError): recovery.validate_final_drafts(rows, ids)

    def test_post_drain_retry_rechecks_the_exact_failure_code(self):
        self.assertEqual(recovery.retryable_ids([
            {'id': 'run-1', 'status': 'failed', 'error_code': 'GOOGLE_WRITE_SCOPE_REQUIRED'},
            {'id': 'run-2', 'status': 'failed', 'error_code': 'CONNECTION_NOT_FOUND'},
            {'id': 'run-3', 'status': 'failed', 'error_code': 'OPENAI_RATE_LIMITED'},
            {'id': 'run-4', 'status': 'failed', 'error_code': 'PRODUCT_SOURCE_CHANGED'},
            {'id': 'run-5', 'status': 'failed', 'error_code': 'PRODUCT_MEDIA_CAP_CHANGED'},
        ]), ['run-1', 'run-2', 'run-3', 'run-4', 'run-5'])
        with self.assertRaises(RuntimeError):
            recovery.retryable_ids([{'id': 'run-4', 'status': 'failed', 'error_code': 'OPENAI_BILLING_ERROR'}])

    def test_durable_resumed_run_routes_only_recoverable_failure_to_bounded_repair(self):
        for status in ('queued', 'processing', 'completed'):
            self.assertEqual(recovery.replay_action({'status': status}, True), 'skip')
        self.assertEqual(recovery.replay_action(
            {'status': 'failed', 'error_code': 'OPENAI_RATE_LIMITED'}, True), 'repair')
        with self.assertRaisesRegex(RuntimeError, 'CATALOG_RECOVERY_RESUMED_RUN_FAILED'):
            recovery.replay_action({'status': 'failed', 'error_code': 'OPENAI_BILLING_ERROR'}, True)
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

    def test_repair_marker_is_exact_and_bounded(self):
        catalog = ['run-1', 'run-2']
        with tempfile.TemporaryDirectory() as folder:
            marker = Path(folder) / 'repair.json'
            original = recovery.REPAIR
            recovery.REPAIR = marker
            try:
                self.assertEqual(recovery.repair_marker(catalog)['attempts'], {})
                marker.write_text(json.dumps({'runIds': catalog, 'attempts': {'run-1': 2}}))
                marker.chmod(0o600)
                self.assertEqual(recovery.repair_marker(catalog)['attempts'], {'run-1': 2})
                for value in ({'runIds': list(reversed(catalog)), 'attempts': {}},
                              {'runIds': catalog, 'attempts': {'other': 1}},
                              {'runIds': catalog, 'attempts': {'run-1': recovery.MAX_RECOVERY_RETRIES + 1}}):
                    marker.write_text(json.dumps(value)); marker.chmod(0o600)
                    with self.assertRaisesRegex(RuntimeError, 'CATALOG_REPAIR_MARKER_INVALID'):
                        recovery.repair_marker(catalog)
            finally:
                recovery.REPAIR = original

    def test_six_image_replan_marker_is_exact_and_crash_resumable(self):
        catalog = ['run-1', 'run-2']
        with tempfile.TemporaryDirectory() as folder:
            marker = Path(folder) / 'replan.json'
            original = recovery.REPLAN
            recovery.REPLAN = marker
            try:
                self.assertIsNone(recovery.replan_marker(catalog))
                value = {'runIds': catalog, 'stage': 'planned',
                         'states': {'run-1': 'cancelled', 'run-2': 'retried'}}
                marker.write_text(json.dumps(value)); marker.chmod(0o600)
                self.assertEqual(recovery.replan_marker(catalog), value)
                for invalid in (
                    {**value, 'runIds': list(reversed(catalog))},
                    {**value, 'states': {'run-1': 'unknown', 'run-2': 'retried'}},
                    {**value, 'stage': 'applied'},
                ):
                    marker.write_text(json.dumps(invalid)); marker.chmod(0o600)
                    with self.assertRaisesRegex(RuntimeError, 'CATALOG_REPLAN_MARKER_INVALID'):
                        recovery.replan_marker(catalog)
            finally:
                recovery.REPLAN = original

    def test_replan_retries_cancelled_run_and_recovers_after_retry_crash(self):
        catalog = ['run-1']
        with tempfile.TemporaryDirectory() as folder:
            original_marker = recovery.REPLAN
            original_reader = recovery.read_runs
            original_api = recovery.api
            recovery.REPLAN = Path(folder) / 'replan.json'
            state = {'status': 'cancelled', 'requested_image_count': 4}
            calls = []
            def rows(*_):
                return [{'id': 'run-1', 'product_id': 'product-1', 'base_sku': 'PH0001',
                         'status': state['status'], 'error_code': None,
                         'requested_image_count': state['requested_image_count'],
                         'completed_image_count': 0, 'output_media_ids_json': '[]'}]
            def fake_api(_secret, path, _body):
                calls.append(path)
                state.update(status='processing', requested_image_count=0)
                return {'requestedImageCount': 0}
            recovery.read_runs = rows
            recovery.api = fake_api
            try:
                value = {'runIds': catalog, 'stage': 'planned', 'states': {'run-1': 'cancelled'}}
                recovery.REPLAN.write_text(json.dumps(value)); recovery.REPLAN.chmod(0o600)
                self.assertEqual(recovery.replan_catalog_runs('secret', 'db', catalog), {'PH0001': 0})
                self.assertEqual(calls, ['/api/automation-runs/run-1/retry'])
                saved = json.loads(recovery.REPLAN.read_text())
                self.assertEqual(saved['stage'], 'applied')
                self.assertEqual(saved['states'], {'run-1': 'retried'})

                # If retry committed but the marker update did not, a rerun records the
                # observed processing state and never sends a duplicate retry mutation.
                recovery.REPLAN.write_text(json.dumps(value)); recovery.REPLAN.chmod(0o600)
                calls.clear()
                recovery.replan_catalog_runs('secret', 'db', catalog)
                self.assertEqual(calls, [])
            finally:
                recovery.REPLAN = original_marker
                recovery.read_runs = original_reader
                recovery.api = original_api

    def test_google_verifier_can_refresh_an_expired_access_token(self):
        source = Path(recovery.__file__).read_text()
        self.assertIn("credentials.refreshToken", source)
        self.assertIn("https://oauth2.googleapis.com/token'", source)
        self.assertIn("grant_type:'refresh_token'", source)

    def test_catalog_is_driven_only_by_the_exact_filtered_worker(self):
        source = Path(recovery.__file__).read_text()
        self.assertFalse(recovery.PAUSED_FOR_MEDIA_CAP)
        self.assertIn(recovery.REVISION, recovery.IMAGE)
        self.assertRegex(recovery.IMAGE_ID, r'^sha256:[0-9a-f]{64}$')
        self.assertIn("'/api/internal/automation/tick', {'runIds': ids}", source)
        self.assertNotIn("'/api/internal/cron/tick'", source)
        self.assertNotIn('CATALOG_GENERATED_IMAGES_VERIFIED=60', source)
        self.assertIn('replan_catalog_runs(secret, database, ids)', source)
        self.assertGreaterEqual(recovery.WORKER_INTERVAL_SECONDS, 20)
        self.assertGreaterEqual(recovery.RECOVERY_RETRY_COOLDOWN_SECONDS, 60)
        self.assertLess(source.index("CATALOG_PREPARE_ONLY_FINAL_STATE_INVALID"),
                        source.rindex("['systemctl', 'start', 'taha-ai-cron.timer']"))

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
