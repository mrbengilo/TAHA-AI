import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'deploy/vps/pause-catalog-recovery.py'
WORKFLOW = Path(__file__).resolve().parents[1] / '.github/workflows/vps-pause-catalog-recovery.yml'
SPEC = importlib.util.spec_from_file_location('catalog_pause', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CatalogPauseSafetyTests(unittest.TestCase):
    def test_only_exact_recovery_stdin_python_is_a_valid_lock_owner(self):
        self.assertTrue(MODULE.is_recovery_cmdline(['python3', '-u', '-']))
        self.assertTrue(MODULE.is_recovery_cmdline(['/usr/bin/python3.12', '-u', '-']))
        for value in (['python3', 'script.py'], ['bash', '-s'], ['python3', '-u', 'other.py']):
            self.assertFalse(MODULE.is_recovery_cmdline(value))

    def test_pause_uses_term_only_and_keeps_publish_paths_empty(self):
        source = SCRIPT.read_text()
        self.assertIn('os.kill(pid, signal.SIGTERM)', source)
        self.assertNotIn('SIGKILL', source)
        self.assertIn("command('systemctl', 'stop', 'taha-ai-cron.timer')", source)
        self.assertIn('schedules or jobs', source)
        self.assertIn(MODULE.REVISION, MODULE.IMAGE)
        self.assertRegex(MODULE.IMAGE_ID, r'^sha256:[0-9a-f]{64}$')

    def test_workflow_tests_before_ssh_and_records_the_result(self):
        source = WORKFLOW.read_text()
        test_position = source.index('Verify pause safety contract')
        ssh_position = source.index('Configure SSH')
        self.assertLess(test_position, ssh_position)
        self.assertIn('tee deploy/vps/catalog-pause-output.txt', source)
        self.assertIn('git add deploy/vps/catalog-pause-output.txt', source)


if __name__ == '__main__': unittest.main()
