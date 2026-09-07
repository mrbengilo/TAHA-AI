from pathlib import Path
import unittest


ROOT = Path(__file__).parents[1]
SCRIPT = (ROOT / 'deploy/vps/hold-catalog-cron.py').read_text()
WORKFLOW = (ROOT / '.github/workflows/vps-hold-catalog-cron.yml').read_text()


class CatalogHoldTest(unittest.TestCase):
    def test_holds_timer_and_drains_without_stopping_the_service(self):
        self.assertIn("command('systemctl', 'stop', 'taha-ai-cron.timer')", SCRIPT)
        self.assertIn("'ActiveState', '--value'", SCRIPT)
        self.assertNotIn("command('systemctl', 'stop', 'taha-ai-cron.service')", SCRIPT)
        self.assertNotIn("docker', 'stop", SCRIPT)

    def test_pins_release_and_exact_fifteen_run_marker(self):
        self.assertIn("IMAGE = 'tahashoes-taha-ai:010c0193", SCRIPT)
        self.assertIn('len(products) != 15', SCRIPT)
        self.assertIn('count != 15', SCRIPT)
        self.assertIn('group: taha-vps-production', WORKFLOW)


if __name__ == '__main__':
    unittest.main()
