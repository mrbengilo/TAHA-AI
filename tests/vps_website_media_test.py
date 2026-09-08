import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('media_repair', Path(__file__).parents[1] / 'deploy/vps/website-media-repair.py')
media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)
CONFIG = b'''events {}
http {
    server {
        listen 80;
        server_name tahashoes.vn www.tahashoes.vn;
        location / { return 301 https://$host$request_uri; }
    }
    server {
        listen 443 ssl;
        server_name tahashoes.vn www.tahashoes.vn;
        location /api/ { proxy_pass http://backend:8080; }
        location / {
            proxy_pass http://frontend:3000;
        }
    }
    server {
        listen 443 ssl;
        server_name tahashoes.store;
        location / { proxy_pass http://taha-ai:8787; }
    }
}
'''


class MediaTests(unittest.TestCase):
    def test_patch_only_targets_https_shoes_server(self):
        updated = media.patched_config(CONFIG)
        self.assertEqual(updated.count(b'location ^~ /uploads/taha/'), 1)
        self.assertEqual(updated.count(b'proxy_pass http://frontend:3000;'), 1)
        self.assertIn(b'limit_except GET { deny all; }', updated)
        self.assertIn(b'[0-9a-f]{64}[.]jpg$', updated)
        before, after = updated.split(b'location ^~ /uploads/taha/', 1)
        self.assertIn(b'listen 443 ssl;', before)
        self.assertLess(after.index(b'proxy_pass http://backend:8080;'), after.index(b'proxy_pass http://frontend:3000;'))
        self.assertEqual(updated.count(b'proxy_pass http://taha-ai:8787;'), 1)

    def test_unknown_or_duplicate_routes_are_rejected(self):
        for raw in (CONFIG.replace(b'tahashoes.vn', b'other.example'),
                    CONFIG + CONFIG,
                    media.patched_config(CONFIG),
                    CONFIG.replace(b'listen 443 ssl;', b'listen 8080;')):
            with self.subTest(raw=raw), self.assertRaises(RuntimeError):
                media.patched_config(raw)

    def test_single_file_bind_inode_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'nginx.conf'
            path.write_bytes(CONFIG)
            inode = path.stat().st_ino
            with patch.object(media, 'CONFIG', path):
                updated = media.patched_config(CONFIG)
                media.write_same_inode(updated, inode)
                self.assertEqual(path.stat().st_ino, inode)
                self.assertEqual(path.read_bytes(), updated)
                media.write_same_inode(CONFIG, inode)
                self.assertEqual(path.read_bytes(), CONFIG)

    def test_html_or_wrong_image_cannot_pass_verification(self):
        for result in ((200, 'text/html', b'<html>'), (404, 'image/jpeg', b'\xff\xd8\xffbad'),
                       (200, 'image/jpeg', b'\xff\xd8\xffwrong')):
            with patch.object(media, 'get', return_value=result), self.assertRaises(RuntimeError):
                media.check_image('https://tahashoes.vn/uploads/taha/' + media.FIRST_IMAGE,
                                  '/uploads/taha/' + media.FIRST_IMAGE)


if __name__ == '__main__':
    unittest.main()
