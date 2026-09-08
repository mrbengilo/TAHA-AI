import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location(
    'facebook_template_recovery',
    ROOT / 'deploy/vps/facebook-template-recovery.py',
)
recovery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recovery)


class JsonResponse:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps({'data': {'automation': {'completed': 1, 'errors': []}}}).encode()


class FacebookTemplateRecoveryTests(unittest.TestCase):
    def test_changed_release_is_rejected_before_runtime_access(self):
        with patch.object(recovery, 'command', return_value=b'b' * 40) as command:
            with self.assertRaisesRegex(RuntimeError, 'FACEBOOK_TEMPLATE_RELEASE_CHANGED'):
                recovery.main(SimpleNamespace(expected_release_sha='a' * 40))
        self.assertEqual(command.call_count, 1)

    def test_only_bounded_automation_worker_is_called(self):
        captured = {}

        def open_request(request, timeout):
            captured['url'] = request.full_url
            captured['body'] = json.loads(request.data)
            captured['authorization'] = request.headers['Authorization']
            captured['timeout'] = timeout
            return JsonResponse()

        with patch.object(recovery, 'urlopen', side_effect=open_request):
            result = recovery.tick('secret-value', ['11111111-1111-4111-8111-111111111111'])
        self.assertEqual(captured['url'], 'http://127.0.0.1:8787/api/internal/automation/tick')
        self.assertEqual(captured['body'], {'runIds': ['11111111-1111-4111-8111-111111111111']})
        self.assertEqual(captured['authorization'], 'Bearer secret-value')
        self.assertEqual(result, {'completed': 1, 'errors': []})

    def test_recovery_query_is_limited_to_migration_marker(self):
        with patch.object(recovery, 'query', return_value=[]) as query:
            self.assertEqual(recovery.recovery_rows(), [])
        sql = query.call_args.args[0]
        self.assertIn("templateRecovery')='facebook-structure-v2'", sql)
        self.assertIn(recovery.WORKSPACE, sql)


if __name__ == '__main__':
    unittest.main()
