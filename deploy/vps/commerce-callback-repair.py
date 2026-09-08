"""Expose only signed one-time commerce OAuth callbacks through Nginx."""
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
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('commerce_media', HERE / 'website-media-repair.py')
media = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(media)
EXPECTED_CONFIG = 'e8a4e697b9afcc8cc8b3c9007f57e6abe6ff91793f275bf1aae93faa4b4bdc44'
ROUTES = ('shopee', 'tiktok-shop')


def patched_config(raw):
    text = raw.decode()
    for route in ROUTES:
        media.require(not re.search(r'location\s*=\s*/api/integrations/' + re.escape(route) + r'/callback\b', text),
                      'COMMERCE_CALLBACK_ALREADY_PRESENT')
    targets = []
    for server in re.finditer(r'(?m)^[ \t]*server\s*\{', text):
        opening = text.index('{', server.start(), server.end())
        end = media.block_end(text, opening)
        block = text[opening:end]
        names = re.findall(r'\bserver_name\s+([^;]+);', block)
        if (len(names) == 1 and set(names[0].split()) == {'tahashoes.store'}
                and re.search(r'\blisten\s+443\b[^;]*\bssl\b[^;]*;', block)
                and re.search(r'\bauth_basic\s+[^;]+;', block)
                and re.search(r'\bproxy_pass\s+http://taha-ai:8787\s*;', block)):
            targets.append(end - 1)
    media.require(len(targets) == 1, 'COMMERCE_CALLBACK_SERVER_AMBIGUOUS')
    route_text = ''.join(f'''
        # Public OAuth return only; application verifies signed one-time state.
        location = /api/integrations/{route}/callback {{
            auth_basic off;
            proxy_pass http://taha-ai:8787;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-Proto $scheme;
        }}
''' for route in ROUTES)
    at = targets[0]
    return (text[:at] + route_text + text[at:]).encode()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def verify_callbacks():
    for route in ROUTES:
        request = Request(f'https://tahashoes.store/api/integrations/{route}/callback')
        try:
            response = build_opener(ProxyHandler({}), NoRedirect).open(request, timeout=15)
        except HTTPError as error:
            response = error
        with response:
            media.require(response.status in (302, 303, 307, 308), 'COMMERCE_CALLBACK_NOT_PUBLIC')
            location = response.headers.get('Location', '')
            media.require('/connections?' in location and 'result=error' in location,
                          'COMMERCE_CALLBACK_UNEXPECTED_REDIRECT')


def main(apply):
    with open('/var/lock/taha-ai-release.lock', 'a') as release_lock, open('/var/lock/taha-commerce-callback.lock', 'a') as lock:
        fcntl.flock(release_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        raw = media.CONFIG.read_bytes()
        media.require(media.sha(raw) == EXPECTED_CONFIG, 'COMMERCE_CALLBACK_CONFIG_CHANGED')
        nginx = media.inspect('tahashoes-nginx')
        media.require(nginx['Image'] == media.NGINX_IMAGE, 'COMMERCE_CALLBACK_NGINX_CHANGED')
        media.require(media.command(['docker', 'exec', nginx['Id'], 'cat', '/etc/nginx/nginx.conf']) == raw,
                      'COMMERCE_CALLBACK_MOUNT_CHANGED')
        updated = patched_config(raw)
        if not apply:
            print('COMMERCE_CALLBACK_PATCH_READY')
            return
        backup_root = Path('/var/backups/taha-commerce-callback')
        backup_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, backup = tempfile.mkstemp(prefix='nginx-', suffix='.conf', dir=backup_root)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        fd, candidate = tempfile.mkstemp(prefix='commerce-callback-', suffix='.conf')
        with os.fdopen(fd, 'wb') as stream:
            stream.write(updated)
        staged = '/etc/nginx/' + Path(candidate).name
        changed = False
        try:
            media.command(['docker', 'cp', candidate, nginx['Id'] + ':' + staged])
            media.command(['docker', 'exec', nginx['Id'], 'nginx', '-t', '-c', staged])
            media.require(media.CONFIG.read_bytes() == raw, 'COMMERCE_CALLBACK_CONCURRENT_CHANGE')
            changed = True
            media.write_same_inode(updated, media.CONFIG.stat().st_ino)
            media.command(['docker', 'exec', nginx['Id'], 'nginx', '-t'])
            media.command(['docker', 'exec', nginx['Id'], 'nginx', '-s', 'reload'])
            time.sleep(1)
            verify_callbacks()
            print('COMMERCE_CALLBACK_VERIFIED=' + json.dumps({'routes': len(ROUTES),
                  'configSha256': media.sha(updated), 'backup': backup}))
        except Exception:
            if changed:
                media.require(media.CONFIG.read_bytes() == updated, 'COMMERCE_CALLBACK_ROLLBACK_CHANGED')
                media.write_same_inode(raw, media.CONFIG.stat().st_ino)
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
        sys.exit(message if re.fullmatch(r'(?:COMMERCE|MEDIA)_[A-Z_]+', message) else 'COMMERCE_CALLBACK_REPAIR_FAILED')
