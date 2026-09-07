"""Reclaim one reviewed rollback image so the already-loaded font release can deploy."""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ACTIVE_REVISION = 'b723d97c5bbb098a8aae6d48117e8421ec3a2473'
ACTIVE_TAG = 'tahashoes-taha-ai:' + ACTIVE_REVISION
ACTIVE_IMAGE = 'sha256:dd5388834f6ac3d385ef8adfa8bee8dfd17fc4a3c2431e1b0d9a3466a71af6ab'
TARGET_REVISION = '010c0193ab4ed57991a60e17aee2925a729ac117'
TARGET_TAG = 'tahashoes-taha-ai:' + TARGET_REVISION
OBSOLETE_REVISION = '4595c781d5ddff484208e85c9dfac6321d69a72b'
OBSOLETE_TAG = 'tahashoes-taha-ai:' + OBSOLETE_REVISION
OBSOLETE_IMAGE = 'sha256:3e0899f3c151878c0cc0942b1af21119258846eb63c4d0fab9093f7e352a7251'
ROLLBACK_NAME = re.compile(r'/taha-ai-rollback-\d{8}-\d{6}(?:-\d+)?')
RELEASE_MINIMUM = 5242880 * 1024
RECOVERY_HEADROOM = 100 * 1024 * 1024
BACKUP = Path('/var/backups/taha-ai/font-release-obsolete-' + OBSOLETE_REVISION[:12] + '.json')


def docker(*args):
    try:
        return subprocess.run(
            ['docker', *args], check=True, capture_output=True, text=True, timeout=90
        ).stdout
    except subprocess.SubprocessError:
        raise RuntimeError('FONT_RECOVERY_DOCKER_FAILED') from None


def inspect(kind, reference):
    return json.loads(docker(kind, 'inspect', reference))[0]


def maybe_image(reference):
    result = subprocess.run(
        ['docker', 'image', 'inspect', reference], capture_output=True, text=True, timeout=90
    )
    if result.returncode == 0:
        return json.loads(result.stdout)[0]
    if 'No such image' in result.stderr:
        return None
    raise RuntimeError('FONT_RECOVERY_DOCKER_FAILED')


def containers():
    identities = docker('container', 'ls', '-aq').split()
    return json.loads(docker('container', 'inspect', *identities)) if identities else []


def validate_protected(items, current, target):
    if (
        current.get('Name') != '/taha-ai'
        or current.get('Image') != ACTIVE_IMAGE
        or current.get('Config', {}).get('Image') != ACTIVE_TAG
        or current.get('State', {}).get('Status') != 'running'
    ):
        raise RuntimeError('FONT_RECOVERY_ACTIVE_RELEASE_CHANGED')
    if (
        target.get('Id') in {ACTIVE_IMAGE, OBSOLETE_IMAGE}
        or (target.get('Config', {}).get('Labels') or {}).get('org.opencontainers.image.revision')
        != TARGET_REVISION
        or TARGET_TAG not in (target.get('RepoTags') or [])
        or any(item.get('Image') == target.get('Id') for item in items)
    ):
        raise RuntimeError('FONT_RECOVERY_TARGET_CHANGED')


