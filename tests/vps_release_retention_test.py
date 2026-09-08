import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('retention', Path(__file__).parents[1] / 'deploy/vps/release-retention.py')
retention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retention)


def container(index, active=False):
    return {'Id': str(index), 'Name': '/taha-ai' if active else f'/taha-ai-rollback-20260907-{index:06d}-1',
            'Image': retention.ACTIVE_IMAGE if active else f'image-{index}',
            'State': {'Status': 'running' if active else 'exited'},
            'HostConfig': {'RestartPolicy': {'Name': 'always' if active else 'no'}},
            'Config': {'Image': 'tahashoes-taha-ai:old'},
            'Mounts': [{'Destination': '/data', 'Type': 'bind', 'Source': '/var/lib/taha-ai'},
                       {'Destination': '/app/.dev.vars', 'Type': 'bind', 'Source': '/etc/taha-ai/.dev.vars'}]}


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.items = [container(0, True)] + [container(i) for i in range(1, 7)]

    def test_keeps_live_and_three_newest(self):
        active, kept, obsolete = retention.select(self.items)
        self.assertEqual(active['Id'], '0')
        self.assertEqual([row['Id'] for row in kept], ['6', '5', '4'])
        self.assertEqual([row['Id'] for row in obsolete], ['3', '2', '1'])

    def test_refuses_changed_active_image(self):
        self.items[0]['Image'] = 'another-image'
        with self.assertRaisesRegex(RuntimeError, 'ACTIVE_RELEASE_CHANGED'):
            retention.select(self.items)

    def test_refuses_container_with_unmounted_data(self):
        old = copy.deepcopy(self.items[1])
        old['Mounts'] = []
        with self.assertRaisesRegex(RuntimeError, 'DATA_NOT_EXTERNAL'):
            retention.validate_old(old, self.items, {'0', '4', '5', '6'})

    def test_refuses_running_old_container(self):
        old = copy.deepcopy(self.items[1])
        old['State']['Status'] = 'running'
        with self.assertRaisesRegex(RuntimeError, 'NOT_OBSOLETE'):
            retention.validate_old(old, self.items, {'0', '4', '5', '6'})

    def test_refuses_referenced_or_protected_container(self):
        self.items[0]['HostConfig']['VolumesFrom'] = ['1']
        with self.assertRaisesRegex(RuntimeError, 'CONTAINER_REFERENCED'):
            retention.validate_old(self.items[1], self.items, {'0', '4', '5', '6'})
        with self.assertRaisesRegex(RuntimeError, 'PROTECTED_CONTAINER'):
            retention.validate_old(self.items[4], self.items, {'0', '4', '5', '6'})


if __name__ == '__main__':
    unittest.main()
