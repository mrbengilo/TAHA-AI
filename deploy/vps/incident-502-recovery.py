"""Bounded recovery of the positively identified dead TAHA runtime; no queue writes."""
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import time

EXPECTED_IMAGE = 'tahashoes-taha-ai:2a7f08279db22c5d2966d8ff39559815ce811819'
EXPECTED_ID = '9eb00e54202e'


def run(args, timeout=20):
    try:
        p = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError):
        raise SystemExit('COMMAND_UNAVAILABLE_OR_TIMEOUT: ' + args[0])
    return p.returncode, p.stdout, p.stderr


def emit(key, value):
    print(key + '=' + json.dumps(value, ensure_ascii=False, separators=(',', ':')), flush=True)


def inspect():
    rc, out, _ = run(['docker', 'inspect', 'taha-ai'])
    if rc:
        raise SystemExit('TARGET_CONTAINER_MISSING')
    return json.loads(out)[0]


def check_identity(item):
    if not item['Id'].startswith(EXPECTED_ID) or item['Config']['Image'] != EXPECTED_IMAGE:
        raise SystemExit('TARGET_CONTAINER_CHANGED; refusing recovery')


def code(url, secret=None, origin=False):
    args = ['curl', '-sS', '--max-time', '6', '--connect-timeout', '3', '-o', '/dev/null', '-w', '%{http_code}']
    if secret:
        args += ['-H', 'Authorization: Bearer ' + secret]
    if origin:
        args += ['--resolve', 'tahashoes.store:443:127.0.0.1']
    rc, out, _ = run(args + [url], timeout=9)
    return out.strip() if rc == 0 else '000'


