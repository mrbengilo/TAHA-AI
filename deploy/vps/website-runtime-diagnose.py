"""Read-only, fixed-scope production diagnosis. Never print Docker config/env/source."""
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

BASE = Path('/var/www/tahashoes')
COMPOSE = BASE / 'docker-compose.yml'
EXPECTED_ADAPTER_SHA256 = 'ee5402635798ae3658054efdc99baa34cf217385d8911922e084d47f69adf646'
LABELS = {
    'com.docker.compose.project': 'tahashoes',
    'com.docker.compose.service': 'backend',
    'com.docker.compose.project.working_dir': str(BASE),
    'com.docker.compose.project.config_files': str(COMPOSE),
}


class CommandFailure(Exception):
    def __init__(self, code):
        self.returncode = code


def command(args, timeout=30):
    result = subprocess.run(args, capture_output=True, timeout=timeout)
    if result.returncode:
        raise CommandFailure(result.returncode)
    return result.stdout


def digest(data):
    return hashlib.sha256(data).hexdigest()


def source_info(path):
    if not path.is_file():
        return {'exists': False}
    data = path.read_bytes()
    return {'exists': True, 'sha256': digest(data), 'bytes': len(data)}


def container_state():
    row = json.loads(command(['docker', 'inspect', 'tahashoes-backend']))[0]
    config = row.get('Config', {})
    env = dict(item.split('=', 1) for item in config.get('Env', []) if '=' in item)
    labels = config.get('Labels', {})
    return {
        'container': 'tahashoes-backend',
        'containerId': row.get('Id'),
        'imageId': row.get('Image'),
        'createdAt': row.get('Created'),
        'running': row.get('State', {}).get('Running') is True,
        'healthy': row.get('State', {}).get('Health', {}).get('Status') == 'healthy',
        'hasHealthcheck': bool(config.get('Healthcheck')),
        'receiverSecretPresent': bool(str(env.get('TAHA_WEBHOOK_SECRET') or '').strip()),
        'composeIdentityMatches': {key: labels.get(key) == value for key, value in LABELS.items()},
        'mounts': [{'destination': item['Destination'], 'writable': item.get('RW') is True}
                   for item in row.get('Mounts', [])],
    }


def host_source_state():
    adapter = BASE / 'gosporty-backend/handlers/product_receiver.go'
    article = BASE / 'gosporty-backend/handlers/article.go'
    source = article.read_text() if article.is_file() else ''
    hook = source.find('if tryPublishWebsiteProduct(w, r, body, idempotencyKey)')
    signature = source.find('if !validWebsiteSignature(r, secret, body)')
    legacy = source.find('var payload websiteArticlePayload')
    info = source_info(adapter)
    info['matchesReviewedAdapter'] = info.get('sha256') == EXPECTED_ADAPTER_SHA256
    return {'composeFile': source_info(COMPOSE), 'adapter': info, 'article': source_info(article),
            'hookAfterSignatureBeforeLegacyDecoder': 0 <= signature < hook < legacy,
            'backendEnvFileExists': (BASE / 'gosporty-backend/.env').is_file()}


def container_source_state(name):
    result = subprocess.run(['docker', 'exec', 'tahashoes-backend', 'sha256sum',
                             '/app/handlers/' + name], capture_output=True, timeout=10)
    match = re.match(rb'([0-9a-f]{64})\s', result.stdout) if result.returncode == 0 else None
    return {'containerSource_' + name: match[1].decode() if match else None,
            'containerSourceReturnCode_' + name: result.returncode}


def binary_state():
    binary = subprocess.run(['docker', 'exec', 'tahashoes-backend', 'go', 'tool', 'nm', '/app/server'],
                            capture_output=True, timeout=20)
    return {'compiledAdapterSymbolPresent': binary.returncode == 0 and b'.tryPublishWebsiteProduct' in binary.stdout,
            'compiledAdapterSymbolCheckAvailable': binary.returncode == 0, 'binaryCheckReturnCode': binary.returncode}


def cron_state():
    timer = subprocess.run(['systemctl', 'is-active', 'taha-ai-cron.timer'], capture_output=True, timeout=10)
    service = subprocess.run(['systemctl', 'is-active', 'taha-ai-cron.service'], capture_output=True, timeout=10)
    return {'cronTimerActive': timer.stdout.strip() == b'active', 'cronTimerReturnCode': timer.returncode,
            'cronServiceActive': service.stdout.strip() == b'active', 'cronServiceReturnCode': service.returncode}


