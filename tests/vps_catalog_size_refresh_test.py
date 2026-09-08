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
        self.assertIn("EXPECTED_COMPETITOR = 'eedbea4c-e66b-4c28-bc1a-a603c21c0830'", SOURCE)
        self.assertIn("'CATALOG_SIZE_REFRESH_COMPETITOR_CHANGED'", SOURCE)
        self.assertIn("'quarantinedRunIds': ids", SOURCE)
        self.assertIn("'database-quarantined'", SOURCE)
        self.assertIn("'http://127.0.0.1:8787/automation'", SOURCE)
        self.assertNotIn('DELETE FROM', SOURCE.upper())


if __name__ == '__main__':
    unittest.main()
