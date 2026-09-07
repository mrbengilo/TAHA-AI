"""Remove one verified obsolete TAHA rollback; preserve every volume and live image."""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

OBSOLETE_NAME = 'taha-ai-rollback-20260825-184900'
OBSOLETE_TAG = 'tahashoes-taha-ai:rollback-c50fe57c008b'
TARGET_TAG = 'tahashoes-taha-ai:db9e460029454bd48e3c248cd64923d3208fcf0c'


def docker(*args):
    try:
        return subprocess.run(['docker', *args], check=True, capture_output=True, text=True, timeout=90).stdout
    except subprocess.SubprocessError:
        raise RuntimeError('RELEASE_SPACE_DOCKER_FAILED') from None


def inspect(kind, reference):
    return json.loads(docker(kind, 'inspect', reference))[0]


def containers():
    return [inspect('container', identity) for identity in docker('container', 'ls', '-aq').split()]


def validate(items, current, target, old_image):
    if current.get('Name') != '/taha-ai' or current['State']['Status'] != 'running':
        raise RuntimeError('RELEASE_SPACE_CURRENT_NOT_HEALTHY')
    if not current['Image'].startswith('sha256:32d8c354d0ca') or not target['Id'].startswith('sha256:de8162a1c53b'):
        raise RuntimeError('RELEASE_SPACE_DEPLOYMENT_CHANGED')
    if old_image.get('RepoTags') != [OBSOLETE_TAG] or not old_image['Id'].startswith('sha256:bde7c3db19f9'):
        raise RuntimeError('RELEASE_SPACE_IMAGE_CHANGED')
    candidates = [item for item in items if item.get('Name') == '/' + OBSOLETE_NAME]
    if len(candidates) != 1:
        raise RuntimeError('RELEASE_SPACE_CONTAINER_MISSING')
    old = candidates[0]
    if old['Image'] != old_image['Id'] or old['State']['Status'] != 'exited' or old['HostConfig']['RestartPolicy']['Name'] != 'no':
        raise RuntimeError('RELEASE_SPACE_CONTAINER_CHANGED')
    retained = [item for item in items if item['Id'] != old['Id']]
    if any(item['Image'] == old_image['Id'] for item in retained):
        raise RuntimeError('RELEASE_SPACE_IMAGE_REFERENCED')
    rollback = sorted([item for item in retained if re.fullmatch(r'/taha-ai-rollback-\d{8}-\d{6}(?:-\d+)?', item.get('Name', ''))], key=lambda item: item['Name'], reverse=True)
    if len(rollback) < 3 or old_image['Id'] in {current['Image'], target['Id'], *(item['Image'] for item in rollback[:3])}:
        raise RuntimeError('RELEASE_SPACE_ROLLBACK_PROTECTED')
    for item in retained:
        refs = (item['HostConfig'].get('VolumesFrom') or []) + (item['HostConfig'].get('Links') or [])
        if any(value.split(':')[0].lstrip('/') in {OBSOLETE_NAME, old['Id'], old['Id'][:12]} for value in refs):
            raise RuntimeError('RELEASE_SPACE_CONTAINER_REFERENCED')
    # docker rm without -v preserves named/anonymous volumes and bind-mounted data.
    return old


def main():
    with open('/var/lock/taha-ai-release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current = inspect('container', 'taha-ai')
        target = inspect('image', TARGET_TAG)
        old_image = inspect('image', OBSOLETE_TAG)
        old = validate(containers(), current, target, old_image)
        print('RELEASE_SPACE_PLAN=' + OBSOLETE_NAME + '|' + OBSOLETE_TAG, flush=True)
        if '--apply' not in sys.argv:
            return
        backup = Path('/var/backups/taha-ai/obsolete-rollback-20260825-184900.json')
        if not backup.exists():
            fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as output:
                json.dump(old, output)
                output.flush()
                os.fsync(output.fileno())
        validate(containers(), inspect('container', 'taha-ai'), inspect('image', TARGET_TAG), inspect('image', OBSOLETE_TAG))
        docker('container', 'rm', old['Id'])
        if any(item['Image'] == old_image['Id'] for item in containers()):
            raise RuntimeError('RELEASE_SPACE_IMAGE_REFERENCED')
        if inspect('image', OBSOLETE_TAG)['Id'] != old_image['Id']:
            raise RuntimeError('RELEASE_SPACE_IMAGE_CHANGED')
        docker('image', 'rm', OBSOLETE_TAG)
        if inspect('container', 'taha-ai')['Image'] != current['Image'] or inspect('image', TARGET_TAG)['Id'] != target['Id']:
            raise RuntimeError('RELEASE_SPACE_PROTECTED_RESOURCE_CHANGED')
        free = os.statvfs('/').f_bavail * os.statvfs('/').f_frsize
        print('RELEASE_SPACE_FREE_BYTES=' + str(free), flush=True)
        subprocess.run(['systemctl', 'is-active', 'taha-ai-cron.timer'], check=True)
        if free < 5242880 * 1024:
            raise RuntimeError('RELEASE_SPACE_STILL_INSUFFICIENT')
        print('RELEASE_SPACE_READY=yes', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error)
        print(message if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', message) else 'RELEASE_SPACE_FAILED', file=sys.stderr)
        sys.exit(1)