def disk_state():
    fs = os.statvfs('/')
    ids = command(['docker', 'container', 'ls', '-aq']).decode().split()
    containers = json.loads(command(['docker', 'inspect', *ids])) if ids else []
    images = command(['docker', 'image', 'ls', '--no-trunc', '--format', '{{json .}}']).decode().splitlines()
    rows = [json.loads(line) for line in images if line.strip()]
    return {
        'diskFreeBytes': fs.f_bavail * fs.f_frsize,
        'containerImages': [{'name': row.get('Name'), 'imageId': row.get('Image'),
                             'status': (row.get('State') or {}).get('Status')}
                            for row in containers],
        'tahaImageInventory': [{key: row.get(key) for key in ('Repository', 'Tag', 'ID', 'Size', 'CreatedAt')}
                               for row in rows if row.get('Repository') == 'tahashoes-taha-ai'],
    }


def compose_cli():
    for args in (['docker', 'compose'], ['docker-compose']):
        try:
            result = subprocess.run(args + ['version'], capture_output=True, timeout=10)
        except FileNotFoundError:
            continue
        if result.returncode == 0:
            return args
    raise CommandFailure(127)


def compose_version_state():
    versions = {}
    for name, args in (('plugin', ['docker', 'compose']), ('standalone', ['docker-compose'])):
        try:
            result = subprocess.run(args + ['version'], capture_output=True, timeout=10)
            versions[name] = {'returnCode': result.returncode}
            match = re.search(rb'\bv?([0-9]+\.[0-9]+\.[0-9]+)\b', result.stdout) if result.returncode == 0 else None
            versions[name]['version'] = match[1].decode() if match else None
        except FileNotFoundError:
            versions[name] = {'returnCode': 127, 'version': None}
    return {'composeVersions': versions}


def compose_state():
    # Capture resolved Compose privately. Return only booleans/counts/hashes.
    resolved = json.loads(command(compose_cli() + ['-p', 'tahashoes', '-f', str(COMPOSE),
                                  '--project-directory', str(BASE), 'config', '--format', 'json']))
    backend = resolved.get('services', {}).get('backend', {})
    resolved_env = backend.get('environment') or {}
    return {'composeResolvedSecretPresent': bool(str(resolved_env.get('TAHA_WEBHOOK_SECRET') or '').strip()),
            'composeContainerNameMatches': backend.get('container_name') == 'tahashoes-backend',
            'composeOtherServiceCount': max(0, len(resolved.get('services', {})) - 1)}


def collect_section(state, stage, callback):
    try:
        state.update(callback())
        state['sections'][stage] = {'ok': True}
    except Exception as error:
        # Never print messages, args, stderr, environment, source or exception repr.
        error_class = type(error).__name__
        if error_class not in {'CommandFailure', 'TimeoutExpired', 'FileNotFoundError',
                              'PermissionError', 'JSONDecodeError', 'TypeError', 'KeyError', 'IndexError', 'AttributeError'}:
            error_class = 'UnexpectedError'
        state['sections'][stage] = {'ok': False, 'errorClass': error_class,
                                    'returnCode': getattr(error, 'returncode', None)}
    print('WEBSITE_RUNTIME_PROGRESS=' + json.dumps({'stage': stage, **state['sections'][stage]}), flush=True)


def main():
    state = {'sections': {}}
    for stage, callback in (
        ('container', container_state), ('hostSource', host_source_state),
        ('containerProductSource', lambda: container_source_state('product_receiver.go')),
        ('containerArticleSource', lambda: container_source_state('article.go')),
        ('binary', binary_state), ('cron', cron_state), ('disk', disk_state),
        ('composeVersion', compose_version_state), ('compose', compose_state),
    ):
        collect_section(state, stage, callback)
    # Emit useful sections even if one source/config inspection is unavailable.
    print('WEBSITE_RUNTIME_DIAG=' + json.dumps(state, separators=(',', ':')))
    return int(any(not value['ok'] for value in state['sections'].values()))


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        # Subprocess stderr and JSON errors may include credentials: never relay them.
        sys.exit('WEBSITE_RUNTIME_DIAG_FAILED')
