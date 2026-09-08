import importlib.util
import contextlib
import io
import json
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('receiver_installer', HERE.parent / 'deploy/vps/website-receiver-install.py')
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class ReceiverInstallerGuards(unittest.TestCase):
    def article(self):
        return ('package handlers\nfunc PublishWebsiteArticle(w http.ResponseWriter, r *http.Request) {\n'
                + installer.AUTH + '\n' + installer.KEY + installer.DECODER + '\n}\n').encode()

    def test_hook_follows_auth_and_key_and_is_idempotent(self):
        updated = installer.prepare_article(self.article())
        self.assertEqual(installer.prepare_article(updated), updated)
        text = updated.decode()
        self.assertLess(text.index(installer.AUTH), text.index(installer.HOOK))
        self.assertLess(text.index(installer.KEY), text.index(installer.HOOK))
        self.assertLess(text.index(installer.HOOK), text.index(installer.DECODER))

    def test_unreviewed_auth_or_duplicate_hook_is_rejected(self):
        raw = self.article()
        for bad in (
            raw.replace(installer.AUTH.encode(), b''),
            raw.replace(installer.KEY.encode(), installer.HOOK.encode() + installer.KEY.encode()),
            installer.prepare_article(raw).replace(installer.HOOK.encode(), (installer.HOOK * 2).encode()),
        ):
            with self.subTest(body=bad), self.assertRaises(installer.GuardError):
                installer.prepare_article(bad)

    def test_local_probe_cannot_follow_arbitrary_host_configuration(self):
        def container(ip, port):
            return {'HostConfig': {'PortBindings': {'8080/tcp': [{'HostIp': ip, 'HostPort': port}]}}}
        self.assertEqual(installer.local_products_url(container('0.0.0.0', '8081')),
                         'http://127.0.0.1:8081/api/products?limit=1')
        for ip, port in (('203.0.113.1', '8080'), ('', '80/path'), ('127.0.0.1', '0')):
            with self.subTest(ip=ip, port=port), self.assertRaises(installer.GuardError):
                installer.local_products_url(container(ip, port))

    def test_offline_build_is_pinned_and_runs_go_tests_before_build(self):
        image = 'sha256:' + 'a' * 64
        captured = []
        with tempfile.TemporaryDirectory() as temporary:
            stage = Path(temporary)
            prepared = {name: b'reviewed' for name in installer.FILES}
            with patch.object(installer, 'tag') as tag, \
                    patch.object(installer, 'image_id', return_value=image), \
                    patch.object(installer, 'run_offline_build', side_effect=lambda args, env: captured.append((args, env))):
                installer.build_child(image, prepared, stage)
                tag.assert_called_once()
                self.assertEqual(tag.call_args.args[0], image)
            dockerfile = (stage / 'Dockerfile').read_text()
            self.assertIn('FROM taha-receiver-parent:', dockerfile)
            self.assertLess(dockerfile.index('go test ./handlers'), dockerfile.index('go build -o server'))
            self.assertIn('GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local', dockerfile)
            args, env = captured[0]
            self.assertIn('--pull=false', args)
            self.assertEqual(args[args.index('--network') + 1], 'none')
            self.assertEqual(env['DOCKER_BUILDKIT'], '0')
            self.assertNotIn('push', args)

    def test_atomic_write_keeps_original_on_fsync_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'article.go'
            path.write_bytes(b'original')
            info = path.stat()
            metadata = {'mode': 0o640, 'uid': info.st_uid, 'gid': info.st_gid}
            with patch.object(installer.os, 'fsync', side_effect=OSError('disk full')):
                with self.assertRaises(OSError):
                    installer.atomic_write(path, b'new', metadata)
            self.assertEqual(path.read_bytes(), b'original')
            self.assertEqual([item.name for item in Path(temporary).iterdir()], ['article.go'])

    def test_compose_standalone_is_selected_when_plugin_fails(self):
        class Result:
            def __init__(self, code):
                self.returncode = code
        with patch.object(installer.subprocess, 'run', side_effect=[Result(1), Result(0)]) as run:
            command = installer.compose_command()
        self.assertEqual(command[0], 'docker-compose')
        self.assertEqual(run.call_args_list[0].args[0], ['docker', 'compose', 'version'])

    def test_offline_failure_classification(self):
        for output, expected in (
            (b'RECEIVER_BUILD_STAGE=formatting\n', ('formatting', 'formatting_failed')),
            (b'RECEIVER_BUILD_STAGE=test\nmodule lookup disabled by GOPROXY=off', ('test', 'dependency_unavailable')),
            (b'RECEIVER_BUILD_STAGE=test\n--- FAIL: fixture', ('test', 'test_failed')),
            (b'RECEIVER_BUILD_STAGE=build\ncompile error', ('build', 'build_failed')),
        ):
            self.assertEqual(installer.build_failure(output), expected)

    def test_failed_build_is_private_and_output_is_sanitized(self):
        raw = b'RECEIVER_BUILD_STAGE=test\nprivate-test-value-do-not-print'
        result = subprocess.CompletedProcess(['docker'], 1, stdout=raw, stderr=b'')
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(installer, 'BASE', Path(temporary)), \
                    patch.object(installer.subprocess, 'run', return_value=result), \
                    contextlib.redirect_stdout(output):
                with self.assertRaisesRegex(installer.GuardError, '^RECEIVER_TEST_FAILED$'):
                    installer.run_offline_build(['docker'], {})
            detail = json.loads(output.getvalue().split('=', 1)[1])
            log = Path(detail['privateLog'])
            self.assertEqual(stat.S_IMODE(log.stat().st_mode), 0o600)
            self.assertIn(raw, log.read_bytes())
            self.assertNotIn('private-test-value', output.getvalue())
            self.assertEqual(detail['stage'], 'test')


if __name__ == '__main__':
    unittest.main()
