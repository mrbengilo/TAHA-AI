import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('scope', Path(__file__).resolve().parents[1] / 'deploy/vps/enable-google-write-consent.py')
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)


class ScopeConfigurationTests(unittest.TestCase):
    def test_only_scope_request_changes_and_other_settings_are_preserved(self):
        before = 'EXAMPLE_KEY="unchanged"\nGOOGLE_OAUTH_SCOPES="openid email https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets.readonly"\nANOTHER_SETTING=unchanged\n'
        after = scope.edit_scopes(before)
        self.assertEqual(before.splitlines()[0], after.splitlines()[0])
        self.assertEqual(before.splitlines()[2], after.splitlines()[2])
        self.assertIn(scope.DRIVE + '"', after)
        self.assertIn('spreadsheets.readonly', after)
        self.assertNotIn(scope.DRIVE + '.readonly', after)
        self.assertEqual(scope.edit_scopes(after), after)

    def test_missing_and_duplicate_scope_configuration_are_rejected(self):
        for value in ['', 'GOOGLE_OAUTH_SCOPES=a\nGOOGLE_OAUTH_SCOPES=b\n']:
            with self.assertRaises(RuntimeError): scope.edit_scopes(value)


if __name__ == '__main__': unittest.main()
