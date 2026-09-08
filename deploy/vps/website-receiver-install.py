"""Stage a reviewed receiver from the exact running image; --apply installs it locally.

Check-only is the default. No secret changes, user payloads, registry push, or live
publish probes. Build/test subprocess output is captured and never printed.
"""
import argparse
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

BASE = Path('/var/www/tahashoes')
HOST = BASE / 'gosporty-backend/handlers'
COMPOSE_FILE = BASE / 'docker-compose.yml'
CONTAINER = 'tahashoes-backend'
HERE = Path(__file__).resolve().parent
RECEIVER_DIR = HERE.parent / 'website-receiver' if HERE.name == 'vps' else HERE
ADAPTER_HASH = 'e61cdd544e132986f77bd71e92349abdd08a8e25c6d095518b9257670c54beda'
TEST_HASH = '7c8386c7db591820025441a82b51f0e90d3259ee5876548f329686d1467876a7'
FILES = ('article.go', 'product_receiver.go', 'product_receiver_test.go')
LABELS = {
    'com.docker.compose.project': 'tahashoes',
    'com.docker.compose.service': 'backend',
    'com.docker.compose.project.working_dir': str(BASE),
    'com.docker.compose.project.config_files': str(COMPOSE_FILE),
}
AUTH = '''\tif !validWebsiteSignature(r, secret, body) {
\t\thttp.Error(w, "invalid signature", http.StatusUnauthorized)
\t\treturn
\t}
'''
KEY = '''\tidempotencyKey := strings.TrimSpace(r.Header.Get("X-TAHA-Idempotency-Key"))
\tif idempotencyKey == "" || len(idempotencyKey) > 180 {
\t\thttp.Error(w, "invalid idempotency key", http.StatusBadRequest)
\t\treturn
\t}
'''
HOOK = '''\tif tryPublishWebsiteProduct(w, r, body, idempotencyKey) {
\t\treturn
\t}
'''
DECODER = '\n\tvar payload websiteArticlePayload'


class GuardError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise GuardError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def private_command(args, *, timeout=30, env=None, data=None):
    result = subprocess.run(args, input=data, capture_output=True, timeout=timeout, cwd=BASE, env=env)
    require(result.returncode == 0, 'RECEIVER_COMMAND_FAILED')
    return result.stdout


def compose_command():
    for command in (['docker', 'compose'], ['docker-compose']):
        try:
            result = subprocess.run(command + ['version'], capture_output=True, timeout=10)
        except FileNotFoundError:
            continue
        if result.returncode == 0:
            return command + ['-p', 'tahashoes', '-f', str(COMPOSE_FILE), '--project-directory', str(BASE)]
    raise GuardError('RECEIVER_COMPOSE_UNAVAILABLE')


def inspect_container():
    rows = json.loads(private_command(['docker', 'inspect', CONTAINER]))
    require(len(rows) == 1, 'RECEIVER_CONTAINER_AMBIGUOUS')
    return rows[0]


def image_id(name):
    return private_command(['docker', 'image', 'inspect', name, '--format', '{{.Id}}']).decode().strip()


def compose_config(command):
    return json.loads(private_command(command + ['config', '--format', 'json']))


def environment(container):
    pairs = [item.split('=', 1) for item in container['Config'].get('Env', []) if '=' in item]
    require(len({key for key, _ in pairs}) == len(pairs), 'RECEIVER_ENV_DUPLICATE')
    return dict(pairs)


def runtime_shape(container):
    # Inspect values remain private. Compare before/after; never print them.
    return {
        'env': environment(container),
        'mounts': sorted((item['Type'], item.get('Source', ''), item['Destination'], item.get('RW'))
                         for item in container.get('Mounts', [])),
        'ports': container['HostConfig'].get('PortBindings'),
        'networks': sorted(container['NetworkSettings'].get('Networks', {})),
    }


