"""Install the reviewed album capacity fix and finish the owner's catalog upserts."""
import argparse
import fcntl
import importlib.util
import re
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
REPO = Path('/var/www/taha-ai')
OLD_ADAPTER = 'd8111a98529c8d8ed7fc17e4e7f107b863aff7afc3c58787fb14ed6def85c1e7'
ARTICLE = 'b83ea5a4a7c821fa375c416728a14787d61ceba12850561ed89a7a627b94c1ca'


def require(value, code):
    if not value:
        raise RuntimeError(code)


def command(args, timeout=60, data=None):
    result = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    require(result.returncode == 0, 'CATALOG_COMPLETE_COMMAND_FAILED')
    return result.stdout


def node(filename, *arguments, timeout=60):
    result = subprocess.run(['docker', 'exec', '-i', 'taha-ai', 'node', '--input-type=module', '-', *arguments],
                            input=(HERE / filename).read_bytes(), capture_output=True, timeout=timeout)
    # Helpers emit fixed markers and sanitized status/count data only.
    for line in result.stdout.decode().splitlines():
        require(line.startswith(('CATALOG_', 'CAPACITY_')), 'CATALOG_COMPLETE_UNEXPECTED_OUTPUT')
        print(line, flush=True)
    require(result.returncode == 0, 'CATALOG_COMPLETE_NODE_FAILED')


def main(release):
    require(re.fullmatch(r'[0-9a-f]{40}', release), 'CATALOG_COMPLETE_RELEASE_REQUIRED')
    require(command(['git', '-C', str(REPO), 'rev-parse', 'HEAD']).decode().strip() == release,
            'CATALOG_COMPLETE_RELEASE_CHANGED')
    spec = importlib.util.spec_from_file_location('complete_receiver', HERE / 'website-receiver-install.py')
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    with open('/var/lock/taha-ai-release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        app_image = command(['docker', 'inspect', 'taha-ai', '--format', '{{.Config.Image}}']).decode().strip()
        require(app_image == 'tahashoes-taha-ai:' + release, 'CATALOG_COMPLETE_APP_CHANGED')
        command(['systemctl', 'stop', 'taha-ai-cron.timer'])
        try:
            for _ in range(90):
                state = command(['systemctl', 'show', '-p', 'ActiveState', '--value', 'taha-ai-cron.service']).strip()
                if state not in (b'active', b'activating', b'deactivating'):
                    break
                time.sleep(2)
            require(state not in (b'active', b'activating', b'deactivating'), 'CATALOG_COMPLETE_CRON_BUSY')
            backend = installer.inspect_container()
            live = command(['docker', 'exec', 'tahashoes-backend', 'cat', '/app/handlers/product_receiver.go'])
            live_hash = installer.digest(live)
            require(live_hash in (OLD_ADAPTER, installer.ADAPTER_HASH), 'CATALOG_COMPLETE_ADAPTER_CHANGED')
            if live_hash != installer.ADAPTER_HASH:
                installer.main(SimpleNamespace(expected_container_id=backend['Id'], expected_image_id=backend['Image'],
                                               expected_article_sha256=ARTICLE, apply=True))
            try:
                node('catalog-capacity-complete.mjs', timeout=620)
            finally:
                node('catalog-automation-enable.mjs', 'status')
            node('catalog-automation-enable.mjs', 'tick', timeout=620)
            node('catalog-automation-enable.mjs', 'status')
        finally:
            command(['systemctl', 'enable', '--now', 'taha-ai-cron.timer'])
            command(['systemctl', 'is-active', '--quiet', 'taha-ai-cron.timer'])
            print('CATALOG_DAILY_TIMER_ACTIVE=yes', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-release-sha', required=True)
    try:
        main(parser.parse_args().expected_release_sha)
    except Exception as error:
        message = str(error)
        sys.exit(message if re.fullmatch(r'(CATALOG|RECEIVER)_[A-Z_]+', message) else 'CATALOG_COMPLETE_FAILED')
