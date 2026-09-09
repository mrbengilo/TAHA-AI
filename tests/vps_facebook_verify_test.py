from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parent.parent


class FacebookVerifyScriptTests(unittest.TestCase):
    def test_verifies_the_latest_successful_destination_and_retries_lookup(self):
        source = (ROOT / 'deploy/vps/facebook-verify.py').read_text()
        self.assertIn('FROM publish_jobs j', source)
        self.assertIn("j.status='published'", source)
        self.assertIn('j.external_post_id IS NOT NULL', source)
        self.assertIn("c.provider='facebook'", source)
        self.assertIn('for attempt in range(6):', source)
        self.assertIn('time.sleep(2)', source)
        self.assertNotIn("request_key='trial:drive-only-facebook-v2'", source)


if __name__ == '__main__':
    unittest.main()
