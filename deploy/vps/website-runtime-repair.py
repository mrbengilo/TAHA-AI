"""Prepare/check a reversible secret-only Compose repair; --apply is required to mutate.

This file has no workflow trigger. First review the main-only diagnostic output.
Every subprocess is captured privately; errors never include command output/env values.
"""
import argparse
import copy
import fcntl
import functools
import hashlib
import hmac
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener

BASE = Path('/var/www/tahashoes')
ENV_PATH = BASE / 'gosporty-backend/.env'
COMPOSE_PATH = BASE / 'docker-compose.yml'
SCRIPT_PATH = Path(__file__).resolve().parent
BACKUP_ROOT = Path('/var/backups/taha-website-receiver')
LOCK_PATH = Path('/var/lock/taha-website-receiver-repair.lock')
CONTAINER = 'tahashoes-backend'
ENV_KEY = 'TAHA_WEBHOOK_SECRET'
ADAPTER_SHA = '5b18f176dbee8ec72aafb8b6bb5c451d64fb2b04ff74ce88dc96597019628b2a'
ACTIVE_JOBS = {'queued', 'publishing', 'retry_wait', 'awaiting_confirmation'}


class GuardError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise GuardError(code)


def private_command(args, *, data=None, timeout=60):
    result = subprocess.run(args, input=data, capture_output=True, timeout=timeout, cwd=BASE)
    require(result.returncode == 0, 'WEBSITE_REPAIR_COMMAND_FAILED')
    return result.stdout


def validate_secret(secret):
    # Single quotes make $, ${...}, # and double quotes literal in Compose env files.
    # Reject backslash/single-quote ambiguity rather than rewriting an arbitrary secret.
    require(isinstance(secret, str) and 24 <= len(secret) <= 512
            and re.fullmatch(r"[\x21-\x7e]+", secret) is not None
            and "'" not in secret and '\\' not in secret, 'WEBSITE_SECRET_ENCODING_UNSUPPORTED')


def replace_secret(contents, secret):
    validate_secret(secret)
    require('\x00' not in contents, 'WEBSITE_ENV_ENCODING_INVALID')
    lines = contents.splitlines(keepends=True)
    found = []
    for index, line in enumerate(lines):
        if re.match(r'^\s*(?:export\s+)?TAHA_WEBHOOK_SECRET\b', line):
            found.append(index)
    require(len(found) <= 1, 'WEBSITE_ENV_SECRET_DUPLICATE')
    replacement = ENV_KEY + "='" + secret + "'\n"
    if found:
        old = lines[found[0]].strip()
        match = re.fullmatch(r'(?:export\s+)?TAHA_WEBHOOK_SECRET\s*=\s*(.*)', old)
        require(match is not None, 'WEBSITE_ENV_SECRET_SYNTAX_UNKNOWN')
        raw = match[1]
        # Existing nonempty different values are never overwritten, even if Compose overrides them.
        allowed = {'', "''", '""', secret, "'" + secret + "'"}
        require(raw in allowed, 'WEBSITE_ENV_SECRET_NONEMPTY_OR_AMBIGUOUS')
        newline = '\r\n' if lines[found[0]].endswith('\r\n') else '\n'
        lines[found[0]] = replacement.rstrip('\n') + newline
        return ''.join(lines)
    return contents + ('' if not contents or contents.endswith('\n') else '\n') + replacement


def env_map(container):
    result = {}
    for item in container['Config'].get('Env', []):
        key, sep, value = item.partition('=')
        if sep:
            require(key not in result, 'WEBSITE_CONTAINER_ENV_DUPLICATE')
            result[key] = value
    return result


def inspect():
    rows = json.loads(private_command(['docker', 'inspect', CONTAINER]))
    require(len(rows) == 1, 'WEBSITE_CONTAINER_AMBIGUOUS')
    return rows[0]


