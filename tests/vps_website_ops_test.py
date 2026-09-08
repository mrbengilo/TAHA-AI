"""Safety tests for the fixed website repair/trial scripts; no Docker/network required."""
import argparse
import contextlib
import copy
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(filename):
    spec = importlib.util.spec_from_file_location(filename.replace('-', '_'), ROOT / 'deploy/vps' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


repair = load('website-runtime-repair.py')
trial = load('website-one-product-trial.py')
diagnostic = load('website-runtime-diagnose.py')
SECRET = 'test$literal${NO_EXPANSION}#safe-value-1234567890'
RUN = '52e8a5a1-ce4d-4ef7-9f90-c1fa1af35222'


def state():
    return {
        'backfillEnabled': False, 'backfillExplicitlyDisabled': True,
        'products': [{'id': trial.PRODUCT, 'base_sku': 'PH0015', 'status': 'active'}],
        'connection': [{'id': trial.CONNECTION, 'provider': 'website', 'status': 'connected', 'publish_mode': 'api',
                        'hasCredentials': 1, 'endpointMatches': 1}],
        'runs': [], 'jobs': [], 'schedules': [], 'websiteJobsByStatus': [],
        'activeWebsiteSchedules': [{'count': 0}], 'activeWebsiteRuns': [{'count': 0}],
        'dailyWebsiteConnections': [{'count': 0}],
    }


def run_state(status='queued'):
    result = state()
    result['runs'] = [{'id': RUN, 'product_id': trial.PRODUCT, 'isExactTrialKey': 1, 'websiteOnly': 1,
                       'requested_image_count': 0, 'completed_image_count': 0,
                       'connectionMatches': 1, 'prepareOnly': 0, 'status': status}]
    result['activeWebsiteRuns'] = [{'count': int(status in ('queued', 'processing'))}]
    return result


class EnvSafetyTests(unittest.TestCase):
    def test_standalone_compose_v2_is_selected_and_pinned_when_plugin_is_missing(self):
        repair.compose_command.cache_clear()
        try:
            replies = [repair.subprocess.CompletedProcess([], 1, b'', b'plugin unavailable'),
                       repair.subprocess.CompletedProcess([], 0, b'2.24.5\n', b'')]
            with patch.object(repair.subprocess, 'run', side_effect=replies) as command:
                selected = repair.compose_command()
                self.assertEqual(selected[0], 'docker-compose')
                self.assertIn('tahashoes', selected)
                self.assertEqual(repair.compose_command(), selected)
                self.assertEqual(command.call_count, 2)
        finally:
            repair.compose_command.cache_clear()

    def test_legacy_compose_v1_is_not_used_for_json_config_or_recreation(self):
        repair.compose_command.cache_clear()
        try:
            replies = [repair.subprocess.CompletedProcess([], 1, b'', b''),
                       repair.subprocess.CompletedProcess([], 0, b'1.29.2\n', b'')]
            with patch.object(repair.subprocess, 'run', side_effect=replies):
                with self.assertRaisesRegex(repair.GuardError, 'COMPOSE_V2_UNAVAILABLE'):
                    repair.compose_command()
        finally:
            repair.compose_command.cache_clear()

    def test_dollar_comment_and_double_quote_are_literal_and_other_bytes_are_preserved(self):
        original = 'DATABASE_URL=keep-this-byte-for-byte\r\n# keep\r\nTAHA_WEBHOOK_SECRET=\r\nOTHER="untouched"\r\n'
        changed = repair.replace_secret(original, SECRET + '"')
        self.assertEqual(changed, original.replace('TAHA_WEBHOOK_SECRET=\r\n', "TAHA_WEBHOOK_SECRET='" + SECRET + '"' + "'\r\n"))
        self.assertEqual(repair.replace_secret(changed, SECRET + '"'), changed)

    def test_unsafe_or_ambiguous_secrets_are_refused(self):
        for secret in ['', 'x' * 23, 'x' * 513, SECRET + "'", SECRET + '\\', SECRET + '\n', SECRET + '\x00', ' ' + SECRET]:
            with self.subTest(secret_length=len(secret)):
                with self.assertRaises(repair.GuardError):
                    repair.replace_secret('OTHER=untouched\n', secret)

    def test_existing_different_duplicate_or_interpolated_secret_is_refused(self):
        for content in [
            'TAHA_WEBHOOK_SECRET=other-existing-secret\n',
            "TAHA_WEBHOOK_SECRET='${CURRENT_SECRET}'\n",
            'TAHA_WEBHOOK_SECRET=\nexport TAHA_WEBHOOK_SECRET=\n',
            'TAHA_WEBHOOK_SECRET: value\n',
        ]:
            with self.assertRaises(repair.GuardError):
                repair.replace_secret(content, SECRET)

    def test_atomic_write_restricts_mode_and_preserves_complete_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'backend.env'
            path.write_bytes(b'UNCHANGED=yes\n')
            os.chmod(path, 0o644)
            repair.atomic_write(path, b'UNCHANGED=yes\nNEW=literal\n', path.stat())
            self.assertEqual(path.read_bytes(), b'UNCHANGED=yes\nNEW=literal\n')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual([item.name for item in path.parent.iterdir()], ['backend.env'])

    def test_wrong_compose_wiring_rolls_back_before_recreating_container(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            env = folder / 'backend.env'
            original = b'OTHER=preserved\nTAHA_WEBHOOK_SECRET=\n'
            env.write_bytes(original)
            os.chmod(env, 0o640)
            container = {'Id': 'a' * 64, 'Image': 'sha256:' + 'b' * 64, 'State': {'Running': True},
                         'Config': {'Env': ['OTHER=preserved', 'TAHA_WEBHOOK_SECRET='], 'Image': 'tahashoes-backend',
                                    'Labels': {'com.docker.compose.project': 'tahashoes', 'com.docker.compose.service': 'backend',
                                               'com.docker.compose.project.working_dir': str(repair.BASE),
                                               'com.docker.compose.project.config_files': str(repair.COMPOSE_PATH)}}}
            baseline = {'services': {'backend': {'container_name': 'tahashoes-backend',
                                                'environment': {'OTHER': 'preserved', 'TAHA_WEBHOOK_SECRET': ''}}}}
            def command(args, **_kwargs):
                if 'sha256sum' in args:
                    return repair.ADAPTER_SHA.encode() + b' /app/handlers/product_receiver.go'
                if 'nm' in args:
                    return b'handlers.tryPublishWebsiteProduct'
                if '--input-type=module' in args:
                    return SECRET.encode()
                if 'image' in args:
                    return container['Image'].encode()
                raise AssertionError('Unexpected command')
            args = argparse.Namespace(expected_container_id=container['Id'], expected_image_id=container['Image'], apply=True)
            with contextlib.ExitStack() as stack:
                for key, value in [('ENV_PATH', env), ('BACKUP_ROOT', folder / 'backups'), ('LOCK_PATH', folder / 'repair.lock')]:
                    stack.enter_context(patch.object(repair, key, value))
                stack.enter_context(patch.object(repair, 'inspect', return_value=container))
                stack.enter_context(patch.object(repair, 'state_snapshot', return_value=state()))
                stack.enter_context(patch.object(repair, 'private_command', side_effect=command))
                stack.enter_context(patch.object(repair, 'resolved_config', return_value=baseline))
                recreate = stack.enter_context(patch.object(repair, 'recreate'))
                output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                with self.assertRaisesRegex(repair.GuardError, 'ROLLED_BACK'):
                    repair.main(args)
                self.assertNotIn(SECRET, output.getvalue())
                recreate.assert_not_called()
            self.assertEqual(env.read_bytes(), original)
            self.assertEqual(env.stat().st_mode & 0o777, 0o640)
            backups = list((folder / 'backups').glob('secret-*/backend.env'))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), original)
            self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)


