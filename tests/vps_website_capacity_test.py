import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('upload_capacity', Path(__file__).parents[1] / 'deploy/vps/website-upload-capacity.py')
capacity = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(capacity)

CONFIG = b'''events {}
http {
 server { listen 80; server_name tahashoes.vn www.tahashoes.vn; location / { return 301 https://$host$request_uri; } }
 server { listen 443 ssl; server_name tahashoes.vn www.tahashoes.vn; location /api/ { proxy_pass http://backend:8080; } location / { proxy_pass http://frontend:3000; } }
 server { listen 443 ssl; server_name tahashoes.store; location / { proxy_pass http://taha-ai:8787; } }
}
'''


class CapacityTests(unittest.TestCase):
    def test_only_signed_receiver_path_gains_larger_body_limit(self):
        updated = capacity.patched_config(CONFIG)
        self.assertEqual(updated.count(b'client_max_body_size 34m;'), 1)
        self.assertEqual(updated.count(b'location = /api/taha/publish'), 1)
        self.assertIn(b'location /api/ { proxy_pass http://backend:8080; }', updated)
        self.assertIn(b'location / { proxy_pass http://taha-ai:8787; }', updated)
        self.assertEqual(updated.count(b'listen 443 ssl;'), 2)

    def test_unreviewed_or_duplicate_server_is_rejected(self):
        for raw in (CONFIG + CONFIG, CONFIG.replace(b'tahashoes.vn', b'other.example'), capacity.patched_config(CONFIG)):
            with self.subTest(raw=raw), self.assertRaises(RuntimeError):
                capacity.patched_config(raw)


if __name__ == '__main__':
    unittest.main()
