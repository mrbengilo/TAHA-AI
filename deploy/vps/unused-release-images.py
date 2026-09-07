"""Reclaim only the two exact, never-deployed db9 release images."""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

REVISION = 'db9e460029454bd48e3c248cd64923d3208fcf0c'
TAG = 'tahashoes-taha-ai:' + REVISION
CURRENT = 'sha256:32d8c354d0ca6d292f85ab42eea5ef65df4dbc4f8e83e20e80c3925e6566d17c'
UNUSED = (
    'sha256:de8162a1c53b55d18180ad76c33f66fb0c69363a8984bb823f17cf5ee78eef7b',
    'sha256:f080445ef7cfe81fc1843fa137ba19180759129a02efe48e99c62b129c5ede0d',
)


def docker(*args):
    try:
        return subprocess.run(['docker', *args], capture_output=True, text=True, check=True, timeout=90).stdout
    except subprocess.SubprocessError:
        raise RuntimeError('UNUSED_RELEASE_DOCKER_FAILED') from None


def inventory():
    ids = docker('container', 'ls', '-aq').split()
    return json.loads(docker('container', 'inspect', *ids)) if ids else []


def validate(image, refs):
    current = [c for c in refs if c.get('Name') == '/taha-ai']
    if len(current) != 1 or current[0]['Image'] != CURRENT or current[0]['State']['Status'] != 'running':
        raise RuntimeError('UNUSED_RELEASE_DEPLOYMENT_CHANGED')
    if image.get('Id') not in UNUSED or set(image.get('RepoTags') or []) - {TAG}:
        raise RuntimeError('UNUSED_RELEASE_IMAGE_CHANGED')
    if (image.get('Config', {}).get('Labels') or {}).get('org.opencontainers.image.revision') != REVISION:
        raise RuntimeError('UNUSED_RELEASE_OWNERSHIP_MISMATCH')
    if any(c['Image'] == image['Id'] for c in refs):
        raise RuntimeError('UNUSED_RELEASE_IMAGE_REFERENCED')
    if len([c for c in refs if c.get('Name', '').startswith('/taha-ai-rollback-')]) < 3:
        raise RuntimeError('UNUSED_RELEASE_ROLLBACKS_MISSING')


def main():
    with open('/var/lock/taha-ai-release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        refs = inventory()
        existing = set(docker('image', 'ls', '-aq', '--no-trunc').split())
        images = [json.loads(docker('image', 'inspect', identity))[0] for identity in UNUSED if identity in existing]
        for image in images:
            validate(image, refs)
            print('UNUSED_RELEASE_ELIGIBLE=' + image['Id'], flush=True)
        if '--apply' not in sys.argv:
            return
        for image in images:
            validate(json.loads(docker('image', 'inspect', image['Id']))[0], inventory())
            backup = Path('/var/backups/taha-ai') / ('unused-release-' + image['Id'][7:19] + '.json')
            if not backup.exists():
                fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'w') as output:
                    json.dump(image, output)
                    output.flush()
                    os.fsync(output.fileno())
            docker('image', 'rm', image['Id'])
            print('UNUSED_RELEASE_REMOVED=' + image['Id'], flush=True)
        remaining = inventory()
        if [(c['Id'], c['Image']) for c in refs] != [(c['Id'], c['Image']) for c in remaining]:
            raise RuntimeError('UNUSED_RELEASE_CONTAINER_SET_CHANGED')
        free = os.statvfs('/').f_bavail * os.statvfs('/').f_frsize
        print('UNUSED_RELEASE_FREE_BYTES=' + str(free), flush=True)
        if free < 5242880 * 1024 + 950000000:
            raise RuntimeError('UNUSED_RELEASE_HEADROOM_INSUFFICIENT')
        print('UNUSED_RELEASE_READY=yes', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error)
        print(message if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', message) else 'UNUSED_RELEASE_FAILED', file=sys.stderr)
        sys.exit(1)