class TrialSafetyTests(unittest.TestCase):
    def test_new_trial_and_same_key_resume_are_distinct_from_requeue(self):
        self.assertEqual(trial.decision(state()), ('create', None, None))
        self.assertEqual(trial.decision(run_state()), ('resume', RUN, None))
        self.assertEqual(trial.TRIAL_INPUT['imageCount'], 0)
        self.assertEqual(trial.TRIAL_INPUT['idempotencyKey'], 'owner-website-trial-PH0015-2026-09-08-v1')
        self.assertEqual(trial.TRIAL_INPUT['targetProviders'], ['website'])

    def test_backfill_enabled_unknown_flag_daily_automation_and_backlog_are_blocked(self):
        variants = []
        for enabled, explicit in [(True, False), (None, False)]:
            sample = state()
            sample.update(backfillEnabled=enabled, backfillExplicitlyDisabled=explicit)
            variants.append(sample)
        for field in ('activeWebsiteSchedules', 'activeWebsiteRuns', 'dailyWebsiteConnections'):
            sample = state()
            sample[field] = [{'count': 1}]
            variants.append(sample)
        sample = state()
        sample['websiteJobsByStatus'] = [{'status': 'retry_wait', 'count': 1}]
        variants.append(sample)
        for sample in variants:
            with self.assertRaises(Exception):
                trial.decision(sample)

    def test_unset_backfill_uses_verified_disabled_default_without_changing_state(self):
        sample = state()
        sample['backfillExplicitlyDisabled'] = False
        before = copy.deepcopy(sample)
        repair.guard_no_backlog(sample)
        self.assertEqual(trial.decision(sample), ('create', None, None))
        self.assertEqual(sample, before)

    def test_published_same_trial_returns_receipt_without_creating_another_run(self):
        sample = run_state('completed')
        sample['jobs'] = [{'isExactTrialKey': 1, 'connection_id': trial.CONNECTION, 'status': 'published',
                           'external_post_id': '507f1f77bcf86cd799439011', 'hasPublicProductUrl': 1}]
        action, run_id, receipt = trial.decision(sample)
        self.assertEqual((action, run_id), ('published', RUN))
        self.assertEqual(receipt['url'], 'https://tahashoes.vn/product/507f1f77bcf86cd799439011')
        with patch.object(trial.repair, 'state_snapshot', return_value=sample), patch.object(trial, 'api') as api:
            with contextlib.redirect_stdout(io.StringIO()):
                trial.main(True)
            api.assert_not_called()

    def test_uncertain_attempted_job_wrong_key_generated_images_and_duplicate_jobs_are_blocked(self):
        sample = run_state('completed')
        base_job = {'isExactTrialKey': 1, 'connection_id': trial.CONNECTION, 'status': 'queued',
                    'attempt_count': 0, 'hasPublicProductUrl': 0}
        for change in ({'status': 'retry_wait'}, {'attempt_count': 1}, {'isExactTrialKey': 0}, {'external_post_id': 'remote'}):
            sample['jobs'] = [{**base_job, **change}]
            with self.assertRaises(Exception):
                trial.decision(sample)
        sample['jobs'] = [base_job, copy.copy(base_job)]
        with self.assertRaises(Exception):
            trial.decision(sample)
        sample = run_state()
        sample['runs'][0]['requested_image_count'] = 1
        with self.assertRaises(Exception):
            trial.decision(sample)

    def test_completed_run_uses_only_scoped_delivery_while_cron_can_be_stopped(self):
        sample = run_state('completed')
        published = copy.deepcopy(sample)
        published['jobs'] = [{'isExactTrialKey': 1, 'connection_id': trial.CONNECTION, 'status': 'published',
                              'external_post_id': '507f1f77bcf86cd799439011', 'hasPublicProductUrl': 1}]
        public_run = {'id': RUN, 'productId': trial.PRODUCT, 'targetProviders': ['website'], 'requestedImageCount': 0,
                      'completedImageCount': 0, 'status': 'completed', 'jobs': [], 'steps': [], 'schedules': [], 'drafts': []}
        job = {'status': 'published', 'external_post_id': '507f1f77bcf86cd799439011',
               'external_url': 'https://tahashoes.vn/product/507f1f77bcf86cd799439011'}
        calls = []
        def api(_secret, path, payload=None):
            calls.append((path, payload))
            if path == '/api/internal/website/deliver':
                return {'runId': RUN, 'job': job}
            return {'run': {**public_run, 'jobs': [job] if len(calls) > 2 else []}}
        with patch.object(trial.repair, 'state_snapshot', side_effect=[sample, sample, published]), \
                patch.object(trial, 'internal_secret', return_value='private'), \
                patch.object(trial, 'api', side_effect=api), patch.object(trial.time, 'sleep'), \
                contextlib.redirect_stdout(io.StringIO()):
            trial.main(True)
        self.assertEqual([entry for entry in calls if entry[1] is not None],
                         [('/api/internal/website/deliver', {'runId': RUN})])


class DiagnosticSafetyTests(unittest.TestCase):
    def test_failed_section_keeps_prior_data_and_never_exposes_exception_message(self):
        result = {'sections': {}, 'containerId': 'known-container'}
        def failure():
            raise ValueError('secret-value-must-never-leak')
        with contextlib.redirect_stdout(io.StringIO()) as output:
            diagnostic.collect_section(result, 'compose', failure)
            diagnostic.collect_section(result, 'cron', lambda: {'cronTimerActive': False})
        self.assertEqual(result['containerId'], 'known-container')
        self.assertFalse(result['sections']['compose']['ok'])
        self.assertTrue(result['sections']['cron']['ok'])
        self.assertNotIn('secret-value', json.dumps(result) + output.getvalue())

    def test_null_compose_secret_reports_false(self):
        with patch.object(diagnostic, 'compose_cli', return_value=['docker', 'compose']), \
                patch.object(diagnostic, 'command', return_value=json.dumps({'services': {'backend': {'environment': {'TAHA_WEBHOOK_SECRET': None}}}}).encode()):
            self.assertFalse(diagnostic.compose_state()['composeResolvedSecretPresent'])


if __name__ == '__main__':
    unittest.main()
