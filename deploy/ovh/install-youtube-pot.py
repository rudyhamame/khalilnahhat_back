#!/usr/bin/env python3
"""Add the pinned, private token provider to the existing production compose file.
Does not print the compose file, environment, or credentials. Start only the
provider here; deploy-api.sh applies the API environment during the next rollout.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

compose = Path(sys.argv[1] if len(sys.argv) > 1 else '/srv/rh/khalil-security/api-compose.private.json')
image = sys.argv[2] if len(sys.argv) > 2 else 'brainicism/bgutil-ytdlp-pot-provider:2.0.2'
config = json.loads(compose.read_text())
api = config['services']['rh-khalil-api']
# Isolate the unauthenticated generator from other containers. The provider also
# needs a normal outbound network to reach YouTube; neither network publishes ports.
networks = config.setdefault('networks', {})
networks['youtube-pot-private'] = {'internal': True}
networks['youtube-pot-outbound'] = {}
api_networks = api.get('networks', ['default'])
if isinstance(api_networks, list):
    api_networks = {name: {} for name in api_networks}
api_networks['youtube-pot-private'] = {}
api['networks'] = api_networks
# An implicit default network becomes explicit when adding named networks.
if 'default' in api_networks:
    networks.setdefault('default', {})
env = api.setdefault('environment', {})
if isinstance(env, list):
    env = dict(entry.split('=', 1) if '=' in entry else (entry, None) for entry in env)
    api['environment'] = env
env['YOUTUBE_PO_TOKEN_BASE_URL'] = 'http://youtube-pot:4416'
config['services']['youtube-pot'] = {
    'image': image,
    'restart': 'unless-stopped',
    'init': True,
    'mem_limit': '384m',
    'cpus': 0.5,
    'pids_limit': 128,
    'cap_drop': ['ALL'],
    'security_opt': ['no-new-privileges:true'],
    'networks': ['youtube-pot-private', 'youtube-pot-outbound'],
    'logging': {'driver': 'json-file', 'options': {'max-size': '5m', 'max-file': '2'}},
}
backup = compose.with_name('api-compose.before-youtube-pot.json')
if not backup.exists():
    shutil.copy2(compose, backup)
temporary = compose.with_suffix('.pot-tmp.json')
temporary.write_text(json.dumps(config, indent=2) + '\n')
os.chmod(temporary, 0o600)
subprocess.run(['docker', 'compose', '-p', 'khalil-api', '-f', str(temporary), 'config', '--quiet'], check=True)
os.replace(temporary, compose)
subprocess.run(['docker', 'compose', '-p', 'khalil-api', '-f', str(compose), 'up', '-d', '--no-deps', 'youtube-pot'], check=True)
print('Private YouTube token provider configured; API rollout enables it.')
