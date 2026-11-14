#!/usr/bin/env python3
"""Configure private, persistent YouTube session storage. No credentials printed."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
compose=Path(sys.argv[1] if len(sys.argv)>1 else '/srv/rh/khalil-security/api-compose.private.json')
storage=Path('/srv/rh/khalil-security/runtime/youtube-session')
config=json.loads(compose.read_text())
api=config['services']['rh-khalil-api']
node_uid=int(subprocess.check_output(['docker','exec','deploy-rh-khalil-api-1','id','-u'],text=True).strip())
node_gid=int(subprocess.check_output(['docker','exec','deploy-rh-khalil-api-1','id','-g'],text=True).strip())
storage.mkdir(parents=True,exist_ok=True,mode=0o700)
os.chmod(storage,0o700)
os.chown(storage,node_uid,node_gid)
mount={'type':'bind','source':str(storage),'target':'/app/.runtime/youtube-session'}
volumes=api.setdefault('volumes',[])
# Running the installer twice must preserve the same private mount.
volumes[:]=[value for value in volumes if (value.get('target') if isinstance(value,dict) else value.split(':')[1] if ':' in value else '')!=mount['target']]
volumes.append(mount)
env=api.setdefault('environment',{})
if isinstance(env,list):
    env=dict(entry.split('=',1) if '=' in entry else (entry,None) for entry in env)
    api['environment']=env
env['YT_DLP_COOKIES_FILE']='/app/.runtime/youtube-session/cookies.txt'
backup=compose.with_name('api-compose.before-youtube-session.json')
if not backup.exists():shutil.copy2(compose,backup)
temporary=compose.with_suffix('.session-tmp.json')
temporary.write_text(json.dumps(config,indent=2)+'\n')
os.chmod(temporary,0o600)
subprocess.run(['docker','compose','-p','khalil-api','-f',str(temporary),'config','--quiet'],check=True)
os.replace(temporary,compose)
print('Private session storage configured. API rollout will mount it; no session has been supplied by this installer.')
