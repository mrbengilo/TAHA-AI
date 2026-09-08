"""Read-only, fixed-scope production diagnosis. Never print Docker config/env/source."""
import hashlib
import ipaddress
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

BASE = Path('/var/www/tahashoes')
COMPOSE = BASE / 'docker-compose.yml'
EXPECTED_ADAPTER_SHA256 = '5b18f176dbee8ec72aafb8b6bb5c451d64fb2b04ff74ce88dc96597019628b2a'
LABELS = {
    'com.docker.compose.project': 'tahashoes',
    'com.docker.compose.service': 'backend',
    'com.docker.compose.project.working_dir': str(BASE),
    'com.docker.compose.project.config_files': str(COMPOSE),
}
MEDIA_FILE = 'a34c79c9154678f984ba67c5e85479a65b6218598adbb1b6e9d12f5786b0236c.jpg'
MEDIA_PATH = '/uploads/taha/' + MEDIA_FILE
MEDIA_LIMIT = 300_000


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


def nginx_routes(raw):
    """Return only routing directives; never return headers, auth, certificates or full config."""
    text = re.sub(r'(?m)#.*$', '', raw.decode('utf-8', errors='replace'))
    root = {'header': [], 'directives': [], 'children': []}
    stack, words = [root], []
    for token in re.findall(r'"[^"\n]*"|\x27[^\x27\n]*\x27|[{};]|[^\s{};]+', text):
        if token == '{':
            child = {'header': words, 'directives': [], 'children': []}
            stack[-1]['children'].append(child)
            stack.append(child)
            words = []
        elif token == '}':
            if len(stack) > 1:
                stack.pop()
            words = []
        elif token == ';':
            stack[-1]['directives'].append(words)
            words = []
        else:
            words.append(token.strip('\"\x27'))

    def walk(node):
        yield node
        for child in node['children']:
            yield from walk(child)

    def directives(node):
        result = []
        for item in node['directives']:
            if not item or item[0] not in ('alias', 'root', 'proxy_pass', 'try_files', 'internal'):
                continue
            values = []
            for value in item[1:]:
                if item[0] == 'proxy_pass':
                    parsed = urlsplit(value)
                    value = (parsed.scheme + '://' + (parsed.hostname or '')
                             + (':' + str(parsed.port) if parsed.port else '') + parsed.path)
                values.append(value if re.fullmatch(r'[A-Za-z0-9_./:$?=~^-]{1,240}', value) else '[OMITTED]')
            result.append({'directive': item[0], 'values': values})
        return result[:20]

    servers = []
    for server in walk(root):
        if server['header'] != ['server']:
            continue
        names = [name for item in server['directives'] if item and item[0] == 'server_name' for name in item[1:]]
        locations = [node for node in walk(server) if node['header'] and node['header'][0] == 'location'
                     and (any('uploads' in word for word in node['header']) or node['header'][1:] == ['/'])]
        if not any(name in ('tahashoes.vn', 'www.tahashoes.vn', '_') for name in names) and not locations:
            continue
        servers.append({'serverNames': [name for name in names if re.fullmatch(r'[A-Za-z0-9_.*-]{1,180}', name)],
                        'defaults': directives(server),
                        'locations': [{'match': [word for word in node['header'][1:]
                                                 if re.fullmatch(r'[A-Za-z0-9_./~^*=-]{1,180}', word)],
                                       'routing': directives(node)} for node in locations[:20]]})
    return servers[:12]


def media_containers():
    ids = command(['docker', 'container', 'ls', '-q']).decode().split()
    rows = json.loads(command(['docker', 'inspect', *ids])) if ids else []
    return [row for row in rows if row.get('Name') == '/tahashoes-backend'
            or ((row.get('Config') or {}).get('Labels') or {}).get('com.docker.compose.service') == 'nginx'
            or re.fullmatch(r'/(?:tahashoes-)?nginx(?:-1)?', row.get('Name', ''))]


def media_mount_state():
    return {'websiteMediaMounts': [{'container': row['Name'],
             'mounts': [{key: item.get(key) for key in ('Type', 'Source', 'Destination', 'RW')}
                        for item in row.get('Mounts', [])]} for row in media_containers()]}


def nginx_media_state():
    path = BASE / 'nginx.conf'
    result = {'hostNginxConfig': source_info(path), 'hostNginxMediaRoutes': nginx_routes(path.read_bytes()) if path.is_file() else []}
    configs = []
    for row in media_containers():
        if row['Name'] == '/tahashoes-backend':
            continue
        captured = subprocess.run(['docker', 'exec', row['Id'], 'nginx', '-T'], capture_output=True, timeout=15)
        configs.append({'container': row['Name'], 'returnCode': captured.returncode,
                        'configSha256': digest(captured.stdout), 'routes': nginx_routes(captured.stdout)})
    result['containerNginxMediaRoutes'] = configs
    return result


