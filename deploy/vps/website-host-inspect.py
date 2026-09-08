"""Read only service locations relevant to the tahashoes.vn receiver, never secrets."""
import json,re,subprocess
from pathlib import Path

containers=subprocess.run(['docker','ps','--format','{{.Names}}'],capture_output=True,text=True,check=True).stdout.splitlines()
print('HOST_CONTAINER_NAMES='+json.dumps(containers))
print('HOST_WEB_DIRECTORIES='+json.dumps([str(p) for base in ['/var/www','/opt'] if Path(base).is_dir() for p in Path(base).iterdir() if p.is_dir() and re.search('taha|shoe',p.name,re.I)]))
matches=[]
for base in ['/etc/nginx/sites-enabled','/etc/nginx/conf.d']:
    if not Path(base).is_dir():continue
    for path in Path(base).iterdir():
        if not path.is_file():continue
        contents=path.read_text(errors='replace')
        if re.search(r'\bserver_name\s+[^;]*\btahashoes\.vn\b',contents):
            matches.append({'file':str(path),'roots':re.findall(r'^\s*root\s+([^;]+);',contents,re.M),'upstreams':re.findall(r'^\s*proxy_pass\s+([^;]+);',contents,re.M)})
print('TAHASHOES_WEBSITE_VHOSTS='+json.dumps(matches))