def main():
    os.umask(0o077)
    with open('/var/lock/taha-ai-release.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('RELEASE_IN_PROGRESS; refusing recovery')
        original = inspect()
        check_identity(original)
        secret = ''
        for line in Path('/etc/taha-ai/.dev.vars').read_text().splitlines():
            key, sep, value = line.partition('=')
            if sep and key.strip() == 'INTERNAL_API_SECRET':
                secret = value.strip().strip('\"\'')
                break
        if not secret:
            raise SystemExit('INTERNAL_API_SECRET_MISSING')
        initial = [code('http://127.0.0.1:8787/api/integrations', secret) for _ in range(3)]
        emit('BEFORE_AUTH_HTTP', initial)
        if any(value != '000' for value in initial):
            raise SystemExit('APP_RESPONDING; no restart performed')
        if not original.get('State', {}).get('OOMKilled'):
            raise SystemExit('EXPECTED_OOM_EVIDENCE_CHANGED; refusing recovery')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup = Path('/var/backups/taha-ai') / ('incident-502-' + stamp)
        backup.mkdir(mode=0o700, parents=True)
        for file, args in [
            ('container.json', ['docker', 'inspect', 'taha-ai']),
            ('runtime.log', ['docker', 'logs', '--tail', '300', 'taha-ai']),
            ('processes.txt', ['docker', 'top', 'taha-ai', '-eo', 'pid,ppid,comm,rss']),
            ('kernel-memory.log', ['journalctl', '-k', '--since', '2 days ago', '--no-pager', '-o', 'cat']),
        ]:
            rc, out, err = run(args, timeout=25)
            text = out + err
            if file == 'kernel-memory.log':
                text = '\n'.join(line for line in text.splitlines() if re.search('oom-kill|Out of memory|Killed process', line))[-16000:]
                emit('KERNEL_MEMORY_EVENTS', text.splitlines()[-12:])
            if file == 'processes.txt':
                emit('BEFORE_PROCESS_NAMES', out.strip())
            (backup / file).write_text(text)
        emit('EVIDENCE_BACKUP', str(backup))
        active, _, _ = run(['systemctl', 'is-active', '--quiet', 'taha-ai-cron.timer'])
        timer_was_active = active == 0
        restarted = False
        healthy = False
        timer_stopped = False
        try:
            rc, _, _ = run(['systemctl', 'stop', 'taha-ai-cron.timer'])
            if rc:
                raise SystemExit('CANNOT_PAUSE_CRON_TIMER')
            timer_stopped = True
            _, state, _ = run(['systemctl', 'show', 'taha-ai-cron.service', '-p', 'ActiveState', '--value'])
            if state.strip() in ('active', 'activating', 'deactivating'):
                raise SystemExit('CRON_IN_FLIGHT; refusing restart')
            check_identity(inspect())
            # Restart the same container/image/volumes once; no rebuild, rollback or requeue.
            restarted = True
            rc, _, _ = run(['docker', 'restart', '--time', '30', 'taha-ai'], timeout=45)
            if rc:
                raise SystemExit('CONTAINER_RESTART_FAILED')
            for _ in range(20):
                if code('http://127.0.0.1:8787/api/integrations', secret) == '200':
                    healthy = True
                    break
                time.sleep(3)
            if not healthy:
                raise SystemExit('APP_HEALTH_NOT_RESTORED; no further restarts')
            results = {}
            for path in ['/', '/products', '/content', '/connections', '/settings/post-template', '/api/post-template']:
                results[path] = code('http://127.0.0.1:8787' + path, secret)
            emit('AUTHENTICATED_APP_HTTP', results)
            if any(value != '200' for value in results.values()):
                healthy = False
                raise SystemExit('REQUIRED_ROUTE_NOT_HEALTHY')
            final = inspect()
            check_identity(final)
            emit('AFTER_CONTAINER', {'id': final['Id'][:12], 'image': final['Config']['Image'], 'running': final['State']['Running'], 'oomKilled': final['State']['OOMKilled'], 'startedAt': final['State']['StartedAt']})
            rc, out, err = run(['docker', 'exec', 'tahashoes-nginx', 'sh', '-c', 'wget -S -O /dev/null -T 8 http://taha-ai:8787/ 2>&1'], timeout=12)
            emit('NGINX_TO_APP', {'exit': rc, 'result': [line.strip() for line in (out + err).splitlines() if re.search('HTTP/|Connecting to|refused|timed out', line)][:8]})
            if rc:
                healthy = False
                raise SystemExit('NGINX_TO_APP_NOT_HEALTHY')
            emit('HTTPS_ORIGIN_UNAUTHENTICATED', code('https://tahashoes.store/', origin=True))
            emit('HTTPS_PUBLIC_UNAUTHENTICATED', code('https://tahashoes.store/'))
            # Verify data read-only; do not reset/requeue/modify any publish jobs.
            for database in Path('/var/lib/taha-ai').rglob('*.sqlite'):
                with sqlite3.connect(f'file:{database}?mode=ro', uri=True, timeout=3) as db:
                    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                    if 'publish_jobs' not in tables or 'products' not in tables:
                        continue
                    quick = [row[0] for row in db.execute('PRAGMA quick_check')]
                    emit('DATABASE_QUICK_CHECK', quick)
                    emit('DATABASE_COUNTS', {table: db.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0] for table in ['products', 'product_articles', 'content_drafts', 'publish_jobs', 'post_templates'] if table in tables})
                    if quick != ['ok']:
                        healthy = False
                        raise SystemExit('DATABASE_CHECK_FAILED')
            emit('RECOVERY', 'same container restarted once; no application source, queue, schedule or product writes')
        finally:
            if timer_stopped and timer_was_active and (healthy or not restarted):
                rc, _, _ = run(['systemctl', 'start', 'taha-ai-cron.timer'])
                emit('CRON_TIMER_RESTORED', rc == 0)
            elif timer_stopped:
                emit('CRON_TIMER_LEFT_STOPPED', 'was inactive' if not timer_was_active else 'runtime still unhealthy; manual investigation required')


if __name__ == '__main__':
    main()
