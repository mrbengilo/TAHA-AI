import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('unused', Path(__file__).resolve().parents[1] / 'deploy/vps/unused-release-images.py')
unused = importlib.util.module_from_spec(spec)
spec.loader.exec_module(unused)


class UnusedImageGuards(unittest.TestCase):
    def fixture(self):
        image = {'Id': unused.UNUSED[0], 'RepoTags': [], 'Config': {'Labels': {'org.opencontainers.image.revision': unused.REVISION}}}
        refs = [{'Name': '/taha-ai', 'Image': unused.CURRENT, 'State': {'Status': 'running'}}]
        refs += [{'Name': '/taha-ai-rollback-' + str(i), 'Image': 'retained-' + str(i)} for i in range(3)]
        return image, refs

    def test_exact_unreferenced_release_only(self):
        unused.validate(*self.fixture())

    def test_protect_every_reference_other_app_tag_and_changed_release(self):
        for case in ['referenced', 'tag', 'revision', 'id', 'current', 'rollback']:
            image, refs = copy.deepcopy(self.fixture())
            if case == 'referenced': refs.append({'Name': '/other-app', 'Image': image['Id']})
            if case == 'tag': image['RepoTags'] = ['other-app:latest']
            if case == 'revision': image['Config']['Labels'] = {}
            if case == 'id': image['Id'] = 'unreviewed-image'
            if case == 'current': refs[0]['Image'] = 'new-release'
            if case == 'rollback': refs.pop()
            with self.assertRaises(RuntimeError): unused.validate(image, refs)


if __name__ == '__main__':
    unittest.main()
