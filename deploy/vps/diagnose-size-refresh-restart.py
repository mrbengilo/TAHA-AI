"""Safely diagnose and recover the existing TAHA container after catalog quarantine."""
import json
import re
import subprocess
import time


def command(*args, check=False, timeout=30):
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=timeout)


def inspect():
    result = command(
        'docker', 'inspect', 'taha-ai', '--format',
        '{{json .State}}|{{.Config.Image}}|{{.Image}}|{{.RestartCount}}',
    )
    if result.returncode:
        return {'exists': False}
    state_raw, image, image_id, restarts = result.stdout.strip().split('|', 3)
    state = json.loads(state_raw)
    return {
        'exists': True,
        'status': state.get('Status'),
        'running': state.get('Running'),
        'restarting': state.get('Restarting'),
        'exitCode': state.get('ExitCode'),
        'oomKilled': state.get('OOMKilled'),
        'error': bool(state.get('Error')),
        'startedAt': state.get('StartedAt'),
        'finishedAt': state.get('FinishedAt'),
        'image': image,
        'imageId': image_id,
        'restartCount': int(restarts),
    }


def probes():
    values = {}
    for name, route in [('root', '/'), ('api', '/api/integrations')]:
        result = command(
            'curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '4',
            'http://127.0.0.1:8787' + route,
            timeout=8,
        )
        values[name] = result.stdout.strip() or '000'
    return values


def safe_log_signals():
    raw = command('docker', 'logs', '--tail', '240', 'taha-ai', timeout=30).stdout
    raw += command('docker', 'logs', '--tail', '240', 'taha-ai', timeout=30).stderr
    patterns = {
        'databaseLocked': r'database is locked',
        'databaseMalformed': r'database disk image is malformed|malformed database',
        'permissionDenied': r'permission denied|eacces',
        'addressInUse': r'address already in use|eaddrinuse',
        'diskFull': r'no space left|enospc',
        'migrationError': r'migration.*(?:error|fail)|(?:error|fail).*migration',
        'wranglerError': r'wrangler.*(?:error|fail)|(?:error|fail).*wrangler',
        'sqliteError': r'sqlite.*(?:error|fail)|(?:error|fail).*sqlite',
    }
    lowered = raw.lower()
    return {key: bool(re.search(pattern, lowered)) for key, pattern in patterns.items()}


def main():
    command('systemctl', 'stop', 'taha-ai-cron.timer')
    before = inspect()
    if not before.get('exists'):
        raise RuntimeError('SIZE_REFRESH_CONTAINER_MISSING')

    # A stopped or crash-looping container is safe to restart: cron remains disabled.
    if not before.get('running') or before.get('restarting'):
        command('docker', 'restart', '--time', '30', 'taha-ai', check=True, timeout=45)

    healthy = False
    current_probes = probes()
    for _ in range(90):
        current_probes = probes()
        if current_probes == {'root': '200', 'api': '401'}:
            healthy = True
            break
        time.sleep(2)

    after = inspect()
    timer = command('systemctl', 'is-active', 'taha-ai-cron.timer').stdout.strip()
    print('SIZE_REFRESH_RESTART_DIAGNOSTIC=' + json.dumps({
        'before': before,
        'after': after,
        'probes': current_probes,
        'logSignals': safe_log_signals(),
        'cronTimer': timer,
        'healthy': healthy,
    }, separators=(',', ':')), flush=True)
    if timer == 'active':
        raise RuntimeError('SIZE_REFRESH_CRON_UNEXPECTEDLY_ACTIVE')
    if not healthy:
        raise RuntimeError('SIZE_REFRESH_CONTAINER_UNHEALTHY')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error)
        print(message if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', message) else 'SIZE_REFRESH_DIAGNOSTIC_FAILED', flush=True)
        raise SystemExit(1)
