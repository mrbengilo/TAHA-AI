"""Move only verified generated Python bytecode out of the deploy checkout."""
import argparse
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
BACKUP_ROOT = Path('/var/backups/taha-ai')
CHANGE = re.compile(r'\?\? deploy/vps/__pycache__/[A-Za-z0-9_.-]+\.cpython-3\d{1,2}\.pyc')


def require(value, code):
    if not value:
        raise RuntimeError(code)


def command(args):
    result = subprocess.run(args, capture_output=True, timeout=30)
    require(result.returncode == 0, 'GENERATED_CACHE_COMMAND_FAILED')
    return result.stdout


def checkout_changes():
    raw = command(['git', '-C', str(REPO), 'status', '--porcelain=v1', '-z', '--untracked-files=all'])
    return [part.decode() for part in raw.split(b'\0') if part]


def verified_cache_files(changes):
    require(len(changes) <= 20, 'GENERATED_CACHE_TOO_MANY_CHANGES')
    files = []
    cache_root = (REPO / 'deploy/vps/__pycache__').resolve()
    for change in changes:
        require(CHANGE.fullmatch(change), 'GENERATED_CACHE_USER_CHANGES_PRESERVED')
        source = REPO / change[3:]
        require(source.is_file() and not source.is_symlink(), 'GENERATED_CACHE_PATH_INVALID')
        require(source.resolve().parent == cache_root, 'GENERATED_CACHE_PATH_INVALID')
        require(source.read_bytes()[:4] == importlib.util.MAGIC_NUMBER, 'GENERATED_CACHE_FORMAT_INVALID')
        files.append(source)
    return files


def main(args):
    with open('/var/lock/taha-ai-release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        changes = checkout_changes()
        print('GENERATED_CACHE_CHECKOUT=' + json.dumps({'changes': changes}, separators=(',', ':')), flush=True)
        files = verified_cache_files(changes)
        if not files:
            print('GENERATED_CACHE_CLEAN=yes', flush=True)
            return
        require(args.apply, 'GENERATED_CACHE_APPLY_REQUIRED')
        BACKUP_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
        backup = Path(tempfile.mkdtemp(prefix='generated-python-cache-', dir=BACKUP_ROOT))
        for source in files:
            os.replace(source, backup / source.name)
        require(not checkout_changes(), 'GENERATED_CACHE_CHECKOUT_NOT_CLEAN')
        print('GENERATED_CACHE_BACKUP=' + str(backup), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    try:
        main(parser.parse_args())
    except Exception as error:
        message = str(error)
        sys.exit(message if re.fullmatch(r'GENERATED_CACHE_[A-Z0-9_]+', message) else 'GENERATED_CACHE_FAILED')
