"""Raise only the signed product receiver's upload limit; stage, reload, verify."""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import Request, ProxyHandler, build_opener

ROOT = Path('/var/www/taha-ai/deploy/vps')
LOCAL = Path(__file__).resolve().parent
HELPER = LOCAL / 'website-media-repair.py' if (LOCAL / 'website-media-repair.py').is_file() else ROOT / 'website-media-repair.py'
spec = importlib.util.spec_from_file_location('capacity_media', HELPER)
media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)
EXPECTED_CONFIG = '82ba1be6e2ee3d8ce3e18147f7057f102c8d5e50629608ee85adf1da794d62ef'
EXPECTED_ADAPTER = 'd8111a98529c8d8ed7fc17e4e7f107b863aff7afc3c58787fb14ed6def85c1e7'


def patched_config(raw):
    text = raw.decode()
    media.require(not re.search(r'location\s*=\s*/api/taha/publish\b', text), 'CAPACITY_ROUTE_ALREADY_PRESENT')
    targets = []
    for server in re.finditer(r'(?m)^[ \t]*server\s*\{', text):
        opening = text.index('{', server.start(), server.end())
        end = media.block_end(text, opening)
        block = text[opening:end]
        names = re.findall(r'\bserver_name\s+([^;]+);', block)
        if len(names) == 1 and set(names[0].split()) == {'tahashoes.vn', 'www.tahashoes.vn'} and re.search(r'\blisten\s+443\b[^;]*\bssl\b[^;]*;', block):
            targets.append(end - 1)
    media.require(len(targets) == 1, 'CAPACITY_SERVER_AMBIGUOUS')
    route = '''
        # Match the receiver's existing authenticated 34 MiB body ceiling.
        location = /api/taha/publish {
            client_max_body_size 34m;
            proxy_pass http://backend:8080;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    '''
    at = targets[0]
    return (text[:at] + route + text[at:]).encode()


def verify_capacity():
    # An unsigned large body must reach the receiver and fail authentication,
    # without creating any product or media file.
    request = Request('https://tahashoes.vn/api/taha/publish', data=b' ' * (5 * 1024 * 1024),
                      headers={'Content-Type': 'application/json'}, method='POST')
    try:
        response = build_opener(ProxyHandler({}), media.NoRedirect).open(request, timeout=35)
    except HTTPError as error:
        response = error
    with response:
        media.require(response.status == 401, 'CAPACITY_AUTHENTICATED_RECEIVER_NOT_REACHED')


def main(apply):
    with open('/var/lock/taha-ai-release.lock', 'a') as release_lock, open('/var/lock/taha-website-media.lock', 'a') as lock:
        fcntl.flock(release_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        raw = media.CONFIG.read_bytes()
        media.require(media.sha(raw) == EXPECTED_CONFIG, 'CAPACITY_CONFIG_CHANGED')
        nginx = media.inspect('tahashoes-nginx')
        media.require(nginx['Image'] == media.NGINX_IMAGE, 'CAPACITY_NGINX_CHANGED')
        media.require(media.command(['docker', 'exec', nginx['Id'], 'cat', '/etc/nginx/nginx.conf']) == raw,
                      'CAPACITY_MOUNT_CHANGED')
        adapter = media.command(['docker', 'exec', 'tahashoes-backend', 'cat', '/app/handlers/product_receiver.go'])
        media.require(media.sha(adapter) == EXPECTED_ADAPTER, 'CAPACITY_RECEIVER_CHANGED')
        updated = patched_config(raw)
        if not apply:
            print('CAPACITY_PATCH_READY')
            return
        backup_root = Path('/var/backups/taha-website-media')
        backup_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, backup = tempfile.mkstemp(prefix='upload-limit-', suffix='.conf', dir=backup_root)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        inode = media.CONFIG.stat().st_ino
        fd, candidate = tempfile.mkstemp(prefix='taha-capacity-', suffix='.conf')
        with os.fdopen(fd, 'wb') as stream:
            stream.write(updated)
        staged = '/etc/nginx/' + Path(candidate).name
        changed = False
        try:
            media.command(['docker', 'cp', candidate, nginx['Id'] + ':' + staged])
            media.command(['docker', 'exec', nginx['Id'], 'nginx', '-t', '-c', staged])
            media.require(media.CONFIG.read_bytes() == raw, 'CAPACITY_CONCURRENT_CONFIG_CHANGE')
            changed = True
            media.write_same_inode(updated, inode)
            media.command(['docker', 'exec', nginx['Id'], 'nginx', '-t'])
            media.command(['docker', 'exec', nginx['Id'], 'nginx', '-s', 'reload'])
            time.sleep(1)
            verify_capacity()
            media.check_image('https://tahashoes.vn/uploads/taha/' + media.FIRST_IMAGE, '/uploads/taha/' + media.FIRST_IMAGE)
            print('CAPACITY_VERIFIED=' + json.dumps({'bodyLimitMiB': 34, 'unauthorizedStatus': 401,
                  'configSha256': media.sha(updated), 'backup': backup}))
        except Exception:
            if changed:
                media.require(media.CONFIG.read_bytes() == updated, 'CAPACITY_ROLLBACK_CONFIG_CHANGED')
                media.write_same_inode(raw, inode)
                media.command(['docker', 'exec', nginx['Id'], 'nginx', '-t'])
                media.command(['docker', 'exec', nginx['Id'], 'nginx', '-s', 'reload'])
            raise
        finally:
            Path(candidate).unlink(missing_ok=True)
            media.command(['docker', 'exec', nginx['Id'], 'rm', '-f', staged])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    try:
        main(parser.parse_args().apply)
    except Exception as error:
        message = str(error)
        sys.exit(message if re.fullmatch(r'(CAPACITY|MEDIA)_[A-Z_]+', message) else 'CAPACITY_REPAIR_FAILED')
