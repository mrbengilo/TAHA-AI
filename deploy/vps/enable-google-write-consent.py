"""Request the Drive scope needed by the authorized image workflow; never grant it."""
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ENV_PATH = Path('/etc/taha-ai/.dev.vars')
IMAGE = 'tahashoes-taha-ai:b723d97c5bbb098a8aae6d48117e8421ec3a2473'
DRIVE = 'https://www.googleapis.com/auth/drive'


def edit_scopes(text):
    lines = text.splitlines(keepends=True)
    indices = [index for index, line in enumerate(lines) if line.partition('=')[0].strip() == 'GOOGLE_OAUTH_SCOPES']
    if len(indices) != 1: raise RuntimeError('GOOGLE_SCOPE_CONFIG_AMBIGUOUS')
    index = indices[0]
    scopes = lines[index].partition('=')[2].strip().strip('"\'').split()
    if DRIVE in scopes: return text
    scopes = [scope for scope in scopes if scope != DRIVE + '.readonly']
    scopes.append(DRIVE)
    lines[index] = 'GOOGLE_OAUTH_SCOPES="' + ' '.join(scopes) + '"\n'
    return ''.join(lines)


def command(*args):
    try: return subprocess.run(args, check=True, capture_output=True, text=True, timeout=90).stdout.strip()
    except subprocess.SubprocessError: raise RuntimeError('GOOGLE_SCOPE_RUNTIME_COMMAND_FAILED') from None


def write_env(text):
    temporary = ENV_PATH.with_name('.dev.vars.google-write-tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(text); output.flush(); os.fsync(output.fileno())
    os.replace(temporary, ENV_PATH)


def health(secret):
    request = Request('http://127.0.0.1:8787/api/integrations', headers={'Authorization': 'Bearer ' + secret})
    for _ in range(30):
        try:
            with urlopen(request, timeout=3) as response:
                if response.status == 200: return True
        except (OSError, HTTPError): pass
        time.sleep(2)
    return False


def main():
    with open('/var/lock/taha-ai-release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if command('docker', 'inspect', 'taha-ai', '--format', '{{.Config.Image}}|{{.State.Status}}') != IMAGE + '|running':
            raise RuntimeError('GOOGLE_SCOPE_DEPLOYMENT_CHANGED')
        before = ENV_PATH.read_text()
        after = edit_scopes(before)
        if before == after:
            print('GOOGLE_WRITE_CONSENT_ALREADY_REQUESTED=yes'); return
        settings = {line.partition('=')[0].strip(): line.partition('=')[2].strip().strip('"\'') for line in before.splitlines() if '=' in line}
        secret = settings.get('INTERNAL_API_SECRET')
        if not secret: raise RuntimeError('GOOGLE_SCOPE_HEALTH_SECRET_MISSING')
        for path in Path('/var/lib/taha-ai').rglob('*.sqlite'):
            with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
                if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='publish_jobs'").fetchone():
                    if db.execute("SELECT count(*) FROM publish_jobs WHERE status='publishing'").fetchone()[0]:
                        raise RuntimeError('GOOGLE_SCOPE_PUBLISH_IN_FLIGHT')
        was_active = subprocess.run(['systemctl', 'is-active', '--quiet', 'taha-ai-cron.timer']).returncode == 0
        changed = False
        stopped = False
        try:
            command('systemctl', 'stop', 'taha-ai-cron.timer')
            for _ in range(30):
                state = command('systemctl', 'show', 'taha-ai-cron.service', '-p', 'ActiveState', '--value')
                if state not in ('active', 'activating', 'deactivating'): break
                time.sleep(1)
            else: raise RuntimeError('GOOGLE_SCOPE_CRON_IN_FLIGHT')
            backup = Path('/var/backups/taha-ai') / ('google-write-consent-' + str(int(time.time())) + '.dev.vars')
            fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as output:
                output.write(before); output.flush(); os.fsync(output.fileno())
            command('docker', 'stop', '--time', '60', 'taha-ai'); stopped = True
            write_env(after); changed = True
            command('docker', 'start', 'taha-ai'); stopped = False
            if not health(secret): raise RuntimeError('GOOGLE_SCOPE_HEALTH_FAILED')
            mounted = command('docker', 'exec', 'taha-ai', 'node', '-e', "const fs=require('fs');const row=fs.readFileSync('/app/.dev.vars','utf8').split(/\\r?\\n/).find(x=>x.startsWith('GOOGLE_OAUTH_SCOPES='));const scopes=row.split('=').slice(1).join('=').replace(/[\"']/g,'').trim().split(/\\s+/);if(!scopes.includes('https://www.googleapis.com/auth/drive'))process.exit(1);process.stdout.write('verified');")
            if mounted != 'verified': raise RuntimeError('GOOGLE_SCOPE_MOUNT_STALE')
            print('GOOGLE_WRITE_CONSENT_REQUEST_CONFIGURED=yes', flush=True)
            print('GOOGLE_ACCOUNT_GRANT_STILL_REQUIRED=yes', flush=True)
            print('GOOGLE_SCOPE_AUTHENTICATED_HEALTH_OK=yes', flush=True)
        except Exception:
            if changed:
                command('docker', 'stop', '--time', '60', 'taha-ai')
                write_env(before)
                command('docker', 'start', 'taha-ai')
                health(secret)
            elif stopped: command('docker', 'start', 'taha-ai')
            raise
        finally:
            if was_active: command('systemctl', 'start', 'taha-ai-cron.timer')


if __name__ == '__main__':
    try: main()
    except Exception as error:
        message = str(error)
        print(message if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', message) else 'GOOGLE_SCOPE_UPDATE_FAILED', file=sys.stderr)
        sys.exit(1)