@functools.lru_cache(maxsize=1)
def compose_command():
    # Pin one supported CLI for this invocation, including rollback. The VPS may
    # have the v2 standalone binary without Docker's compose plugin.
    for args in (['docker', 'compose'], ['docker-compose']):
        try:
            version = subprocess.run(args + ['version', '--short'], capture_output=True, timeout=10, cwd=BASE)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue
        match = re.match(rb'^v?([0-9]+)\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$', version.stdout.strip())
        if version.returncode == 0 and match and int(match[1]) >= 2:
            return tuple(args + ['-p', 'tahashoes', '-f', str(COMPOSE_PATH), '--project-directory', str(BASE)])
    raise GuardError('WEBSITE_COMPOSE_V2_UNAVAILABLE')


def resolved_config():
    return json.loads(private_command(list(compose_command()) + ['config', '--format', 'json']))


def config_without_secret(config):
    result = copy.deepcopy(config)
    result['services']['backend'].setdefault('environment', {}).pop(ENV_KEY, None)
    return result


def state_snapshot():
    source = (SCRIPT_PATH / 'website-state-diagnose.mjs').read_bytes()
    output = private_command(['docker', 'exec', '-i', 'taha-ai', 'node', '--input-type=module'], data=source, timeout=300)
    prefix = b'WEBSITE_STATE_DIAG='
    matches = [line[len(prefix):] for line in output.splitlines() if line.startswith(prefix)]
    require(len(matches) == 1, 'WEBSITE_STATE_UNAVAILABLE')
    state = json.loads(matches[0])
    require(isinstance(state.get('sections'), dict) and all(row.get('ok') is True for row in state['sections'].values()),
            'WEBSITE_STATE_INCOMPLETE')
    return state


def guard_no_backlog(state):
    # The application enables backfill only for the literal string "1"; unset
    # uses its disabled default. state_snapshot already requires a successful env read.
    require(state.get('backfillEnabled') is False, 'WEBSITE_BACKFILL_ENABLED_OR_UNKNOWN')
    for field in ('activeWebsiteSchedules', 'activeWebsiteRuns', 'dailyWebsiteConnections'):
        counts = state.get(field)
        require(isinstance(counts, list) and len(counts) == 1 and counts[0].get('count') == 0,
                'WEBSITE_BACKLOG_REQUIRES_REVIEW')
    require(isinstance(state.get('websiteJobsByStatus'), list), 'WEBSITE_STATE_UNAVAILABLE')
    for row in state['websiteJobsByStatus']:
        require(row['status'] in ACTIVE_JOBS | {'published', 'blocked', 'failed', 'cancelled'},
                'WEBSITE_JOB_STATUS_UNKNOWN')
        require(row['status'] not in ACTIVE_JOBS or row['count'] == 0, 'WEBSITE_BACKLOG_REQUIRES_REVIEW')


def validate_identity(container, expected_container, expected_image):
    require(container['Id'] == expected_container and container['Image'] == expected_image,
            'WEBSITE_CONTAINER_CHANGED_SINCE_DIAGNOSIS')
    require(container.get('State', {}).get('Running') is True, 'WEBSITE_CONTAINER_NOT_RUNNING')
    labels = container['Config'].get('Labels', {})
    expected = {'com.docker.compose.project': 'tahashoes', 'com.docker.compose.service': 'backend',
                'com.docker.compose.project.working_dir': str(BASE),
                'com.docker.compose.project.config_files': str(COMPOSE_PATH)}
    require(all(labels.get(key) == value for key, value in expected.items()), 'WEBSITE_COMPOSE_IDENTITY_MISMATCH')


