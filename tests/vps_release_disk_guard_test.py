from pathlib import Path
import unittest


SOURCE = (Path(__file__).resolve().parents[1] / 'deploy/vps/release.sh').read_text()


class ReleaseDiskGuardTests(unittest.TestCase):
    def test_low_space_reclaims_only_old_builder_cache_before_abort(self):
        lock = SOURCE.index("flock -n 9")
        prune = SOURCE.index("docker builder prune -af --filter 'until=24h'")
        fallback = SOURCE.index("docker builder prune -af\n")
        abort = SOURCE.index("echo 'INSUFFICIENT_RELEASE_DISK'")
        self.assertLess(lock, prune)
        self.assertLess(prune, fallback)
        self.assertLess(fallback, abort)
        self.assertLess(prune, abort)
        self.assertGreaterEqual(SOURCE.count("df --output=avail -k /"), 3)

    def test_release_guard_does_not_prune_images_volumes_or_containers(self):
        self.assertNotIn('docker system prune', SOURCE)
        self.assertNotIn('docker image prune', SOURCE)
        self.assertNotIn('docker volume prune', SOURCE)
        self.assertNotIn('docker container prune', SOURCE)


if __name__ == '__main__':
    unittest.main()