def validate(items, current, target, obsolete):
    validate_protected(items, current, target)
    if (
        obsolete.get('Id') != OBSOLETE_IMAGE
        or obsolete.get('RepoTags') != [OBSOLETE_TAG]
        or (obsolete.get('Config', {}).get('Labels') or {}).get('org.opencontainers.image.revision')
        != OBSOLETE_REVISION
    ):
        raise RuntimeError('FONT_RECOVERY_OBSOLETE_IMAGE_CHANGED')

    matches = [item for item in items if item.get('Image') == OBSOLETE_IMAGE]
    if len(matches) != 1:
        raise RuntimeError('FONT_RECOVERY_OBSOLETE_CONTAINER_CHANGED')
    candidate = matches[0]
    if (
        not ROLLBACK_NAME.fullmatch(candidate.get('Name', ''))
        or candidate.get('Config', {}).get('Image') != OBSOLETE_TAG
        or candidate.get('State', {}).get('Status') != 'exited'
        or candidate.get('HostConfig', {}).get('RestartPolicy', {}).get('Name') != 'no'
    ):
        raise RuntimeError('FONT_RECOVERY_OBSOLETE_CONTAINER_CHANGED')

    rollbacks = sorted(
        [item for item in items if ROLLBACK_NAME.fullmatch(item.get('Name', ''))],
        key=lambda item: item.get('Created', ''),
        reverse=True,
    )
    if len(rollbacks) < 4 or candidate.get('Id') in {item.get('Id') for item in rollbacks[:3]}:
        raise RuntimeError('FONT_RECOVERY_ROLLBACK_PROTECTED')

    candidate_names = {
        candidate.get('Name', '').lstrip('/'),
        candidate.get('Id'),
        candidate.get('Id', '')[:12],
    }
    for item in items:
        if item.get('Id') == candidate.get('Id'):
            continue
        references = (item.get('HostConfig', {}).get('VolumesFrom') or []) + (
            item.get('HostConfig', {}).get('Links') or []
        )
        if any(value.split(':')[0].lstrip('/') in candidate_names for value in references):
            raise RuntimeError('FONT_RECOVERY_CONTAINER_REFERENCED')
    return candidate


def main():
    with open('/var/lock/taha-ai-release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current = inspect('container', 'taha-ai')
        target = inspect('image', TARGET_TAG)
        obsolete = maybe_image(OBSOLETE_TAG)
        if obsolete is None:
            validate_protected(containers(), current, target)
            if any(item.get('Image') == OBSOLETE_IMAGE for item in containers()):
                raise RuntimeError('FONT_RECOVERY_IMAGE_STILL_REFERENCED')
            if not BACKUP.is_file() or (BACKUP.stat().st_mode & 0o777) != 0o600:
                raise RuntimeError('FONT_RECOVERY_APPLIED_MARKER_MISSING')
            free = os.statvfs('/').f_bavail * os.statvfs('/').f_frsize
            if free < RELEASE_MINIMUM + RECOVERY_HEADROOM:
                raise RuntimeError('FONT_RECOVERY_HEADROOM_INSUFFICIENT')
            subprocess.run(['systemctl', 'is-active', 'taha-ai-cron.timer'], check=True)
            print('FONT_RECOVERY_ALREADY_APPLIED=yes', flush=True)
            print('FONT_RECOVERY_READY=yes', flush=True)
            return
        candidate = validate(containers(), current, target, obsolete)
        print('FONT_RECOVERY_PLAN=' + candidate['Name'].lstrip('/') + '|' + OBSOLETE_TAG, flush=True)
        if '--apply' not in sys.argv:
            return

        if not BACKUP.exists():
            fd = os.open(BACKUP, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as output:
                json.dump(candidate, output)
                output.flush()
                os.fsync(output.fileno())

        candidate = validate(
            containers(),
            inspect('container', 'taha-ai'),
            inspect('image', TARGET_TAG),
            inspect('image', OBSOLETE_TAG),
        )
        docker('container', 'rm', candidate['Id'])  # No -v: preserve all volumes.
        if any(item.get('Image') == OBSOLETE_IMAGE for item in containers()):
            raise RuntimeError('FONT_RECOVERY_IMAGE_STILL_REFERENCED')
        docker('image', 'rm', OBSOLETE_TAG)

        after = inspect('container', 'taha-ai')
        target_after = inspect('image', TARGET_TAG)
        if (
            after.get('Image') != ACTIVE_IMAGE
            or after.get('State', {}).get('Status') != 'running'
            or target_after.get('Id') != target.get('Id')
        ):
            raise RuntimeError('FONT_RECOVERY_PROTECTED_RESOURCE_CHANGED')
        free = os.statvfs('/').f_bavail * os.statvfs('/').f_frsize
        print('FONT_RECOVERY_FREE_BYTES=' + str(free), flush=True)
        if free < RELEASE_MINIMUM + RECOVERY_HEADROOM:
            raise RuntimeError('FONT_RECOVERY_HEADROOM_INSUFFICIENT')
        subprocess.run(['systemctl', 'is-active', 'taha-ai-cron.timer'], check=True)
        print('FONT_RECOVERY_READY=yes', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error)
        print(
            message if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', message) else 'FONT_RECOVERY_FAILED',
            file=sys.stderr,
        )
        sys.exit(1)