def atomic_write(path, data, original_stat):
    fd, temporary = tempfile.mkstemp(prefix='.taha-receiver-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), stat.S_IMODE(original_stat.st_mode) & 0o600)
            os.fchown(stream.fileno(), original_stat.st_uid, original_stat.st_gid)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def signed_rejection_probe(secret):
    # The reviewed adapter rejects this unknown schema before touching Mongo/media.
    body = b'{"schemaVersion":"taha.receiver.configuration-probe.invalid"}'
    timestamp = str(int(time.time()))
    signature = hmac.new(secret.encode(), timestamp.encode() + b'.' + body, hashlib.sha256).hexdigest()
    request = Request('https://tahashoes.vn/api/taha/publish', data=body, headers={
        'Content-Type': 'application/json', 'X-TAHA-Timestamp': timestamp,
        'X-TAHA-Signature': 'sha256=' + signature, 'X-TAHA-Idempotency-Key': 'taha-receiver-configuration-probe',
    })
    try:
        with build_opener(NoRedirect).open(request, timeout=15):
            return False
    except HTTPError as error:
        return error.code == 422 and error.read(256).strip() == b'unsupported schema version'


def recreate():
    # Existing tagged image was checked against the diagnosed image ID. Never rebuild/pull or touch dependencies.
    private_command(list(compose_command()) + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'backend'], timeout=180)


