import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location(
    'facebook_stale_fingerprint_recovery',
    ROOT / 'deploy/vps/facebook-stale-fingerprint-recovery.py',
)
recovery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recovery)


class JsonResponse:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps({'data': {'dispatcher': {'published': 1, 'errors': []}}}).encode()


class FacebookStaleFingerprintRecoveryTests(unittest.TestCase):
    def test_changed_release_is_rejected_before_runtime_access(self):
        with patch.object(recovery, 'command', return_value=b'b' * 40) as command:
            with self.assertRaisesRegex(RuntimeError, 'FACEBOOK_STALE_RELEASE_CHANGED'):
                recovery.main(SimpleNamespace(expected_release_sha='a' * 40))
        self.assertEqual(command.call_count, 1)

    def test_only_bounded_publish_worker_is_called(self):
        captured = {}

        def open_request(request, timeout):
            captured['url'] = request.full_url
            captured['body'] = json.loads(request.data)
            captured['authorization'] = request.headers['Authorization']
            captured['timeout'] = timeout
            return JsonResponse()

        with patch.object(recovery, 'urlopen', side_effect=open_request):
            result = recovery.tick('secret-value', 'job-1')
        self.assertEqual(captured['url'], 'http://127.0.0.1:8787/api/internal/publish/tick')
        self.assertEqual(captured['body'], {'jobIds': ['job-1']})
        self.assertEqual(captured['authorization'], 'Bearer secret-value')
        self.assertEqual(result, {'published': 1, 'errors': []})

    def test_target_is_exact_unaccepted_ph0015_stale_job(self):
        with patch.object(recovery, 'query', return_value=[]) as query:
            self.assertEqual(recovery.target_rows(), [])
        sql = query.call_args.args[0]
        self.assertIn("p.base_sku='PH0015'", sql)
        self.assertIn("c.provider='facebook'", sql)
        self.assertIn("j.error_code='PRODUCT_CONTENT_STALE'", sql)
        self.assertIn('j.external_post_id IS NULL', sql)
        self.assertIn("COALESCE(j.provider_response_json,'{}')='{}'", sql)
        self.assertIn(recovery.MARKER, sql)

    def test_requeue_preserves_fail_closed_receipt_guards(self):
        with patch.object(recovery, 'query', return_value=[{'id': 'job-1', 'status': 'queued'}]) as query:
            recovery.requeue('job-1')
        sql = query.call_args.args[0]
        self.assertIn("id='job-1'", sql)
        self.assertIn("status='blocked'", sql)
        self.assertIn("error_code='PRODUCT_CONTENT_STALE'", sql)
        self.assertIn('external_post_id IS NULL', sql)
        self.assertIn("COALESCE(provider_response_json,'{}')='{}'", sql)
        self.assertIn(recovery.MARKER, sql)


if __name__ == '__main__':
    unittest.main()
