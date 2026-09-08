"""Read only service locations relevant to the tahashoes.vn receiver, never secrets."""
import json,os,re,subprocess
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
for folder in ['backend','server','gosporty-backend']:
    path=base/folder
    if path.is_dir():
        print('TAHASHOES_BACKEND_ENTRIES='+json.dumps({'folder':folder,'files':[p.name for p in path.iterdir() if not p.name.startswith('.') and p.name!='node_modules']}))
        pkg=path/'package.json'
        if pkg.exists():
            data=json.loads(pkg.read_text());print('TAHASHOES_BACKEND_PACKAGE='+json.dumps({'name':data.get('name'),'main':data.get('main'),'scripts':data.get('scripts'),'dependencies':data.get('dependencies')}))
backend=base/'gosporty-backend'
for root,dirs,files in os.walk(backend):
    dirs[:]=[d for d in dirs if d not in ['node_modules','.git','uploads','logs']]
    for filename in files:
        path=Path(root)/filename
        if path.suffix not in ['.js','.cjs','.mjs','.ts'] or path.stat().st_size>200000:continue
        lines=path.read_text(errors='replace').splitlines()
        hits=[i for i,line in enumerate(lines) if re.search(r'receiver not configured|/taha/publish|TAHA_WEBHOOK|TAHA_PUBLISH|tahaRoutes',line)]
        if not hits:continue
        indexes=sorted({i for hit in hits for i in range(max(0,hit-12),min(len(lines),hit+100))})
        safe=[]
        for i in indexes:
            line=lines[i]
            line=re.sub(r'mongodb(?:\+srv)?://[^\s\"\x27]+','[DATABASE_URL_REDACTED]',line)
            line=re.sub(r'((?:secret|token|password|key)\s*[:=]\s*)[\"\x27][^\"\x27]+[\"\x27]',r'\1[REDACTED_LITERAL]',line,flags=re.I)
            safe.append(str(i+1)+': '+line)
        print('TAHASHOES_RECEIVER_SOURCE='+json.dumps({'file':str(path.relative_to(base)),'lines':safe},ensure_ascii=False))
process_env=json.loads(subprocess.run(['docker','inspect','tahashoes-backend','--format','{{json .Config.Env}}'],capture_output=True,text=True,check=True).stdout)
print('TAHASHOES_RECEIVER_ENV_PRESENCE='+json.dumps({item.split('=',1)[0]:bool(item.split('=',1)[1]) for item in process_env if item.startswith(('TAHA_','WEBSITE_'))}))
for filename in ['docker-compose.yml','compose.yml']:
    path=base/filename
    if path.is_file():
        text=path.read_text()
        # Locations only; environment and credential values are never printed.
        print('TAHASHOES_COMPOSE_LOCATIONS='+json.dumps({'file':filename,'locations':[l.strip() for l in text.splitlines() if re.match(r'\s*(?:build:|context:|dockerfile:|image:|container_name:|command:)',l)]}))
