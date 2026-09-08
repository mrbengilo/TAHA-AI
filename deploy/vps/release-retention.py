"""Reclaim obsolete TAHA release images; retain live and newest three rollbacks.

No volumes, data directories, database backups, or running containers are removed.
Only the diagnosed active release is accepted. Metadata is saved privately before
removing stopped obsolete containers without force or volume flags.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ACTIVE_IMAGE = 'sha256:43dd59acece5c86c624cc9ef724fe585dacf00ac56c3d0abd8bc86df36ee3662'
REPO = 'tahashoes-taha-ai'
MIN_FREE = 8 * 1024 ** 3
ROLLBACK = re.compile(r'/taha-ai-rollback-202\d{5}-\d{6}(?:-\d+)?')


def require(value, code):
    if not value:
        raise RuntimeError(code)


def docker(*args):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=120)
    require(result.returncode == 0, 'RETENTION_DOCKER_FAILED')
    return result.stdout


def inspect(kind, name):
    return json.loads(docker(kind, 'inspect', name))[0]


def inventory():
    return [inspect('container', name) for name in docker('container', 'ls', '-aq').split()]


def free_bytes():
    state = os.statvfs('/')
    return state.f_bavail * state.f_frsize


def select(items):
    active = [item for item in items if item['Name'] == '/taha-ai']
    require(len(active) == 1 and active[0]['State']['Status'] == 'running'
            and active[0]['Image'] == ACTIVE_IMAGE, 'RETENTION_ACTIVE_RELEASE_CHANGED')
    rollbacks = sorted([item for item in items if ROLLBACK.fullmatch(item['Name'])],
                       key=lambda item: item['Name'], reverse=True)
    require(len(rollbacks) >= 3, 'RETENTION_ROLLBACK_COUNT_TOO_LOW')
    retained = rollbacks[:3]
    require(all(item['State']['Status'] == 'exited' for item in retained), 'RETENTION_ROLLBACK_STATE_CHANGED')
    return active[0], retained, rollbacks[3:]


def validate_old(old, items, protected):
    require(old['Id'] not in protected and ROLLBACK.fullmatch(old['Name']), 'RETENTION_PROTECTED_CONTAINER')
    require(old['State']['Status'] == 'exited' and old['HostConfig']['RestartPolicy']['Name'] == 'no',
            'RETENTION_CONTAINER_NOT_OBSOLETE')
    mounts = {mount['Destination']: mount for mount in old.get('Mounts', [])}
    require(mounts.get('/data', {}).get('Type') == 'bind'
            and mounts['/data']['Source'] == '/var/lib/taha-ai', 'RETENTION_DATA_NOT_EXTERNAL')
    require(mounts.get('/app/.dev.vars', {}).get('Type') == 'bind'
            and mounts['/app/.dev.vars']['Source'] == '/etc/taha-ai/.dev.vars', 'RETENTION_ENV_NOT_EXTERNAL')
    require(old['Config']['Image'].startswith(REPO + ':'), 'RETENTION_IMAGE_OWNER_MISMATCH')
    aliases = {old['Name'].lstrip('/'), old['Id'], old['Id'][:12]}
    for item in items:
        refs = (item['HostConfig'].get('VolumesFrom') or []) + (item['HostConfig'].get('Links') or [])
        require(not any(ref.split(':')[0].lstrip('/') in aliases for ref in refs), 'RETENTION_CONTAINER_REFERENCED')


def remove_unreferenced(image_id, protected_images, owned_container=False):
    if image_id in protected_images or any(item['Image'] == image_id for item in inventory()):
        return
    info = inspect('image', image_id)
    tags = info.get('RepoTags') or []
    if not tags:
        require(owned_container, 'RETENTION_UNTAGGED_IMAGE_OWNERSHIP_UNKNOWN')
        require(not any(item['Image'] == image_id for item in inventory()), 'RETENTION_IMAGE_REFERENCED')
        docker('image', 'rm', image_id)
        return
    require(all(tag.startswith(REPO + ':') and not tag.endswith(':latest') for tag in tags),
            'RETENTION_IMAGE_TAGS_NOT_OWNED')
    for tag in tags:
        require(inspect('image', tag)['Id'] == image_id, 'RETENTION_IMAGE_TAG_CHANGED')
        require(not any(item['Image'] == image_id for item in inventory()), 'RETENTION_IMAGE_REFERENCED')
        docker('image', 'rm', tag)


def main(apply):
    with open('/var/lock/taha-ai-release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        items = inventory()
        active, retained, obsolete = select(items)
        protected = {active['Id'], *(item['Id'] for item in retained)}
        protected_images = {active['Image'], *(item['Image'] for item in retained)}
        for old in obsolete:
            validate_old(old, items, protected)
        print('RETENTION_PLAN=' + json.dumps({'freeBytes': free_bytes(), 'keep': [item['Name'] for item in retained],
              'eligible': [item['Name'] for item in obsolete]}), flush=True)
        if not apply:
            return
        root = Path('/var/backups/taha-ai/retention-' + time.strftime('%Y%m%d-%H%M%S'))
        root.mkdir(mode=0o700, parents=True, exist_ok=False)
        # This exact failed release never replaced production; its source exists in Git.
        failed = 'tahashoes-taha-ai:a704681dbbae20d62195136e13a6d00099c7857d'
        found = docker('image', 'ls', '--no-trunc', '--format', '{{.ID}}', failed).strip()
        if found:
            require(found == 'sha256:748be5f9832132f68521b117a8105eb1a43fdff93f4bd75729675574c4127237',
                    'RETENTION_FAILED_RELEASE_CHANGED')
            remove_unreferenced(found, protected_images)
        for old in obsolete:
            if free_bytes() >= MIN_FREE:
                break
            current_items = inventory()
            current, keep, _ = select(current_items)
            require(current['Id'] == active['Id'] and {item['Id'] for item in keep} == {item['Id'] for item in retained},
                    'RETENTION_PROTECTED_SET_CHANGED')
            fresh = inspect('container', old['Id'])
            require(fresh == old, 'RETENTION_CONTAINER_CHANGED')
            validate_old(fresh, current_items, protected)
            backup = root / (old['Name'].lstrip('/') + '.json')
            fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as output:
                json.dump(old, output)
                output.flush()
                os.fsync(output.fileno())
            docker('container', 'rm', old['Id'])
            remove_unreferenced(old['Image'], protected_images, owned_container=True)
            print('RETENTION_REMOVED=' + old['Name'] + ';freeBytes=' + str(free_bytes()), flush=True)
        current, keep, _ = select(inventory())
        require(current['Id'] == active['Id'] and {item['Id'] for item in keep} == {item['Id'] for item in retained},
                'RETENTION_PROTECTED_SET_CHANGED')
        require(free_bytes() >= MIN_FREE, 'RETENTION_SPACE_STILL_INSUFFICIENT')
        print('RETENTION_READY=yes;freeBytes=' + str(free_bytes()), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    try:
        main(parser.parse_args().apply)
    except Exception as error:
        message = str(error)
        print(message if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', message) else 'RETENTION_FAILED', file=sys.stderr)
        sys.exit(1)