def validate_identity(container, expected_container, expected_image):
    require(container['Id'] == expected_container and container['Image'] == expected_image,
            'RECEIVER_RUNTIME_CHANGED')
    require(container.get('State', {}).get('Running') is True, 'RECEIVER_NOT_RUNNING')
    require(all(container['Config'].get('Labels', {}).get(key) == value for key, value in LABELS.items()),
            'RECEIVER_COMPOSE_IDENTITY_MISMATCH')
    require(container['Config'].get('WorkingDir') == '/app', 'RECEIVER_IMAGE_LAYOUT_UNSUPPORTED')
    immutable_paths = ('/app/server', '/app/handlers/article.go', '/app/handlers/product_receiver.go',
                       '/app/handlers/product_receiver_test.go', '/app/go.mod', '/app/go.sum')
    mounts = container.get('Mounts', [])
    require(not any(target == item['Destination'].rstrip('/')
                    or target.startswith(item['Destination'].rstrip('/') + '/')
                    for item in mounts for target in immutable_paths), 'RECEIVER_APP_SOURCE_MOUNTED')
    require(any(item['Type'] in ('bind', 'volume') and item.get('RW') is True
                and item['Destination'].rstrip('/') in ('/data', '/data/taha-media')
                for item in mounts), 'RECEIVER_MEDIA_NOT_PERSISTENT')


