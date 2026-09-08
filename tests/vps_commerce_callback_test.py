import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('commerce_callback', Path(__file__).parents[1] / 'deploy/vps/commerce-callback-repair.py')
callback = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(callback)

CONFIG = b'''events {}
http {
 server { listen 443 ssl; server_name tahashoes.vn www.tahashoes.vn; location / { proxy_pass http://frontend:3000; } }
 server { listen 443 ssl; server_name tahashoes.store; auth_basic "TAHA AI"; location / { proxy_pass http://taha-ai:8787; } }
}
'''


class CommerceCallbackTests(unittest.TestCase):
    def test_only_exact_commerce_callbacks_disable_basic_auth(self):
        updated = callback.patched_config(CONFIG)
        for route in callback.ROUTES:
            self.assertEqual(updated.count(f'location = /api/integrations/{route}/callback'.encode()), 1)
        self.assertEqual(updated.count(b'auth_basic off;'), 2)
        self.assertIn(b'auth_basic "TAHA AI";', updated)
        self.assertIn(b'location / { proxy_pass http://taha-ai:8787; }', updated)

    def test_ambiguous_or_existing_route_is_rejected(self):
        for raw in (CONFIG + CONFIG, CONFIG.replace(b'tahashoes.store', b'other.store'), callback.patched_config(CONFIG)):
            with self.subTest(raw=raw), self.assertRaises(RuntimeError):
                callback.patched_config(raw)


if __name__ == '__main__':
    unittest.main()
