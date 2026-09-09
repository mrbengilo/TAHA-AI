import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location(
    'preserve_generated_python_cache',
    ROOT / 'deploy/vps/preserve-generated-python-cache.py',
)
cache = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cache)


class GeneratedCacheTests(unittest.TestCase):
    def test_exact_python_cache_is_the_only_accepted_change_shape(self):
        self.assertTrue(cache.CHANGE.fullmatch(
            '?? deploy/vps/__pycache__/website-receiver-install.cpython-310.pyc'))
        self.assertFalse(cache.CHANGE.fullmatch(' M deploy/vps/release.sh'))
        self.assertFalse(cache.CHANGE.fullmatch('?? .env'))
        self.assertFalse(cache.CHANGE.fullmatch('?? deploy/vps/__pycache__/../../.env.cpython-310.pyc'))

    def test_clean_checkout_requires_no_mutation(self):
        fake_lock = unittest.mock.mock_open()
        with patch('builtins.open', fake_lock), patch.object(cache.fcntl, 'flock'), \
                patch.object(cache, 'checkout_changes', return_value=[]), \
                patch.object(cache, 'verified_cache_files', return_value=[]) as verified:
            cache.main(SimpleNamespace(apply=False))
        verified.assert_called_once_with([])

    def test_unknown_checkout_change_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, 'GENERATED_CACHE_USER_CHANGES_PRESERVED'):
            cache.verified_cache_files([' M lib/automation.ts'])


if __name__ == '__main__':
    unittest.main()
