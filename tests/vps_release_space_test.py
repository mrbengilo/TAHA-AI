import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('space', Path(__file__).resolve().parents[1] / 'deploy/vps/release-space.py')
space = importlib.util.module_from_spec(spec)
spec.loader.exec_module(space)


class SpaceGuardTests(unittest.TestCase):
    def fixture(self):
        old = {'Id': 'old-container', 'Name': '/' + space.OBSOLETE_NAME, 'Image': 'sha256:bde7c3db19f9old',
               'State': {'Status': 'exited'}, 'HostConfig': {'RestartPolicy': {'Name': 'no'}, 'VolumesFrom': None, 'Links': None}}
        current = copy.deepcopy(old)
        current.update(Id='current', Name='/taha-ai', Image='sha256:32d8c354d0cacurrent', State={'Status': 'running'})
        items = [old, current]
        for index in range(3):
            other = copy.deepcopy(old)
            other.update(Id=f'retained-{index}', Name=f'/taha-ai-rollback-20260907-15070{index}-123', Image=f'retained-image-{index}')
            items.append(other)
        return items, current, {'Id': 'sha256:de8162a1c53btarget'}, {'Id': old['Image'], 'RepoTags': [space.OBSOLETE_TAG]}

    def test_only_exact_obsolete_rollback_is_selected(self):
        args = self.fixture()
        self.assertEqual(space.validate(*args)['Id'], 'old-container')

    def test_current_running_other_reference_and_retagging_are_protected(self):
        for mutation in ['running', 'reference', 'retag', 'restart', 'current']:
            items, current, target, image = self.fixture()
            if mutation == 'running': items[0]['State']['Status'] = 'running'
            if mutation == 'reference': items[-1]['Image'] = image['Id']
            if mutation == 'retag': image['RepoTags'].append('other-app:latest')
            if mutation == 'restart': items[0]['HostConfig']['RestartPolicy']['Name'] = 'always'
            if mutation == 'current': current['Image'] = 'new-deployment'
            with self.assertRaises(RuntimeError): space.validate(items, current, target, image)


if __name__ == '__main__':
    unittest.main()