def main(args):
    require(re.fullmatch(r'[0-9a-f]{64}', args.expected_container_id) is not None,
            'WEBSITE_EXPECTED_CONTAINER_ID_REQUIRED')
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', args.expected_image_id) is not None,
            'WEBSITE_EXPECTED_IMAGE_ID_REQUIRED')
    require(not ENV_PATH.is_symlink() and ENV_PATH.is_file(), 'WEBSITE_ENV_PATH_INVALID')
    container = inspect()
    validate_identity(container, args.expected_container_id, args.expected_image_id)
    source_sha = private_command(['docker', 'exec', CONTAINER, 'sha256sum', '/app/handlers/product_receiver.go'])
    require(source_sha.split()[0].decode() == ADAPTER_SHA, 'WEBSITE_ADAPTER_IMAGE_NOT_REVIEWED')
    binary = private_command(['docker', 'exec', CONTAINER, 'go', 'tool', 'nm', '/app/server'])
    require(b'.tryPublishWebsiteProduct' in binary, 'WEBSITE_ADAPTER_NOT_COMPILED')
    guard_no_backlog(state_snapshot())
    secret = private_command(['docker', 'exec', '-i', 'taha-ai', 'node', '--input-type=module'],
                             data=(SCRIPT_PATH / 'website-connection-secret.mjs').read_bytes()).decode()
    validate_secret(secret)
    original_stat = ENV_PATH.stat()
    original = ENV_PATH.read_bytes()
    updated = replace_secret(original.decode('utf-8'), secret).encode('utf-8')
    live_env = env_map(container)
    require(live_env.get(ENV_KEY, '') in ('', secret), 'WEBSITE_CONTAINER_SECRET_DIFFERENT')
    baseline = resolved_config()
    backend = baseline['services']['backend']
    require(backend.get('container_name') == CONTAINER, 'WEBSITE_COMPOSE_CONTAINER_MISMATCH')
    baseline_env = backend.get('environment', {})
    require(baseline_env.get(ENV_KEY, '') in ('', secret), 'WEBSITE_COMPOSE_SECRET_DIFFERENT')
    require(all(live_env.get(key) == value for key, value in baseline_env.items() if key != ENV_KEY),
            'WEBSITE_COMPOSE_OTHER_ENV_DRIFT')
    image_name = backend.get('image') or 'tahashoes-backend'
    require(container['Config']['Image'] == image_name, 'WEBSITE_COMPOSE_IMAGE_NAME_DRIFT')
    image_id = private_command(['docker', 'image', 'inspect', image_name, '--format', '{{.Id}}']).decode().strip()
    require(image_id == args.expected_image_id, 'WEBSITE_COMPOSE_IMAGE_TAG_DRIFT')
    if not args.apply:
        print('WEBSITE_REPAIR_CHECK=ready; no files or containers changed')
        return
    if live_env.get(ENV_KEY) == secret and baseline_env.get(ENV_KEY) == secret:
        require(signed_rejection_probe(secret), 'WEBSITE_EXISTING_RECEIVER_PROBE_FAILED')
        print('WEBSITE_REPAIR=already_configured')
        return
    # A host lock supplements workflow concurrency; never stop the cron or other jobs.
    with open(LOCK_PATH, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        validate_identity(inspect(), args.expected_container_id, args.expected_image_id)
        guard_no_backlog(state_snapshot())
        require(ENV_PATH.read_bytes() == original, 'WEBSITE_ENV_CHANGED_SINCE_CHECK')
        require(resolved_config() == baseline, 'WEBSITE_COMPOSE_CHANGED_SINCE_CHECK')
        backup_root = BACKUP_ROOT
        backup_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        backup_dir = Path(tempfile.mkdtemp(prefix='secret-', dir=backup_root))
        backup = backup_dir / 'backend.env'
        backup.write_bytes(original)
        backup.chmod(0o600)
        manifest = {'containerId': container['Id'], 'imageId': container['Image'],
                    'envSha256': hashlib.sha256(original).hexdigest(), 'mode': stat.S_IMODE(original_stat.st_mode)}
        (backup_dir / 'manifest.json').write_text(json.dumps(manifest))
        recreated = False
        try:
            atomic_write(ENV_PATH, updated, original_stat)
            after = resolved_config()
            require(after['services']['backend'].get('environment', {}).get(ENV_KEY) == secret,
                    'WEBSITE_COMPOSE_SECRET_WIRING_MISMATCH')
            require(config_without_secret(after) == config_without_secret(baseline), 'WEBSITE_COMPOSE_OTHER_CONFIG_CHANGED')
            require(ENV_PATH.read_bytes() == updated, 'WEBSITE_ENV_CONCURRENT_EDIT')
            # Mark before invocation: a timed-out recreate may already have changed the service.
            recreated = True
            recreate()
            current = inspect()
            require(current['Image'] == args.expected_image_id, 'WEBSITE_RECREATED_IMAGE_CHANGED')
            require(env_map(current) == {**live_env, ENV_KEY: secret}, 'WEBSITE_RECREATED_ENV_CHANGED')
            deadline = time.monotonic() + 45
            success = False
            while time.monotonic() < deadline:
                try:
                    success = signed_rejection_probe(secret)
                except Exception:
                    success = False
                if success:
                    break
                time.sleep(3)
            require(success, 'WEBSITE_RECEIVER_VERIFICATION_FAILED')
            print('WEBSITE_REPAIR=verified; existing backend image and other environment preserved')
            print('WEBSITE_REPAIR_BACKUP=' + str(backup_dir))
        except Exception:
            # Restore exact original bytes before recreating the same image/configuration.
            current_env = ENV_PATH.read_bytes()
            require(current_env in (original, updated), 'WEBSITE_ROLLBACK_BLOCKED_CONCURRENT_ENV_EDIT')
            if current_env != original:
                atomic_write(ENV_PATH, original, original_stat)
                os.chmod(ENV_PATH, stat.S_IMODE(original_stat.st_mode))
            require(resolved_config() == baseline, 'WEBSITE_ROLLBACK_CONFIG_MISMATCH')
            if recreated:
                recreate()
                restored = inspect()
                require(restored['Image'] == args.expected_image_id and env_map(restored) == live_env,
                        'WEBSITE_ROLLBACK_RUNTIME_MISMATCH')
            print('WEBSITE_REPAIR_ROLLBACK=original environment and runtime restored')
            raise GuardError('WEBSITE_REPAIR_FAILED_ROLLED_BACK') from None


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-container-id', required=True)
    parser.add_argument('--expected-image-id', required=True)
    parser.add_argument('--apply', action='store_true')
    try:
        main(parser.parse_args())
    except GuardError as error:
        sys.exit(str(error))
    except Exception:
        sys.exit('WEBSITE_REPAIR_FAILED_WITHOUT_SAFE_DETAIL')
