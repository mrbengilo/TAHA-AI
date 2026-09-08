"""Run the one authorized PH0015 recovery from an exact successfully deployed main release."""
import argparse
import fcntl
import json
from pathlib import Path
import re
import subprocess
import sys

REPO = Path('/var/www/taha-ai')
HERE = REPO / 'deploy/vps'
CONTAINER = '34a54ce3b33bf43bfc4486bb766fcee1cb9dc89d2d998f6ff9fa9da75eb0e44c'
IMAGE = 'sha256:b335859afb4cbde4fca1b8e0e0f06010c410ea3626adf355368070eb00970b2a'
ARTICLE = '2b74bbcb7e4c55cf5f000fce986c2382874b20d326e2dc4f6a081c9b8e2ab355'


def require(value, code):
    if not value:
        raise RuntimeError(code)


def read(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=30, cwd=REPO)
    require(result.returncode == 0, 'WEBSITE_RECOVERY_READ_FAILED')
    return result.stdout.strip()


def run(script, args, timeout):
    result = subprocess.run(['python3', '-B', '-u', str(HERE / script), *args], timeout=timeout, cwd=REPO)
    require(result.returncode == 0, 'WEBSITE_RECOVERY_STAGE_FAILED')


def main(args):
    require(re.fullmatch(r'[0-9a-f]{40}', args.expected_release_sha), 'WEBSITE_RECOVERY_RELEASE_REQUIRED')
    with open('/var/lock/taha-ai-release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(read(['git', 'rev-parse', 'HEAD']) == args.expected_release_sha,
                'WEBSITE_RECOVERY_RELEASE_CHANGED')
        require(read(['docker', 'inspect', 'taha-ai', '--format', '{{.Config.Image}}'])
                == 'tahashoes-taha-ai:' + args.expected_release_sha, 'WEBSITE_RECOVERY_IMAGE_CHANGED')
        install_args = ['--expected-container-id', CONTAINER, '--expected-image-id', IMAGE,
                        '--expected-article-sha256', ARTICLE]
        if not args.apply:
            run('website-receiver-install.py', install_args, 180)
            run('website-one-product-trial.py', [], 180)
            print('WEBSITE_RECOVERY_CHECK=ready; receiver_build_and_secret_wiring_pending')
            return
        # Each installer operation has its own timeout; do not kill a rollback midway.
        run('website-receiver-install.py', install_args + ['--apply'], None)
        current = json.loads(read(['docker', 'inspect', 'tahashoes-backend']))[0]
        run('website-runtime-repair.py', ['--expected-container-id', current['Id'],
            '--expected-image-id', current['Image'], '--apply'], None)
        run('website-one-product-trial.py', ['--apply'], 900)
        print('WEBSITE_RECOVERY_COMPLETE=PH0015')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--expected-release-sha', required=True)
    parser.add_argument('--apply', action='store_true')
    try:
        main(parser.parse_args())
    except Exception as error:
        message = str(error)
        sys.exit(message if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', message) else 'WEBSITE_RECOVERY_FAILED')
