"""Transfer only the receiver contract/model source needed for the requested fix."""
import base64,json,re
from pathlib import Path
base=Path('/var/www/tahashoes/gosporty-backend')
selected=['go.mod','Dockerfile','handlers/article.go','models/product.go','handlers/product.go','models/article.go']
result={}
for filename in selected:
    path=base/filename
    if not path.is_file():continue
    source=path.read_text()
    if len(source)>70000:raise RuntimeError('SOURCE_FILE_TOO_LARGE')
    # Never transfer inline connection credentials, environment files or auth config.
    if re.search(r'mongodb(?:\+srv)?://[^\s\"\x27]*@|(?:secret|password|token)\s*(?::=|=)\s*[\"\x27][A-Za-z0-9_+/=-]{24,}',source,re.I):
        raise RuntimeError('SOURCE_INLINE_CREDENTIAL_GUARD')
    result[filename]=source
print('RECEIVER_SOURCE_CONTEXT_BASE64='+base64.urlsafe_b64encode(json.dumps(result).encode()).decode().rstrip('='))
print('RECEIVER_MODEL_FILES='+json.dumps([p.name for p in (base/'models').glob('*.go')]))
compose=Path('/var/www/tahashoes/docker-compose.yml').read_text()
print('RECEIVER_COMPOSE_CONTEXT='+json.dumps([line for line in compose.splitlines() if re.search(r'TAHA_|env_file|gosporty-backend',line) and not re.search(r'(SECRET|PASSWORD|TOKEN)\s*[:=]\s*[^$\s]',line)]))
