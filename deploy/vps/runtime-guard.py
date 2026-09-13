#!/usr/bin/env python3
"""TAHA runtime guard v1. Read-only unless a dead, OOM-marked runtime is confirmed.

Never rewrites application data, retries a publish, restarts a responsive server,
or interrupts a release/live lease. Recovery is bounded and fails closed.
"""
import argparse
from contextlib import closing
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request

STATE = Path('/var/lib/taha-ai-runtime-guard/state.json')
DISABLED = Path('/etc/taha-ai/runtime-guard.disabled')
DATA = Path('/var/lib/taha-ai')
ENV = Path('/etc/taha-ai/.dev.vars')
REPO = '/var/www/taha-ai'
COOLDOWN = 600
HOURLY_LIMIT = 2


def emit(event, **data):
    print(json.dumps({'event': event, 'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), **data}, separators=(',', ':')), flush=True)


def run(args, timeout=15):
    # Never echo command arguments: some callers hold authenticated headers.
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError('COMMAND_TIMEOUT_OR_UNAVAILABLE') from None
    if result.returncode:
        raise RuntimeError('COMMAND_FAILED_' + Path(args[0]).name) from None
    return result.stdout.strip()


def inspect():
    item = json.loads(run(['docker', 'inspect', 'taha-ai']))[0]
    image = item.get('Config', {}).get('Image', '')
    match = re.fullmatch(r'tahashoes-taha-ai:([0-9a-f]{40})', image)
    if not match or not re.fullmatch(r'[0-9a-f]{64}', item.get('Id', '')):
        raise RuntimeError('UNRECOGNIZED_CONTAINER')
    mounts = {m['Destination']: m['Source'] for m in item.get('Mounts', [])}
    if mounts.get('/data') != str(DATA) or mounts.get('/app/.dev.vars') != str(ENV):
        raise RuntimeError('UNRECOGNIZED_MOUNTS')
    if run(['git', '-C', REPO, 'rev-parse', 'HEAD']) != match[1]:
        raise RuntimeError('SOURCE_IMAGE_MISMATCH')
    return item


def secret():
    for line in ENV.read_text().splitlines():
        k, sep, v = line.partition('=')
        if sep and k.strip() == 'INTERNAL_API_SECRET':
            value = v.strip().strip('\"\'')
            if value:
                return value
    raise RuntimeError('SECRET_UNAVAILABLE')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def probe(token, path='/api/integrations'):
    request = urllib.request.Request('http://127.0.0.1:8787' + path,
                                     headers={'Authorization': 'Bearer ' + token})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except (urllib.error.URLError, OSError, TimeoutError):
        return 0


def has_listener(item):
    pid = int(item['State']['Pid'])
    if pid <= 1:
        raise RuntimeError('INVALID_CONTAINER_PID')
    # Inspect the container network namespace, not docker-proxy's host listener.
    for family in ('tcp', 'tcp6'):
        for line in Path(f'/proc/{pid}/net/{family}').read_text().splitlines()[1:]:
            cols = line.split()
            if len(cols) >= 4 and cols[1].endswith(':2253') and cols[3] == '0A':
                return True
    return False


def decision(item, statuses, listener, state, now):
    if statuses and all(s == 200 for s in statuses):
        return 'healthy'
    if len(statuses) != 3 or any(s != 0 for s in statuses):
        return 'not-confirmed-dead'
    if not item['State'].get('Running') or not item['State'].get('OOMKilled') or listener:
        return 'not-confirmed-oom'
    if state.get('blocked'):
        return 'recovery-latched'
    attempts = [float(t) for t in state.get('attempts', []) if now - float(t) < 3600]
    if len(attempts) >= HOURLY_LIMIT or (attempts and now - max(attempts) < COOLDOWN):
        return 'recovery-rate-limited'
    return 'recover'


def cron_busy():
    return run(['systemctl', 'show', 'taha-ai-cron.service', '-p', 'ActiveState', '--value']) in ('active', 'activating', 'deactivating')


def database_busy(root=DATA, now=None):
    now = int(time.time() * 1000) if now is None else now
    found = 0
    for path in root.rglob('*.sqlite'):
        with closing(sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=2)) as db:
            db.execute('PRAGMA query_only=ON')
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if 'publish_jobs' not in tables or 'automation_steps' not in tables:
                continue
            found += 1
            for table, status in (('publish_jobs', 'publishing'), ('automation_steps', 'processing')):
                live = db.execute(f'SELECT COUNT(*) FROM {table} WHERE status=? AND (lease_expires_at IS NULL OR lease_expires_at>?)', (status, now)).fetchone()[0]
                if live:
                    return True
    if not found:
        raise RuntimeError('DATABASE_NOT_FOUND')
    return False


def read_state():
    if not STATE.exists():
        return {'attempts': [], 'blocked': False}
    value = json.loads(STATE.read_text())
    if not isinstance(value, dict) or not isinstance(value.get('attempts'), list):
        raise RuntimeError('INVALID_GUARD_STATE')
    return value


def write_state(value):
    STATE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = STATE.with_suffix('.tmp')
    temp.write_text(json.dumps(value))
    os.chmod(temp, 0o600)
    temp.replace(STATE)


def metrics(item):
    # Process names and RSS only; no credentials or request contents in journald.
    try:
        # Docker needs PID in ps output to map processes to this container.
        output = run(['docker', 'top', 'taha-ai', '-eo', 'pid,ppid,comm,rss'])
    except RuntimeError:
        emit('METRICS_UNAVAILABLE', healthUnaffected=True)
        return
    rss = {}
    for line in output.splitlines()[1:]:
        cols = line.split()
        if len(cols) == 4 and cols[3].isdigit():
            rss[cols[2]] = rss.get(cols[2], 0) + int(cols[3])
    mem = dict(re.findall(r'^(MemAvailable|SwapFree|SwapTotal):\s+(\d+)', Path('/proc/meminfo').read_text(), re.M))
    emit('RUNTIME_METRICS', image=item['Config']['Image'], rssKiB=rss, hostKiB=mem)


def preserve_evidence(item):
    folder = Path('/var/backups/taha-ai') / ('guard-oom-' + str(int(time.time())))
    folder.mkdir(mode=0o700, parents=True, exist_ok=False)
    # Full container data may contain secrets: keep only under root-private backup.
    (folder / 'container.json').write_text(json.dumps(item))
    try:
        p = subprocess.run(['docker', 'logs', '--tail', '150', 'taha-ai'], capture_output=True, text=True, timeout=10)
        (folder / 'runtime.log').write_text((p.stdout + p.stderr)[-100000:])
    except (OSError, subprocess.TimeoutExpired):
        pass
    emit('EVIDENCE_SAVED', path=str(folder))


def recover(item, token, state):
    if cron_busy() or database_busy():
        emit('RECOVERY_DEFERRED', reason='active-cron-or-lease')
        return 0
    timer_was_active = run(['systemctl', 'show', 'taha-ai-cron.timer', '-p', 'ActiveState', '--value']) == 'active'
    attempted, healthy = False, False
    run(['systemctl', 'stop', 'taha-ai-cron.timer'])
    try:
        # Recheck after pausing the timer: a due tick may have raced the first check.
        current = inspect()
        if current['Id'] != item['Id'] or current['State']['StartedAt'] != item['State']['StartedAt']:
            emit('RECOVERY_DEFERRED', reason='container-changed')
            return 0
        if cron_busy() or database_busy() or probe(token) != 0 or has_listener(current):
            emit('RECOVERY_DEFERRED', reason='state-changed')
            return 0
        preserve_evidence(current)
        now = time.time()
        state['attempts'] = [t for t in state.get('attempts', []) if now - float(t) < 3600] + [now]
        # Persist the latch before restart: crashes cannot cause an infinite restart loop.
        state['blocked'] = True
        state['resumeTimer'] = timer_was_active
        write_state(state)
        attempted = True
        run(['docker', 'restart', '--time', '30', 'taha-ai'], timeout=50)
        for _ in range(20):
            if probe(token) == 200:
                healthy = True
                break
            time.sleep(2)
        if healthy:
            checked = inspect()
            healthy = (checked['Id'] == item['Id'] and not checked['State']['OOMKilled']
                       and probe(token, '/settings/post-template') == 200)
        if not healthy:
            emit('RECOVERY_FAILED', latched=True, cronLeftStopped=True)
            return 2
        state['blocked'] = False
        state['resumeTimer'] = False
        write_state(state)
        emit('RECOVERY_SUCCEEDED', container=item['Id'][:12], queueWrites=0)
        return 0
    finally:
        if timer_was_active and (healthy or not attempted):
            run(['systemctl', 'start', 'taha-ai-cron.timer'])
            emit('CRON_TIMER_RESTORED')


def main(check_only=False):
    os.umask(0o077)
    if DISABLED.exists():
        emit('GUARD_DISABLED')
        return 0
    with open('/var/lock/taha-ai-release.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            emit('RELEASE_IN_PROGRESS')
            return 0
        item = inspect()
        token = secret()
        statuses = [probe(token)]
        if statuses[0] == 200:
            emit('HEALTHY', http=200)
            metrics(item)
            return 0
        for _ in range(2):
            time.sleep(3)
            statuses.append(probe(token))
        state = read_state()
        reason = decision(item, statuses, has_listener(item), state, time.time())
        emit('GUARD_DECISION', reason=reason, statuses=statuses, oomKilled=item['State']['OOMKilled'], checkOnly=check_only)
        if reason != 'recover' or check_only:
            return 2
        return recover(item, token, state)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    try:
        raise SystemExit(main(args.check_only))
    except (RuntimeError, OSError, ValueError, KeyError, sqlite3.Error):
        # Exception messages can include command payloads; report no secrets.
        emit('GUARD_ERROR', action='no-unverified-recovery')
        raise SystemExit(2)
