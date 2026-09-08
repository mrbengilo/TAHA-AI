"""Read-only, fixed-scope production diagnosis. Never print Docker config/env/source."""
import hashlib
import json
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


def command(args, timeout=30):
    result = subprocess.run(args, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('WEBSITE_DIAG_COMMAND_FAILED')
    return result.stdout


def digest(data):
    return hashlib.sha256(data).hexdigest()


def source_info(path):
    if not path.is_file():
        return {'exists': False}
    data = path.read_bytes()
    return {'exists': True, 'sha256': digest(data), 'bytes': len(data)}


def main():
    row = json.loads(command(['docker', 'inspect', 'tahashoes-backend']))[0]
    config = row.get('Config', {})
    env = dict(item.split('=', 1) for item in config.get('Env', []) if '=' in item)
    labels = config.get('Labels', {})
    adapter = BASE / 'gosporty-backend/handlers/product_receiver.go'
    article = BASE / 'gosporty-backend/handlers/article.go'
    source = article.read_text() if article.is_file() else ''
    hook = source.find('if tryPublishWebsiteProduct(w, r, body, idempotencyKey)')
    signature = source.find('if !validWebsiteSignature(r, secret, body)')
    legacy = source.find('var payload websiteArticlePayload')
    info = source_info(adapter)
    info['matchesReviewedAdapter'] = info.get('sha256') == EXPECTED_ADAPTER_SHA256
    state = {
        'container': 'tahashoes-backend',
        'containerId': row.get('Id'),
        'imageId': row.get('Image'),
        'createdAt': row.get('Created'),
        'running': row.get('State', {}).get('Running') is True,
        'healthy': row.get('State', {}).get('Health', {}).get('Status') == 'healthy',
        'hasHealthcheck': bool(config.get('Healthcheck')),
        'receiverSecretPresent': bool(env.get('TAHA_WEBHOOK_SECRET', '').strip()),
        'composeIdentityMatches': {key: labels.get(key) == value for key, value in LABELS.items()},
        'composeFile': source_info(COMPOSE),
        'adapter': info,
        'article': source_info(article),
        'hookAfterSignatureBeforeLegacyDecoder': 0 <= signature < hook < legacy,
        'backendEnvFileExists': (BASE / 'gosporty-backend/.env').is_file(),
        'mounts': [{'destination': item['Destination'], 'writable': item.get('RW') is True}
                   for item in row.get('Mounts', [])],
    }
    # Source embedded in the running image is independent of the current host checkout.
    for name in ('product_receiver.go', 'article.go'):
        result = subprocess.run(['docker', 'exec', 'tahashoes-backend', 'sha256sum',
                                 '/app/handlers/' + name], capture_output=True, timeout=10)
        match = re.match(rb'([0-9a-f]{64})\s', result.stdout) if result.returncode == 0 else None
        state['containerSource_' + name] = match[1].decode() if match else None
    binary = subprocess.run(['docker', 'exec', 'tahashoes-backend', 'go', 'tool', 'nm', '/app/server'],
                            capture_output=True, timeout=20)
    state['compiledAdapterSymbolPresent'] = binary.returncode == 0 and b'.tryPublishWebsiteProduct' in binary.stdout
    state['compiledAdapterSymbolCheckAvailable'] = binary.returncode == 0
    timer = subprocess.run(['systemctl', 'is-active', 'taha-ai-cron.timer'], capture_output=True, timeout=10)
    state['cronTimerActive'] = timer.stdout.strip() == b'active'
    service = subprocess.run(['systemctl', 'is-active', 'taha-ai-cron.service'], capture_output=True, timeout=10)
    state['cronServiceActive'] = service.stdout.strip() == b'active'
    # Capture resolved Compose privately. Return only booleans/counts/hashes.
    resolved = json.loads(command(['docker', 'compose', '-p', 'tahashoes', '-f', str(COMPOSE),
                                  '--project-directory', str(BASE), 'config', '--format', 'json']))
    backend = resolved.get('services', {}).get('backend', {})
    resolved_env = backend.get('environment', {})
    state['composeResolvedSecretPresent'] = bool(resolved_env.get('TAHA_WEBHOOK_SECRET', '').strip())
    state['composeSecretMatchesContainer'] = resolved_env.get('TAHA_WEBHOOK_SECRET', '') == env.get('TAHA_WEBHOOK_SECRET', '')
    state['composeContainerNameMatches'] = backend.get('container_name') == 'tahashoes-backend'
    state['composeOtherServiceCount'] = max(0, len(resolved.get('services', {})) - 1)
    print('WEBSITE_RUNTIME_DIAG=' + json.dumps(state, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Subprocess stderr and JSON errors may include credentials: never relay them.
        sys.exit('WEBSITE_RUNTIME_DIAG_FAILED')
