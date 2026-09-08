"""Reclaim one obsolete TAHA rollback and resume the staged commerce guide release."""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

REPO = Path('/var/www/taha-ai')
CURRENT = '26d691840b041295bc3c1147df49e21fad4eff5a'
CURRENT_IMAGE = 'sha256:612f00141b7ff243c99ad6ce24dc84d0a14264612e6f8b4a321a0890eceab7b2'
TARGET = 'ce4b8ef574cf83bc0824b88f8609f1ac65082e4d'
TARGET_IMAGE = 'sha256:32dc50c795a8f9fe450441ca54cfde766a079903e0d9ac0bc807acdba0a716b6'
ROLLBACK = re.compile(r'/taha-ai-rollback-202\d{5}-\d{6}(?:-\d+)?')
MIN_FREE = 11 * 1024 ** 3 // 2


def require(value, code):
    if not value:
        raise RuntimeError(code)


def command(args, timeout=120):
    result = subprocess.run(args, capture_output=True, timeout=timeout)
    require(result.returncode == 0, 'COMMERCE_RESUME_COMMAND_FAILED')
    return result.stdout


def inspect(kind, value):
    rows = json.loads(command(['docker', kind, 'inspect', value]))
    require(len(rows) == 1, 'COMMERCE_RESUME_INSPECT_FAILED')
    return rows[0]


def free_bytes():
    state = os.statvfs('/')
    return state.f_bavail * state.f_frsize


def inventory():
    ids = command(['docker', 'container', 'ls', '-aq']).decode().split()
    return [inspect('container', value) for value in ids]


def validate_rollback(item):
    require(ROLLBACK.fullmatch(item['Name']) and item['State']['Status'] == 'exited'
            and item['HostConfig']['RestartPolicy']['Name'] == 'no', 'COMMERCE_RESUME_ROLLBACK_INVALID')
    mounts = {row['Destination']: row for row in item.get('Mounts', [])}
    require(mounts.get('/data', {}).get('Source') == '/var/lib/taha-ai'
            and mounts.get('/app/.dev.vars', {}).get('Source') == '/etc/taha-ai/.dev.vars',
            'COMMERCE_RESUME_DATA_NOT_EXTERNAL')
    require(item['Config']['Image'].startswith('tahashoes-taha-ai:'), 'COMMERCE_RESUME_IMAGE_NOT_OWNED')


def main():
    with open('/var/lock/taha-ai-release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(command(['git', '-C', str(REPO), 'rev-parse', 'HEAD']).decode().strip() == CURRENT,
                'COMMERCE_RESUME_SOURCE_CHANGED')
        require(not command(['git', '-C', str(REPO), 'status', '--porcelain']), 'COMMERCE_RESUME_CHECKOUT_CHANGED')
        active = inspect('container', 'taha-ai')
        require(active['Image'] == CURRENT_IMAGE and active['State']['Running']
                and active['Config']['Image'] == 'tahashoes-taha-ai:' + CURRENT,
                'COMMERCE_RESUME_ACTIVE_CHANGED')
        target = inspect('image', 'tahashoes-taha-ai:' + TARGET)
        require(target['Id'] == TARGET_IMAGE
                and target['Config']['Labels'].get('org.opencontainers.image.revision') == TARGET,
                'COMMERCE_RESUME_TARGET_CHANGED')
        items = inventory()
        rollbacks = sorted([item for item in items if ROLLBACK.fullmatch(item['Name'])],
                           key=lambda item: item['Created'], reverse=True)
        require(len(rollbacks) >= 4, 'COMMERCE_RESUME_ROLLBACK_COUNT_LOW')
        for item in rollbacks:
            validate_rollback(item)
        backup_root = Path('/var/backups/taha-ai')
        backup_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        backup = Path(tempfile.mkdtemp(prefix='commerce-retention-', dir=backup_root))
        removed = 0
        protected_images = {active['Image'], target['Id'], *(item['Image'] for item in rollbacks[:3])}
        for old in reversed(rollbacks[3:]):
            if free_bytes() >= MIN_FREE:
                break
            fresh = inspect('container', old['Id'])
            require(fresh == old, 'COMMERCE_RESUME_ROLLBACK_CHANGED')
            path = backup / (old['Name'].lstrip('/') + '.json')
            path.write_text(json.dumps(old)); path.chmod(0o600)
            command(['docker', 'container', 'rm', old['Id']])
            if old['Image'] not in protected_images and not any(item['Image'] == old['Image'] for item in inventory()):
                image = inspect('image', old['Image'])
                tags = image.get('RepoTags') or []
                require(all(tag.startswith('tahashoes-taha-ai:') and not tag.endswith(':latest') for tag in tags),
                        'COMMERCE_RESUME_IMAGE_TAG_INVALID')
                for tag in tags:
                    command(['docker', 'image', 'rm', tag])
            removed += 1
            print('COMMERCE_RESUME_REMOVED=' + old['Name'], flush=True)
        require(free_bytes() >= MIN_FREE, 'COMMERCE_RESUME_SPACE_LOW')
        print('COMMERCE_RESUME_READY=' + json.dumps({'removed': removed, 'freeBytes': free_bytes(),
              'keptRollbacks': 3, 'backup': str(backup)}), flush=True)
    bundle = '/var/tmp/taha-source-' + TARGET + '.bundle'
    result = subprocess.run(['bash', str(REPO / 'deploy/vps/release.sh'), TARGET, bundle, CURRENT, CURRENT_IMAGE], timeout=1200)
    require(result.returncode == 0, 'COMMERCE_RESUME_RELEASE_FAILED')


try:
    main()
except Exception as error:
    message = str(error)
    sys.exit(message if re.fullmatch(r'COMMERCE_[A-Z_]+', message) else 'COMMERCE_RESUME_FAILED')
