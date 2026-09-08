"""Route existing public JPEG media to the backend; do not republish products."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

CONFIG = Path('/var/www/tahashoes/nginx.conf')
EXPECTED_CONFIG = '48574e7ef0297031b939bf7d20f7477feafb7682cc9b39c133cc840d5b2b213b'
NGINX_IMAGE = 'sha256:d0c7807749103be4b1fcd09378f16ed4146c79e76e97ad26d0545004cc67474c'
BACKEND_IMAGE = 'sha256:0568fef8cf5a93be0abc780437fa4eeb0a2fccace45754072775b103d14f485b'
FIRST_IMAGE = 'a34c79c9154678f984ba67c5e85479a65b6218598adbb1b6e9d12f5786b0236c.jpg'
PRODUCT_ID = '060971fef6313a99e31d99c2'
MEDIA_RE = re.compile(r'^/uploads/taha/[0-9a-f]{64}\.jpg$')


def require(value, code):
    if not value:
        raise RuntimeError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def command(args, timeout=30):
    result = subprocess.run(args, capture_output=True, timeout=timeout)
    if result.returncode and len(args) > 4 and args[3] == 'nginx':
        diagnostic = re.sub(r'\"[^\"\n]*\"|\x27[^\x27\n]*\x27', '[value]', result.stderr.decode(errors='replace'))
        print('MEDIA_NGINX_VALIDATION=' + json.dumps({'message': ' '.join(diagnostic.split())[:1000]}), flush=True)
    require(result.returncode == 0, 'MEDIA_REPAIR_COMMAND_FAILED')
    return result.stdout


def inspect(name):
    rows = json.loads(command(['docker', 'inspect', name]))
    require(len(rows) == 1 and rows[0]['State']['Running'], 'MEDIA_REPAIR_CONTAINER_UNAVAILABLE')
    return rows[0]


def block_end(text, opening):
    # Ignore braces in quoted strings and comments while matching nginx blocks.
    depth = 0
    token = re.compile(r'"(?:\\.|[^"\\])*"|\x27(?:\\.|[^\x27\\])*\x27|#[^\n]*|[{}]')
    for match in token.finditer(text, opening):
        if match[0] == '{':
            depth += 1
        elif match[0] == '}':
            depth -= 1
            if depth == 0:
                return match.end()
    raise RuntimeError('MEDIA_REPAIR_CONFIG_UNBALANCED')


def patched_config(raw):
    text = raw.decode()
    require('/uploads/taha/' not in text, 'MEDIA_REPAIR_ROUTE_ALREADY_PRESENT')
    candidates = []
    for match in re.finditer(r'(?m)^(?P<indent>[ \t]*)location\s+/\s*\{', text):
        opening = text.index('{', match.start(), match.end())
        end = block_end(text, opening)
        if re.search(r'\bproxy_pass\s+http://frontend:3000\s*;', text[opening:end]):
            candidates.append(match)
    require(len(candidates) == 1, 'MEDIA_REPAIR_FRONTEND_ROUTE_AMBIGUOUS')
    match = candidates[0]
    parents = []
    for server in re.finditer(r'(?m)^[ \t]*server\s*\{', text):
        opening = text.index('{', server.start(), server.end())
        end = block_end(text, opening)
        if opening < match.start() < end:
            parents.append(text[opening:end])
    require(len(parents) == 1, 'MEDIA_REPAIR_SERVER_AMBIGUOUS')
    names = re.findall(r'\bserver_name\s+([^;]+);', parents[0])
    require(len(names) == 1 and set(names[0].split()) == {'tahashoes.vn', 'www.tahashoes.vn'},
            'MEDIA_REPAIR_SERVER_MISMATCH')
    require(re.search(r'\blisten\s+443\b[^;]*\bssl\b[^;]*;', parents[0]), 'MEDIA_REPAIR_HTTPS_SERVER_REQUIRED')
    indent = match['indent']
    lines = [
        'location ^~ /uploads/taha/ {',
        '    # Only content-addressed JPEG media is public here.',
        '    if ($uri !~ "^/uploads/taha/[0-9a-f]{64}[.]jpg$") { return 404; }',
        '    limit_except GET { deny all; }',
        '    proxy_pass http://backend:8080;',
        '    proxy_set_header Host $host;',
        '    proxy_set_header X-Forwarded-Proto $scheme;',
        '    add_header X-Content-Type-Options nosniff always;',
        '}', '',
    ]
    inserted = '\n'.join(indent + line if line else '' for line in lines) + '\n'
    return (text[:match.start()] + inserted + text[match.start():]).encode()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def get(url, limit=300001):
    request = Request(url, headers={'Accept': 'image/jpeg,application/json', 'Cache-Control': 'no-cache'})
    try:
        response = build_opener(ProxyHandler({}), NoRedirect).open(request, timeout=12)
    except HTTPError as error:
        response = error
    with response:
        return response.status, response.headers.get_content_type(), response.read(limit)


def media_paths(backend):
    address = backend['NetworkSettings']['Networks']['tahashoes_default']['IPAddress']
    require(re.fullmatch(r'(?:[0-9]{1,3}\.){3}[0-9]{1,3}', address), 'MEDIA_REPAIR_BACKEND_ADDRESS_INVALID')
    origin = 'http://' + address + ':8080'
    status, _, body = get(origin + '/api/products/' + PRODUCT_ID)
    require(status == 200, 'MEDIA_REPAIR_PRODUCT_UNAVAILABLE')
    product = json.loads(body)
    require(product.get('id', product.get('_id')) == PRODUCT_ID and 'PH0015' in product.get('name', ''),
            'MEDIA_REPAIR_PRODUCT_MISMATCH')
    paths = product.get('images')
    require(isinstance(paths, list) and len(paths) == 6
            and all(isinstance(path, str) and MEDIA_RE.fullmatch(path) for path in paths),
            'MEDIA_REPAIR_IMAGE_LIST_INVALID')
    require('/uploads/taha/' + FIRST_IMAGE in paths, 'MEDIA_REPAIR_FIRST_IMAGE_MISMATCH')
    for path in paths:
        check_image(origin + path, path)
    return paths


def check_image(url, path):
    status, mime, body = get(url)
    require(status == 200 and mime == 'image/jpeg' and 0 < len(body) < 300000
            and body.startswith(b'\xff\xd8\xff') and sha(body) == Path(path).stem,
            'MEDIA_REPAIR_PUBLIC_IMAGE_MISMATCH')


def write_same_inode(data, expected_inode):
    # nginx.conf is a single-file bind mount: replacing its inode would leave nginx
    # reading the old file. Stage nginx -t first, then write/fsync that same inode.
    with CONFIG.open('r+b') as stream:
        require(os.fstat(stream.fileno()).st_ino == expected_inode, 'MEDIA_REPAIR_CONFIG_INODE_CHANGED')
        original = stream.read()
        try:
            stream.seek(0)
            stream.write(data)
            stream.truncate()
            stream.flush()
            os.fsync(stream.fileno())
        except Exception:
            stream.seek(0)
            stream.write(original)
            stream.truncate()
            stream.flush()
            os.fsync(stream.fileno())
            raise


def main(apply):
    with open('/var/lock/taha-ai-release.lock', 'a') as release_lock, open('/var/lock/taha-website-media.lock', 'a') as lock:
        fcntl.flock(release_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(CONFIG.is_file() and not CONFIG.is_symlink(), 'MEDIA_REPAIR_CONFIG_PATH_INVALID')
        original = CONFIG.read_bytes()
        require(sha(original) == EXPECTED_CONFIG, 'MEDIA_REPAIR_CONFIG_CHANGED')
        metadata = CONFIG.stat()
        nginx, backend = inspect('tahashoes-nginx'), inspect('tahashoes-backend')
        require(nginx['Image'] == NGINX_IMAGE and backend['Image'] == BACKEND_IMAGE, 'MEDIA_REPAIR_RUNTIME_CHANGED')
        require(any(row.get('Type') == 'bind' and row.get('Source') == str(CONFIG)
                    and row.get('Destination') == '/etc/nginx/nginx.conf' and row.get('RW') is False
                    for row in nginx.get('Mounts', [])), 'MEDIA_REPAIR_CONFIG_MOUNT_CHANGED')
        require(command(['docker', 'exec', nginx['Id'], 'cat', '/etc/nginx/nginx.conf']) == original,
                'MEDIA_REPAIR_HOST_CONTAINER_CONFIG_MISMATCH')
        paths = media_paths(backend)
        updated = patched_config(original)
        print('MEDIA_REPAIR_CHECK=ready; product=PH0015; images=6', flush=True)
        if not apply:
            return
        backup_root = Path('/var/backups/taha-website-media')
        backup_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, backup_name = tempfile.mkstemp(prefix='nginx-', suffix='.conf', dir=backup_root)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(original)
            stream.flush()
            os.fsync(stream.fileno())
        fd, candidate_name = tempfile.mkstemp(prefix='taha-media-', suffix='.conf')
        with os.fdopen(fd, 'wb') as stream:
            stream.write(updated)
        staged_path = '/etc/nginx/' + Path(candidate_name).name
        changed = False
        try:
            print('MEDIA_REPAIR_STAGE=stage_config_in_nginx_directory', flush=True)
            command(['docker', 'cp', candidate_name, nginx['Id'] + ':' + staged_path])
            command(['docker', 'exec', nginx['Id'], 'nginx', '-t', '-c', staged_path])
            require(CONFIG.read_bytes() == original and inspect('tahashoes-nginx')['Id'] == nginx['Id'],
                    'MEDIA_REPAIR_CONCURRENT_CHANGE')
            changed = True
            write_same_inode(updated, metadata.st_ino)
            require(command(['docker', 'exec', nginx['Id'], 'cat', '/etc/nginx/nginx.conf']) == updated,
                    'MEDIA_REPAIR_BIND_MOUNT_NOT_UPDATED')
            command(['docker', 'exec', nginx['Id'], 'nginx', '-t'])
            command(['docker', 'exec', nginx['Id'], 'nginx', '-s', 'reload'])
            time.sleep(2)
            for path in paths:
                check_image('https://tahashoes.vn' + path, path)
            require(inspect('tahashoes-nginx')['Id'] == nginx['Id'] and inspect('tahashoes-backend')['Id'] == backend['Id'],
                    'MEDIA_REPAIR_CONTAINER_CHANGED')
            print('MEDIA_REPAIR_VERIFIED=' + json.dumps({'sku': 'PH0015', 'images': 6,
                  'configSha256': sha(updated), 'backup': backup_name, 'republished': False}), flush=True)
        except Exception:
            if changed:
                require(CONFIG.read_bytes() in (updated, original), 'MEDIA_REPAIR_ROLLBACK_CONFIG_DRIFT')
                write_same_inode(original, metadata.st_ino)
                command(['docker', 'exec', nginx['Id'], 'nginx', '-t'])
                command(['docker', 'exec', nginx['Id'], 'nginx', '-s', 'reload'])
                print('MEDIA_REPAIR_ROLLED_BACK=yes', flush=True)
            raise
        finally:
            Path(candidate_name).unlink(missing_ok=True)
            command(['docker', 'exec', nginx['Id'], 'rm', '-f', staged_path])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    try:
        main(parser.parse_args().apply)
    except Exception as error:
        message = str(error)
        sys.exit(message if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', message) else 'MEDIA_REPAIR_FAILED')