def exact_media_files_state():
    candidates = ['/data/taha-media/' + MEDIA_FILE, '/app/uploads/taha/' + MEDIA_FILE,
                  '/app/uploads/' + MEDIA_FILE, '/usr/share/nginx/html' + MEDIA_PATH]
    host_paths = {BASE / 'gosporty-backend/uploads/taha' / MEDIA_FILE}
    files = []
    for row in media_containers():
        for path in candidates:
            measured = subprocess.run(['docker', 'exec', row['Id'], 'stat', '-Lc', '%s:%a:%u:%g:%F', '--', path],
                                      capture_output=True, timeout=8)
            match = re.fullmatch(rb'(\d+):([0-7]{3,4}):(\d+):(\d+):regular(?: empty)? file\n?', measured.stdout)
            info = {'container': row['Name'], 'path': path, 'exists': measured.returncode == 0, 'regular': bool(match)}
            if match:
                info.update(bytes=int(match[1]), mode=match[2].decode(), uid=int(match[3]), gid=int(match[4]))
                if int(match[1]) <= MEDIA_LIMIT:
                    hashed = subprocess.run(['docker', 'exec', row['Id'], 'sha256sum', '--', path], capture_output=True, timeout=8)
                    sha = re.match(rb'([0-9a-f]{64})\s', hashed.stdout) if hashed.returncode == 0 else None
                    info['sha256'] = sha[1].decode() if sha else None
            files.append(info)
            for mount in row.get('Mounts', []):
                if mount.get('Type') not in ('bind', 'volume'):
                    continue
                try:
                    relative = Path(path).relative_to(mount['Destination'])
                except ValueError:
                    continue
                host_paths.add(Path(mount['Source']) / relative)
    host_files = []
    for path in sorted(host_paths):
        info = {'path': str(path), 'exists': path.is_file()}
        if path.is_file():
            stat = path.stat()
            info.update(bytes=stat.st_size, mode=oct(stat.st_mode & 0o777), uid=stat.st_uid, gid=stat.st_gid)
            if stat.st_size <= MEDIA_LIMIT:
                info['sha256'] = digest(path.read_bytes())
        host_files.append(info)
    return {'exactImageFilename': MEDIA_FILE, 'exactImageContainerFiles': files, 'exactImageHostFiles': host_files}


class NoMediaRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def media_get(label, url):
    result = {'probe': label}
    request = Request(url, headers={'Host': 'tahashoes.vn', 'Accept': 'image/jpeg', 'User-Agent': 'TAHA-readonly-media-diagnose/1'})
    try:
        try:
            response = build_opener(ProxyHandler({}), NoMediaRedirect).open(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            payload = response.read(MEDIA_LIMIT + 1)
            content_type = response.headers.get_content_type()
            result.update(status=response.status, contentType=content_type if re.fullmatch(r'[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+', content_type) else None,
                          bytesRead=len(payload), truncated=len(payload) > MEDIA_LIMIT, sha256OfReadBytes=digest(payload),
                          jpegMagic=payload.startswith(b'\xff\xd8\xff'))
    except Exception:
        result['error'] = 'MEDIA_GET_FAILED'
    return result


def media_http_state():
    probes = [media_get('public_https', 'https://tahashoes.vn' + MEDIA_PATH),
              media_get('host_nginx_http', 'http://127.0.0.1' + MEDIA_PATH)]
    for row in media_containers():
        port = 8080 if row['Name'] == '/tahashoes-backend' else 80
        for network in (row.get('NetworkSettings', {}).get('Networks') or {}).values():
            address = network.get('IPAddress', '')
            try:
                valid = ipaddress.ip_address(address).is_private
            except ValueError:
                valid = False
            if valid:
                probes.append(media_get(row['Name'].lstrip('/') + '_direct_http', 'http://' + address + ':' + str(port) + MEDIA_PATH))
                break
    return {'exactImageHttpProbes': probes}


def go_static_media_state():
    routes = []
    for path in ('/app/main.go', '/app/router.go', '/app/routes.go'):
        captured = subprocess.run(['docker', 'exec', 'tahashoes-backend', 'cat', path], capture_output=True, timeout=8)
        hits = []
        if captured.returncode == 0:
            for number, line in enumerate(captured.stdout.decode('utf-8', errors='replace').splitlines(), 1):
                if not any(word in line for word in ('uploads', 'taha-media')):
                    continue
                methods = re.findall(r'\b(PathPrefix|StripPrefix|FileServer|Handle|HandleFunc|Dir)\s*\(', line)
                paths = [value for value in re.findall(r'"([^"\n]+)"', line)
                         if ('uploads' in value or 'taha-media' in value) and re.fullmatch(r'[A-Za-z0-9_./:-]{1,220}', value)]
                if methods and paths:
                    hits.append({'line': number, 'methods': methods, 'paths': paths})
        routes.append({'path': path, 'returnCode': captured.returncode, 'sha256': digest(captured.stdout) if captured.returncode == 0 else None,
                       'staticUploadRoutes': hits[:20]})
    return {'backendStaticMediaRouting': routes}


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
        ('mediaMounts', media_mount_state), ('nginxMediaRouting', nginx_media_state),
        ('exactMediaFiles', exact_media_files_state), ('exactMediaHttp', media_http_state),
        ('backendMediaRouting', go_static_media_state),
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
