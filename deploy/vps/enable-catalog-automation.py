"""Apply the owner's all-originals catalog policy after a validated app release."""
import argparse
import fcntl
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
REPO = Path('/var/www/taha-ai')
ENV = Path('/etc/taha-ai/.dev.vars')
OLD_BACKEND_IMAGE = 'sha256:0568fef8cf5a93be0abc780437fa4eeb0a2fccace45754072775b103d14f485b'
ARTICLE_HASH = 'b83ea5a4a7c821fa375c416728a14787d61ceba12850561ed89a7a627b94c1ca'


def require(value, code):
    if not value:
        raise RuntimeError(code)


def command(args, timeout=60, data=None):
    result = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    require(result.returncode == 0, 'CATALOG_COMMAND_FAILED')
    return result.stdout


def enable_env(raw):
    lines = raw.splitlines(keepends=True)
    matches = [i for i, line in enumerate(lines) if re.match(r'^\s*WEBSITE_READY_BACKFILL_ENABLED\s*=', line)]
    require(len(matches) <= 1, 'CATALOG_DUPLICATE_ENV_KEY')
    if matches:
        lines[matches[0]] = 'WEBSITE_READY_BACKFILL_ENABLED=1\n'
    else:
        if lines and not lines[-1].endswith('\n'):
            lines[-1] += '\n'
        lines.append('WEBSITE_READY_BACKFILL_ENABLED=1\n')
    return ''.join(lines)


def node(mode, timeout=60):
    raw = command(['docker', 'exec', '-i', 'taha-ai', 'node', '--input-type=module', '-', mode],
                  timeout=timeout, data=(HERE / 'catalog-automation-enable.mjs').read_bytes())
    # This reviewed helper emits fixed markers, identifiers, counts and statuses only.
    for line in raw.decode().splitlines():
        require(line.startswith(('CATALOG_POLICY_', 'CATALOG_TICK_', 'CATALOG_AUTOMATION_STATUS=', 'CATALOG_HEALTH_OK')),
                'CATALOG_UNEXPECTED_OUTPUT')
        print(line, flush=True)


def main(args):
    require(re.fullmatch(r'[0-9a-f]{40}', args.expected_release_sha), 'CATALOG_RELEASE_REQUIRED')
    require(command(['git', '-C', str(REPO), 'rev-parse', 'HEAD']).decode().strip() == args.expected_release_sha,
            'CATALOG_RELEASE_CHANGED')
    app = json.loads(command(['docker', 'inspect', 'taha-ai']))[0]
    require(app['Config']['Image'] == 'tahashoes-taha-ai:' + args.expected_release_sha
            and app['State']['Running'], 'CATALOG_APP_IMAGE_CHANGED')
    require(ENV.is_file() and not ENV.is_symlink(), 'CATALOG_ENV_INVALID')
    spec = importlib.util.spec_from_file_location('catalog_receiver', HERE / 'website-receiver-install.py')
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    backend = installer.inspect_container()
    current_adapter = command(['docker', 'exec', 'tahashoes-backend', 'cat', '/app/handlers/product_receiver.go'])
    already_installed = installer.digest(current_adapter) == installer.ADAPTER_HASH
    require(already_installed or backend['Image'] == OLD_BACKEND_IMAGE, 'CATALOG_BACKEND_CHANGED')
    if not args.apply:
        print('CATALOG_ACTIVATION_READY', flush=True)
        return
    with open('/var/lock/taha-ai-release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        timer_was_active = subprocess.run(['systemctl', 'is-active', '--quiet', 'taha-ai-cron.timer'],
                                          capture_output=True, timeout=10).returncode == 0
        activation_ready = False
        runtime_changed = False
        command(['systemctl', 'stop', 'taha-ai-cron.timer'])
        try:
            for _ in range(90):
                state = command(['systemctl', 'show', '-p', 'ActiveState', '--value', 'taha-ai-cron.service']).strip()
                if state not in (b'active', b'activating', b'deactivating'):
                    break
                time.sleep(2)
            require(state not in (b'active', b'activating', b'deactivating'), 'CATALOG_CRON_BUSY')
            if not already_installed:
                print('CATALOG_STAGE=install_all_originals_receiver', flush=True)
                installer.main(SimpleNamespace(expected_container_id=backend['Id'], expected_image_id=OLD_BACKEND_IMAGE,
                                               expected_article_sha256=ARTICLE_HASH, apply=True))
            runtime_changed = True
            node('configure')
            raw = ENV.read_text()
            updated = enable_env(raw)
            if raw != updated:
                backup = Path('/var/backups/taha-ai/catalog-policy-' + args.expected_release_sha[:12])
                backup.mkdir(parents=True, mode=0o700, exist_ok=True)
                destination = backup / 'dev-vars-before'
                require(not destination.exists(), 'CATALOG_ENV_BACKUP_EXISTS')
                shutil.copy2(ENV, destination)
                destination.chmod(0o600)
                # Preserve the bind-mounted inode; the app reloads the environment on restart.
                with ENV.open('r+') as stream:
                    stream.write(updated)
                    stream.truncate()
                    stream.flush()
                    os.fsync(stream.fileno())
            print('CATALOG_STAGE=restart_with_automatic_website_policy', flush=True)
            command(['docker', 'restart', '--time', '120', 'taha-ai'], timeout=150)
            for attempt in range(45):
                try:
                    node('health', timeout=10)
                    break
                except Exception:
                    if attempt == 44:
                        raise RuntimeError('CATALOG_APP_HEALTH_FAILED') from None
                    time.sleep(2)
            activation_ready = True
            print('CATALOG_STAGE=sync_and_publish_ready_catalog', flush=True)
            node('tick', timeout=620)
            node('status')
            # An unchanged second tick must not enqueue another copy of the same catalog.
            node('tick', timeout=620)
            node('status')
        finally:
            if activation_ready:
                command(['systemctl', 'enable', '--now', 'taha-ai-cron.timer'])
                command(['systemctl', 'is-active', '--quiet', 'taha-ai-cron.timer'])
                print('CATALOG_DAILY_TIMER_ACTIVE=yes', flush=True)
            elif not runtime_changed and timer_was_active:
                command(['systemctl', 'start', 'taha-ai-cron.timer'])
                print('CATALOG_PREVIOUS_TIMER_RESTORED=yes', flush=True)
            else:
                print('CATALOG_TIMER_PAUSED_UNTIL_RUNTIME_VERIFIED=yes', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-release-sha', required=True)
    parser.add_argument('--apply', action='store_true')
    try:
        main(parser.parse_args())
    except Exception as error:
        code = str(error)
        sys.exit(code if re.fullmatch(r'(?:CATALOG|RECEIVER)_[A-Z_]+', code) else 'CATALOG_ACTIVATION_FAILED')
