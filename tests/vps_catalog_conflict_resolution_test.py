import importlib.util
import json
from pathlib import Path
import unittest


SCRIPT = Path(__file__).parents[1] / 'deploy/vps/resolve-catalog-conflicts.py'
SPEC = importlib.util.spec_from_file_location('catalog_conflicts', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def row(sku, status='queued'):
    spec = MODULE.EXPECTED[sku]
    return {'id': spec['id'], 'base_sku': sku, 'request_key': spec['kind'] + ':exact',
            'status': status, 'error_code': None, 'requested_image_count': 4,
            'target_providers_json': json.dumps([spec['target']]), 'prompt_version': MODULE.PROMPT_VERSION,
            'content_json': json.dumps({'prepareOnly': False, 'targetConnections': {spec['target']: 'connection'}})}


class CatalogConflictResolutionTest(unittest.TestCase):
    def test_accepts_only_two_exact_publish_capable_conflicts(self):
        rows = [row('PH0014'), row('PH0021')]
        self.assertEqual(MODULE.validate_conflicts(rows), rows)
        for changed in (
            [{**rows[0], 'id': '82af7bf1-2c99-479d-8923-afb90d595217'}, rows[1]],
            [{**rows[0], 'target_providers_json': '["facebook"]'}, rows[1]],
            [{**rows[0], 'content_json': '{"prepareOnly":true}'}, rows[1]],
            [{**rows[0], 'status': 'completed'}, rows[1]],
        ):
            with self.assertRaises(RuntimeError):
                MODULE.validate_conflicts(changed)

    def test_cancelled_state_is_allowed_only_during_idempotent_resume(self):
        rows = [row('PH0014', 'cancelled'), row('PH0021', 'cancelled')]
        with self.assertRaises(RuntimeError):
            MODULE.validate_conflicts(rows)
        MODULE.validate_conflicts(rows, allow_cancelled=True)

    def test_script_never_starts_cron_or_writes_database_directly(self):
        source = SCRIPT.read_text()
        self.assertNotIn("'start', 'taha-ai-cron.timer'", source)
        self.assertNotIn('mode=rw', source)
        self.assertIn("'/cancel'", source)
        self.assertIn('CATALOG_CONFLICT_ALREADY_HAS_OUTPUTS', source)
        self.assertIn("IMAGE_ID = 'sha256:3c4035316ec163", source)
        self.assertIn("'{{.Config.Image}}|{{.Image}}|{{.State.Status}}'", source)
        self.assertIn('org.opencontainers.image.revision', source)


if __name__ == '__main__':
    unittest.main()
