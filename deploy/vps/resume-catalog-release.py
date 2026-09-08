"""Resume the already validated/staged release, preserving generated cache files."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

REPO = Path('/var/www/taha-ai')
OLD = 'bd96ece715a7747b35352420bfb5a8b7dfdbb4b9'
OLD_IMAGE = 'sha256:c8084556bb01da465b5b944d2fc76fb2a2c3f5a1d76dee68ba67f564c547ce3e'
TARGET = '26d691840b041295bc3c1147df49e21fad4eff5a'
IMAGE = 'sha256:612f00141b7ff243c99ad6ce24dc84d0a14264612e6f8b4a321a0890eceab7b2'


def require(value, code):
    if not value:
        raise RuntimeError(code)


def command(args, timeout=60):
    result = subprocess.run(args, capture_output=True, timeout=timeout)
    require(result.returncode == 0, 'CATALOG_RESUME_COMMAND_FAILED')
    return result.stdout


def main():
    with open('/var/lock/taha-ai-release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        head = command(['git', '-C', str(REPO), 'rev-parse', 'HEAD']).decode().strip()
        require(head in (OLD, TARGET), 'CATALOG_RESUME_SOURCE_CHANGED')
        app = json.loads(command(['docker', 'inspect', 'taha-ai']))[0]
        expected_image = OLD_IMAGE if head == OLD else IMAGE
        require(app['Image'] == expected_image and app['State']['Running']
                and app['Config']['Image'] == 'tahashoes-taha-ai:' + head, 'CATALOG_RESUME_APP_CHANGED')
        staged = command(['docker', 'image', 'inspect', 'tahashoes-taha-ai:' + TARGET, '--format', '{{.Id}}']).decode().strip()
        require(staged == IMAGE, 'CATALOG_RESUME_STAGED_IMAGE_CHANGED')
        status = command(['git', '-C', str(REPO), 'status', '--porcelain', '-z', '--untracked-files=all'])
        changes = [part.decode() for part in status.split(b'\0') if part]
        print('CATALOG_RESUME_CHECKOUT=' + json.dumps({'head': head, 'changes': [
            value if re.fullmatch(r'[A-Za-z0-9_ ./?+-]{1,240}', value) else 'UNEXPECTED_PATH' for value in changes]}), flush=True)
        require(len(changes) <= 20, 'CATALOG_RESUME_TOO_MANY_CHANGES')
        files = []
        for value in changes:
            require(re.fullmatch(r'\?\? deploy/vps/__pycache__/[A-Za-z0-9_-]+\.cpython-3\d{1,2}\.pyc', value),
                    'CATALOG_RESUME_USER_CHANGES_PRESERVED')
            source = REPO / value[3:]
            require(source.is_file() and not source.is_symlink() and source.resolve() == source,
                    'CATALOG_RESUME_CACHE_PATH_INVALID')
            require(source.read_bytes()[:4] == importlib.util.MAGIC_NUMBER, 'CATALOG_RESUME_CACHE_FORMAT_INVALID')
            files.append(source)
        if files:
            root = Path('/var/backups/taha-ai')
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            backup = Path(tempfile.mkdtemp(prefix='generated-python-cache-', dir=root))
            for source in files:
                os.replace(source, backup / source.name)
            print('CATALOG_RESUME_CACHE_BACKUP=' + str(backup), flush=True)
        require(not command(['git', '-C', str(REPO), 'status', '--porcelain']), 'CATALOG_RESUME_CHECKOUT_NOT_CLEAN')
        state = os.statvfs('/')
        print('CATALOG_RESUME_FREE_BYTES=' + str(state.f_bavail * state.f_frsize), flush=True)
    if head != TARGET:
        result = subprocess.run(['bash', str(REPO / 'deploy/vps/release.sh'), TARGET,
                                 '/var/tmp/taha-source-' + TARGET + '.bundle', OLD, OLD_IMAGE], timeout=900)
        require(result.returncode == 0, 'CATALOG_RESUME_RELEASE_FAILED')
    result = subprocess.run([sys.executable, '-B', '-u', str(REPO / 'deploy/vps/complete-catalog-publish.py'),
                             '--expected-release-sha', TARGET], timeout=1800)
    require(result.returncode == 0, 'CATALOG_RESUME_PUBLISH_FAILED')


try:
    main()
except Exception as error:
    message = str(error)
    sys.exit(message if re.fullmatch(r'CATALOG_[A-Z_]+', message) else 'CATALOG_RESUME_FAILED')