def source_snapshot(name):
    path = HOST / name
    require(not path.is_symlink(), 'RECEIVER_SOURCE_SYMLINK')
    if not path.exists():
        return None
    require(path.is_file(), 'RECEIVER_SOURCE_NOT_REGULAR')
    info = path.stat()
    return {'bytes': path.read_bytes(), 'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid}


def assert_sources_match(sources):
    require(all(source_snapshot(name) == source for name, source in sources.items()), 'RECEIVER_HOST_SOURCE_CHANGED')


def prepare_article(raw):
    text = raw.decode('utf-8')
    handler = text.find('func PublishWebsiteArticle(w http.ResponseWriter, r *http.Request) {')
    auth = text.find(AUTH, handler)
    key = text.find(KEY, auth)
    require(handler >= 0 and auth > handler and key > auth, 'RECEIVER_AUTH_CONTEXT_UNREVIEWED')
    require(text.count(KEY) == 1, 'RECEIVER_IDEMPOTENCY_CONTEXT_AMBIGUOUS')
    calls = text.count('tryPublishWebsiteProduct(w, r, body, idempotencyKey)')
    if calls:
        require(calls == 1 and text.count(KEY + HOOK + DECODER) == 1,
                'RECEIVER_EXISTING_HOOK_UNREVIEWED')
        return raw
    require(text.count(KEY + DECODER) == 1, 'RECEIVER_LEGACY_CONTEXT_UNREVIEWED')
    return text.replace(KEY + DECODER, KEY + HOOK + DECODER, 1).encode()


def atomic_write(path, data, metadata):
    fd, temporary = tempfile.mkstemp(prefix='.receiver-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), metadata['mode'])
            os.fchown(stream.fileno(), metadata['uid'], metadata['gid'])
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
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


def local_products_url(container):
    bindings = container['HostConfig'].get('PortBindings', {}).get('8080/tcp') or []
    local = [item for item in bindings if item.get('HostIp', '') in ('', '0.0.0.0', '127.0.0.1')]
    require(len(local) == 1, 'RECEIVER_LOCAL_PORT_UNAVAILABLE')
    port = local[0].get('HostPort', '')
    require(isinstance(port, str) and port.isdigit() and 1 <= int(port) <= 65535,
            'RECEIVER_LOCAL_PORT_INVALID')
    return 'http://127.0.0.1:' + port + '/api/products?limit=1'


def public_probe(container):
    # Query the actual backend locally; a CDN-cached response cannot pass this gate.
    request = Request(local_products_url(container), headers={'Accept': 'application/json'})
    with build_opener(ProxyHandler({}), NoRedirect).open(request, timeout=10) as response:
        require(response.status == 200, 'RECEIVER_PUBLIC_PRODUCTS_FAILED')
        body = json.loads(response.read(2_000_001))
    require(isinstance(body, dict) and isinstance(body.get('products'), list), 'RECEIVER_PUBLIC_PRODUCTS_INVALID')


def wait_ready(expected_image, original_shape):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            current = inspect_container()
            require(current['Image'] == expected_image, 'RECEIVER_NEW_IMAGE_MISMATCH')
            require(current.get('State', {}).get('Running') is True, 'RECEIVER_NEW_NOT_RUNNING')
            require(runtime_shape(current) == original_shape, 'RECEIVER_RUNTIME_CONFIG_CHANGED')
            health = current.get('State', {}).get('Health', {}).get('Status')
            require(health in (None, 'healthy'), 'RECEIVER_CONTAINER_NOT_HEALTHY')
            public_probe(current)
            return
        except Exception:
            time.sleep(2)
    raise GuardError('RECEIVER_HEALTH_VERIFICATION_FAILED')


def tag(source, destination):
    private_command(['docker', 'tag', source, destination])


def recreate(command):
    private_command(command + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                               '--force-recreate', 'backend'], timeout=180)


def build_failure(output, timed_out=False):
    markers = re.findall(rb'RECEIVER_BUILD_STAGE=(formatting|test|build)(?:\r?\n|$)', output)
    stage = markers[-1].decode() if markers else 'preparing'
    if timed_out:
        return stage, 'build_timeout'
    if re.search(rb'module lookup disabled|missing go.sum entry|no required module provides package|'
                 rb'cannot find (?:module|package)|requires go >=|go: toolchain not available', output):
        return stage, 'dependency_unavailable'
    return stage, {'formatting': 'formatting_failed', 'test': 'test_failed'}.get(stage, 'build_failed')


def run_offline_build(args, env):
    timed_out = False
    try:
        result = subprocess.run(args, capture_output=True, timeout=1200, cwd=BASE, env=env)
        if result.returncode == 0:
            return
        output = result.stdout + b'\n' + result.stderr
    except subprocess.TimeoutExpired as error:
        timed_out = True
        output = (error.stdout or b'') + b'\n' + (error.stderr or b'')
    stage, code = build_failure(output, timed_out)
    log_path = None
    try:
        root = BASE / '.taha-receiver-backups'
        if root.is_symlink():
            raise OSError('unavailable')
        root.mkdir(mode=0o700, exist_ok=True)
        fd, path = tempfile.mkstemp(prefix='offline-build-', suffix='.log', dir=root)
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(output)
            stream.flush()
            os.fsync(stream.fileno())
        log_path = path
    except OSError:
        pass
    # Fixed flags and a generated private path only; raw build/test output may
    # contain application configuration and must never enter workflow logs.
    print('RECEIVER_OFFLINE_BUILD_FAILURE=' + json.dumps({'stage': stage, 'code': code,
                                                       'privateLog': log_path}), flush=True)
    raise GuardError('RECEIVER_' + code.upper())


def build_child(expected_image, prepared, stage):
    parent_tag = 'taha-receiver-parent:' + uuid.uuid4().hex
    child_tag = 'taha-receiver-staged:' + uuid.uuid4().hex
    tag(expected_image, parent_tag)
    require(image_id(parent_tag) == expected_image, 'RECEIVER_PARENT_TAG_MISMATCH')
    for name, data in prepared.items():
        (stage / name).write_bytes(data)
    dockerfile = '\n'.join([
        'FROM ' + parent_tag, 'WORKDIR /app',
        'COPY article.go product_receiver.go product_receiver_test.go ./handlers/',
        'RUN echo RECEIVER_BUILD_STAGE=test && GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go test ./handlers',
        'RUN echo RECEIVER_BUILD_STAGE=build && GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go build -o server', '',
    ])
    (stage / 'Dockerfile').write_text(dockerfile)
    # A local uniquely tagged base is checked against the immutable running ID.
    # The legacy builder resolves daemon-local images without registry metadata.
    build_env = dict(os.environ, DOCKER_BUILDKIT='0')
    run_offline_build(['docker', 'build', '--network', 'none', '--pull=false', '-t', child_tag, str(stage)], build_env)
    require(image_id(parent_tag) == expected_image, 'RECEIVER_PARENT_CHANGED_DURING_BUILD')
    return image_id(child_tag), child_tag, parent_tag


def main(args):
    require(re.fullmatch(r'[0-9a-f]{64}', args.expected_container_id) is not None, 'RECEIVER_EXPECTED_CONTAINER_REQUIRED')
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', args.expected_image_id) is not None, 'RECEIVER_EXPECTED_IMAGE_REQUIRED')
    require(re.fullmatch(r'[0-9a-f]{64}', args.expected_article_sha256) is not None, 'RECEIVER_EXPECTED_ARTICLE_REQUIRED')
    require(HOST.is_dir() and HOST.resolve() == HOST, 'RECEIVER_HOST_SOURCE_PATH_INVALID')
    adapter = (RECEIVER_DIR / 'product_receiver.go').read_bytes()
    tests = (RECEIVER_DIR / 'product_receiver_test.go').read_bytes()
    require(digest(adapter) == ADAPTER_HASH and digest(tests) == TEST_HASH, 'RECEIVER_REVIEWED_FILES_CHANGED')
    command = compose_command()
    current = inspect_container()
    validate_identity(current, args.expected_container_id, args.expected_image_id)
    sources = {name: source_snapshot(name) for name in FILES}
    require(sources['article.go'] is not None, 'RECEIVER_HOST_ARTICLE_MISSING')
    article = sources['article.go']['bytes']
    require(digest(article) == args.expected_article_sha256, 'RECEIVER_HOST_ARTICLE_CHANGED')
    live_article = private_command(['docker', 'exec', CONTAINER, 'cat', '/app/handlers/article.go'])
    require(live_article == article, 'RECEIVER_HOST_CONTAINER_ARTICLE_MISMATCH')
    prepared = {'article.go': prepare_article(article), 'product_receiver.go': adapter, 'product_receiver_test.go': tests}
    # The legacy article is not gofmt-normalized. Format only its in-memory
    # patched bytes using the running image's Go tool; no container file write.
    prepared['article.go'] = private_command(['docker', 'exec', '-i', CONTAINER, 'gofmt'],
                                            data=prepared['article.go'])
    baseline = compose_config(command)
    backend = baseline.get('services', {}).get('backend', {})
    require(backend.get('container_name') == CONTAINER, 'RECEIVER_COMPOSE_CONTAINER_MISMATCH')
    image_name = backend.get('image') or 'tahashoes-backend'
    require(isinstance(image_name, str) and image_name and '@' not in image_name, 'RECEIVER_COMPOSE_IMAGE_UNSUPPORTED')
    require(current['Config']['Image'] == image_name and image_id(image_name) == args.expected_image_id,
            'RECEIVER_COMPOSE_IMAGE_TAG_DRIFT')
    env = environment(current)
    require(all(env.get(key) == value for key, value in backend.get('environment', {}).items()),
            'RECEIVER_COMPOSE_ENV_DRIFT')
    original_shape = runtime_shape(current)
    public_probe(current)
    private_command(['docker', 'exec', CONTAINER, 'go', 'version'])
    private_command(['docker', 'exec', CONTAINER, 'test', '-f', '/app/go.mod'])
    if not args.apply:
        print('RECEIVER_INSTALL_CHECK=' + json.dumps({'ready': True, 'adapterSha256': ADAPTER_HASH,
              'articleSha256': digest(article), 'patchedArticleSha256': digest(prepared['article.go']),
              'buildTestsPending': True, 'changed': False}))
        return
    with open('/var/lock/taha-website-receiver-repair.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        validate_identity(inspect_container(), args.expected_container_id, args.expected_image_id)
        assert_sources_match(sources)
        require(compose_config(command) == baseline, 'RECEIVER_COMPOSE_CHANGED')
        # Stage and test completely before changing live host files or image tags.
        print('RECEIVER_INSTALL_STAGE=offline_build_and_tests', flush=True)
        with tempfile.TemporaryDirectory(prefix='taha-receiver-build-') as temporary:
            new_image, child_tag, parent_tag = build_child(args.expected_image_id, prepared, Path(temporary))
        print('RECEIVER_INSTALL_STAGE=offline_build_verified', flush=True)
        validate_identity(inspect_container(), args.expected_container_id, args.expected_image_id)
        assert_sources_match(sources)
        require(compose_config(command) == baseline and image_id(image_name) == args.expected_image_id,
                'RECEIVER_RUNTIME_CHANGED_DURING_BUILD')
        backup_root = BASE / '.taha-receiver-backups'
        backup_root.mkdir(mode=0o700, exist_ok=True)
        backup = Path(tempfile.mkdtemp(prefix='adapter-', dir=backup_root))
        old_tag = 'taha-receiver-rollback:' + uuid.uuid4().hex
        tag(args.expected_image_id, old_tag)
        manifest = {'oldImageId': args.expected_image_id, 'newImageId': new_image, 'imageName': image_name,
                    'oldTag': old_tag, 'stagedTag': child_tag, 'parentTag': parent_tag,
                    'sources': {name: None if item is None else {key: value for key, value in item.items() if key != 'bytes'}
                                for name, item in sources.items()}}
        for name, source in sources.items():
            if source is not None:
                (backup / name).write_bytes(source['bytes'])
                (backup / name).chmod(0o600)
        (backup / 'manifest.json').write_text(json.dumps(manifest))
        (backup / 'manifest.json').chmod(0o600)
        changed, retagged, recreated = [], False, False
        try:
            for name, data in prepared.items():
                metadata = sources[name] or {**sources['article.go'], 'mode': 0o644}
                changed.append(name)
                atomic_write(HOST / name, data, metadata)
            require(compose_config(command) == baseline, 'RECEIVER_CONFIG_CHANGED_BEFORE_RECREATE')
            retagged = True
            tag(new_image, image_name)
            require(image_id(image_name) == new_image, 'RECEIVER_NEW_TAG_MISMATCH')
            recreated = True
            recreate(command)
            wait_ready(new_image, original_shape)
            require(private_command(['docker', 'exec', CONTAINER, 'cat', '/app/handlers/product_receiver.go']) == adapter,
                    'RECEIVER_NEW_SOURCE_MISMATCH')
            print('RECEIVER_INSTALL_VERIFIED=' + json.dumps({'imageId': new_image, 'adapterSha256': ADAPTER_HASH,
                  'backup': str(backup), 'tests': 'go test ./handlers', 'secretChanged': False}))
        except Exception:
            # Stop rollback rather than overwrite an unrelated concurrent edit.
            require(compose_config(command) == baseline, 'RECEIVER_ROLLBACK_CONFIG_DRIFT')
            for name in changed:
                actual = source_snapshot(name)
                original = sources[name]
                require((actual['bytes'] if actual else None) in (prepared[name], original['bytes'] if original else None),
                        'RECEIVER_ROLLBACK_SOURCE_DRIFT')
            if retagged:
                require(image_id(image_name) in (new_image, args.expected_image_id), 'RECEIVER_ROLLBACK_TAG_DRIFT')
                tag(args.expected_image_id, image_name)
            for name in reversed(changed):
                if sources[name] is None:
                    (HOST / name).unlink(missing_ok=True)
                else:
                    atomic_write(HOST / name, sources[name]['bytes'], sources[name])
            if recreated:
                recreate(command)
                wait_ready(args.expected_image_id, original_shape)
            assert_sources_match(sources)
            print('RECEIVER_INSTALL_ROLLBACK=' + str(backup))
            raise GuardError('RECEIVER_INSTALL_FAILED_ROLLED_BACK') from None


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-container-id', required=True)
    parser.add_argument('--expected-image-id', required=True)
    parser.add_argument('--expected-article-sha256', required=True)
    parser.add_argument('--apply', action='store_true')
    try:
        main(parser.parse_args())
    except GuardError as error:
        sys.exit(str(error))
    except Exception:
        sys.exit('RECEIVER_INSTALL_FAILED_WITHOUT_SAFE_DETAIL')
