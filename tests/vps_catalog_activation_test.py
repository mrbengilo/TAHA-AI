import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('catalog_activation', ROOT / 'deploy/vps/enable-catalog-automation.py')
activation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(activation)


class CatalogActivationGuards(unittest.TestCase):
    def test_enabling_website_preserves_all_other_environment_values(self):
        original = 'INTERNAL_API_SECRET="private-value"\nOTHER=unchanged\n'
        enabled = activation.enable_env(original)
        self.assertEqual(enabled, original + 'WEBSITE_READY_BACKFILL_ENABLED=1\n')
        self.assertEqual(activation.enable_env(enabled), enabled)
        self.assertEqual(activation.enable_env(original + 'WEBSITE_READY_BACKFILL_ENABLED=0'), enabled)

    def test_ambiguous_environment_flag_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'CATALOG_DUPLICATE_ENV_KEY'):
            activation.enable_env('WEBSITE_READY_BACKFILL_ENABLED=0\nWEBSITE_READY_BACKFILL_ENABLED=1\n')

    def test_changed_release_is_rejected_before_activation(self):
        with patch.object(activation, 'command', return_value=b'b' * 40) as command:
            with self.assertRaisesRegex(RuntimeError, 'CATALOG_RELEASE_CHANGED'):
                activation.main(SimpleNamespace(expected_release_sha='a' * 40, apply=True))
        self.assertEqual(command.call_count, 1)


if __name__ == '__main__':
    unittest.main()
