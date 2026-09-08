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
details=json.loads(subprocess.run(['docker','inspect','tahashoes-backend','--format','{{json .Mounts}}'],capture_output=True,text=True,check=True).stdout)
print('TAHASHOES_BACKEND_MOUNTS='+json.dumps([{'source':m['Source'],'destination':m['Destination']} for m in details]))
base=Path('/var/www/tahashoes')
print('TAHASHOES_SOURCE_ENTRIES='+json.dumps([p.name for p in base.iterdir() if not p.name.startswith('.')]))
for folder in ['backend','server']:
    path=base/folder
    if path.is_dir():
        print('TAHASHOES_BACKEND_ENTRIES='+json.dumps({'folder':folder,'files':[p.name for p in path.iterdir() if not p.name.startswith('.') and p.name!='node_modules']}))
        pkg=path/'package.json'
        if pkg.exists():
            data=json.loads(pkg.read_text());print('TAHASHOES_BACKEND_PACKAGE='+json.dumps({'name':data.get('name'),'main':data.get('main'),'scripts':data.get('scripts'),'dependencies':data.get('dependencies')}))
for filename in ['docker-compose.yml','compose.yml']:
    path=base/filename
    if path.is_file():
        text=path.read_text()
        # Locations only; environment and credential values are never printed.
        print('TAHASHOES_COMPOSE_LOCATIONS='+json.dumps({'file':filename,'locations':[l.strip() for l in text.splitlines() if re.match(r'\s*(?:build:|context:|dockerfile:|image:|container_name:|command:)',l)]}))
