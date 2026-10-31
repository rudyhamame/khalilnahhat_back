#!/usr/bin/env python3
"""Reload TURN's certificate after Caddy renews it, without dropping calls."""
import hashlib
import pathlib
import subprocess
root=pathlib.Path('/srv/rh/echo-obs-relay')
cert=root/'tls/caddy/certificates/acme-v02.api.letsencrypt.org-directory/vps-ba7fb4cb.vps.ovh.ca/vps-ba7fb4cb.vps.ovh.ca.crt'
if cert.exists():
    digest=hashlib.sha256(cert.read_bytes()).hexdigest()
    previous=root/'state/turn-certificate.sha256'
    if not previous.exists() or previous.read_text()!=digest:
        subprocess.run(['docker','kill','--signal=SIGUSR2','echo-obs-turn'],check=True,stdout=subprocess.DEVNULL)
        previous.write_text(digest)
        previous.chmod(0o600)
