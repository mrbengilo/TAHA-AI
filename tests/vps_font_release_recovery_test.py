import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).parents[1] / 'deploy' / 'vps' / 'recover-font-release.py'
RELEASE = Path(__file__).parents[1] / 'deploy' / 'vps' / 'release.sh'
WORKFLOW = Path(__file__).parents[1] / '.github' / 'workflows' / 'vps-recover-font-release.yml'
SPEC = importlib.util.spec_from_file_location('recover_font_release', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def container(name, image, tag, created, status='exited', restart='no'):
    return {
        'Id': name.replace('/', '').ljust(64, '0')[:64],
        'Name': name,
        'Image': image,
        'Created': created,
        'Config': {'Image': tag},
        'State': {'Status': status},
        'HostConfig': {
            'RestartPolicy': {'Name': restart},
            'VolumesFrom': None,
            'Links': None,
        },
    }


class FontReleaseRecoveryTest(unittest.TestCase):
    def fixtures(self):
        current = container(
            '/taha-ai', MODULE.ACTIVE_IMAGE, MODULE.ACTIVE_TAG, '2026-09-07T11:14:00Z', 'running', 'always'
        )
        candidate = container(
            '/taha-ai-rollback-20260907-152700-1583764',
            MODULE.OBSOLETE_IMAGE,
            MODULE.OBSOLETE_TAG,
            '2026-09-07T08:08:00Z',
        )
        newer = [
            container('/taha-ai-rollback-20260907-181413-1', 'sha256:a', 'image:a', '2026-09-07T09:04:00Z'),
            container('/taha-ai-rollback-20260907-160432-2', 'sha256:b', 'image:b', '2026-09-07T08:37:00Z'),
            container('/taha-ai-rollback-20260907-153720-3', 'sha256:c', 'image:c', '2026-09-07T08:27:00Z'),
        ]
        target = {
            'Id': 'sha256:target',
            'RepoTags': [MODULE.TARGET_TAG],
            'Config': {'Labels': {'org.opencontainers.image.revision': MODULE.TARGET_REVISION}},
        }
        obsolete = {
            'Id': MODULE.OBSOLETE_IMAGE,
            'RepoTags': [MODULE.OBSOLETE_TAG],
            'Config': {'Labels': {'org.opencontainers.image.revision': MODULE.OBSOLETE_REVISION}},
        }
        return [current, *newer, candidate], current, target, obsolete, candidate

    def test_accepts_only_the_reviewed_fourth_rollback(self):
        items, current, target, obsolete, candidate = self.fixtures()
        self.assertEqual(MODULE.validate(items, current, target, obsolete)['Id'], candidate['Id'])

    def test_rejects_if_candidate_becomes_one_of_three_newest(self):
        items, current, target, obsolete, candidate = self.fixtures()
        candidate['Created'] = '2026-09-07T10:00:00Z'
        with self.assertRaisesRegex(RuntimeError, 'FONT_RECOVERY_ROLLBACK_PROTECTED'):
            MODULE.validate(items, current, target, obsolete)

    def test_rejects_changed_active_release(self):
        items, current, target, obsolete, _ = self.fixtures()
        current['Image'] = 'sha256:changed'
        with self.assertRaisesRegex(RuntimeError, 'FONT_RECOVERY_ACTIVE_RELEASE_CHANGED'):
            MODULE.validate(items, current, target, obsolete)

    def test_rejects_target_used_by_a_container(self):
        items, current, target, obsolete, _ = self.fixtures()
        items.append(container('/unexpected', target['Id'], MODULE.TARGET_TAG, '2026-09-07T12:00:00Z'))
        with self.assertRaisesRegex(RuntimeError, 'FONT_RECOVERY_TARGET_CHANGED'):
            MODULE.validate(items, current, target, obsolete)

    def test_cleanup_never_removes_volumes_or_uses_prune(self):
        source = SCRIPT.read_text()
        self.assertNotIn("docker('container', 'rm', '-v'", source)
        self.assertNotIn("docker('system', 'prune'", source)
        self.assertIn("docker('container', 'rm', candidate['Id'])", source)
        self.assertIn("docker('image', 'rm', OBSOLETE_TAG)", source)

    def test_release_closes_cleanup_race_and_checks_real_font_assets(self):
        release = RELEASE.read_text()
        workflow = WORKFLOW.read_text()
        self.assertIn('EXPECTED_ACTIVE_SHA="${3:-}"', release)
        self.assertIn('EXPECTED_ACTIVE_IMAGE="${4:-}"', release)
        self.assertIn('EXPECTED_ACTIVE_IMAGE_CHANGED', release)
        self.assertIn('EXPECTED_ACTIVE_DIGEST_CHANGED', release)
        self.assertIn('EXPECTED_ACTIVE_STATUS_CHANGED', release)
        self.assertIn('EXPECTED_ACTIVE_REVISION_CHANGED', release)
        self.assertIn('group: taha-vps-production', workflow)
        self.assertIn(
            'bash -s -- "$TARGET_SHA" - "$EXPECTED_ACTIVE_SHA" "$EXPECTED_ACTIVE_IMAGE" < deploy/vps/release.sh',
            workflow,
        )
        self.assertIn('/app/dist/client/_next/static/css', workflow)
        self.assertNotIn('/app/.next/static/css', workflow)


if __name__ == '__main__':
    unittest.main()
