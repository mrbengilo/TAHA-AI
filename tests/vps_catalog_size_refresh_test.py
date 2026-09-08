import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'deploy/vps/cancel-catalog-for-size-refresh.py').read_text()


class CatalogSizeRefreshSafetyTest(unittest.TestCase):
    def test_quarantine_is_recoverable_and_fail_closed(self):
        self.assertIn("before['publishJobs'] != 0", SOURCE)
        self.assertIn("before['competitors'] != 0", SOURCE)
        self.assertIn("status='paused',next_run_at=NULL", SOURCE)
        self.assertIn("status='rejected',rejection_reason=?", SOURCE)
        self.assertIn("status='cancelled',lease_owner=NULL", SOURCE)
        self.assertIn("source.backup(target)", SOURCE)
        self.assertIn("os.chmod(backup, 0o600)", SOURCE)
        self.assertIn("command('docker', 'stop'", SOURCE)
        self.assertIn("command('docker', 'start'", SOURCE)
        self.assertNotIn('DELETE FROM', SOURCE.upper())


if __name__ == '__main__':
    unittest.main()
