import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'deploy/vps/publish-catalog.py'
WORKFLOW = Path(__file__).resolve().parents[1] / '.github/workflows/vps-publish-catalog.yml'
SPEC = importlib.util.spec_from_file_location('catalog_publish', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CatalogPublishSafetyTests(unittest.TestCase):
    def products(self):
        return [{'runId': f'00000000-0000-4000-8000-{index:012d}',
                 'productId': f'10000000-0000-4000-8000-{index:012d}', 'sku': sku,
                 'sizes': ['40', '41'], 'publishDay': f'2026-09-{index + 9:02d}'}
                for index, sku in enumerate(MODULE.EXPECTED_COUNTS)]

    def test_plan_prioritizes_six_image_skus_and_uses_one_vietnam_day_each(self):
        plan = MODULE.build_plan(self.products(), now=1788832800)
        priority = [row for row in plan if row['requestedImages'] == 0]
        self.assertEqual([row['sku'] for row in plan[:len(priority)]],
                         sorted(sku for sku, count in MODULE.EXPECTED_COUNTS.items() if count == 0))
        self.assertEqual(len(priority), 7)
        self.assertEqual(len({row['day'] for row in plan}), 15)
        self.assertEqual(len({row['requestKey'] for row in plan}), 15)
        self.assertTrue(all(row['requestKey'].startswith('daily:' + row['day'] + ':') for row in plan))

    def test_plan_marker_is_exact_and_resume_safe(self):
        products = self.products()
        with tempfile.TemporaryDirectory() as folder:
            original = MODULE.MARKER
            MODULE.MARKER = Path(folder) / 'marker.json'
            try:
                created = MODULE.load_or_create_plan(products, 'facebook-one')
                self.assertEqual(created['stage'], 'planned')
                MODULE.MARKER.chmod(0o600)
                self.assertEqual(MODULE.load_or_create_plan(products, 'facebook-one'), created)
                changed = {**created, 'connectionId': 'other'}
                MODULE.MARKER.write_text(json.dumps(changed)); MODULE.MARKER.chmod(0o600)
                with self.assertRaisesRegex(RuntimeError, 'CATALOG_PUBLISH_PLAN_INVALID'):
                    MODULE.load_or_create_plan(products, 'facebook-one')
            finally:
                MODULE.MARKER = original

    def test_publication_is_group_filtered_and_cron_starts_only_after_full_verification(self):
        source = SCRIPT.read_text()
        self.assertIn("run_group(secret, database, priority", source)
        self.assertIn("run_group(secret, database, remaining", source)
        self.assertIn("validate_promoted_state(database, products, marker)", source)
        self.assertIn("products = hydrate_products(database, products)", source)
        self.assertIn("verify_group(database, priority)", source)
        self.assertLess(source.index("run_group(secret, database, priority"),
                        source.index("run_group(secret, database, remaining"))
        self.assertIn("'/api/internal/automation/tick', {'runIds': ids}", source)
        self.assertIn("draft_status'] != 'approved'", source)
        self.assertIn("schedule_status'] != 'active'", source)
        self.assertIn("not 1 <= row['media_count'] <= 6", source)
        self.assertIn("'🏷️ Mã sản phẩm: ' + item['sku']", source)
        self.assertIn("'📏 Size hiện có: ' + ', '.join(item['sizes'])", source)
        self.assertIn("sku_tokens != {item['sku']}", source)
        self.assertLess(source.rindex('verify_group(database, marker[\'plan\'])'),
                        source.rindex("command('systemctl', 'start', 'taha-ai-cron.timer')"))
        self.assertIn(MODULE.REVISION, MODULE.IMAGE)

    def test_workflow_tests_before_ssh_and_records_result(self):
        source = WORKFLOW.read_text()
        self.assertLess(source.index('Verify catalog publication safety contract'), source.index('Configure SSH'))
        self.assertIn('tee deploy/vps/catalog-publish-output.txt', source)
        self.assertIn('git add deploy/vps/catalog-publish-output.txt', source)


if __name__ == '__main__': unittest.main()
