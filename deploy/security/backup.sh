#!/usr/bin/env bash
set -euo pipefail
umask 077
root=/srv/rh/khalil-security
exec 9>/run/lock/khalil-backup.lock
flock -n 9 || exit 0
available=$(df -Pk "$root" | awk 'NR==2 {print $4}')
if [ "$available" -lt 1048576 ]; then echo 'Khalil backup refused: less than 1 GiB free.' >&2; exit 1; fi
scratch=$(mktemp -d "$root/tmp/backup.XXXXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
name="khalil-$(date -u +%Y%m%dT%H%M%SZ)"
target="$root/backups/$name.cms"
docker exec -i deploy-rh-khalil-api-1 node < "$root/security-backup-export.js" | gzip -c > "$scratch/atlas.ndjson.gz"
cp /srv/rh/echo-dj/khalil-migration-20261108/production.env "$scratch/production.env"
cp /srv/rh/echo-dj/khalil-migration-20261108/atlas-compose.private.json "$scratch/compose.json"
cp /srv/rh/khalil-cloudflare/connector.token "$scratch/tunnel.token"
for file in /srv/rh/khalil-security/stem-compose.private.json /srv/rh/khalil-security/frontend-compose.json /srv/rh/khalil-security/frontend.Caddyfile /srv/rh/khalil-security/shared-frontends.private.json /srv/rh/khalil-cloudflare/compose.json /srv/rh/streaming/deploy/ovh-projects.Caddyfile; do
  if [ -f "$file" ]; then cp "$file" "$scratch/$(basename "$(dirname "$file")")-$(basename "$file")"; fi
done
cp "$root/security-backup-export.js" "$scratch/"
if [ -f "$root/backend-source.tar.gz" ]; then cp "$root/backend-source.tar.gz" "$scratch/"; fi
docker inspect echo-obs-media echo-obs-turn echo-obs-proxy echo-obs-controller > "$scratch/obs-containers.private.json"
tar -czf - -C "$scratch" . |
  openssl cms -encrypt -binary -aes-256-cbc -outform DER -out "$target.part" "$root/backup-public.pem"
mv "$target.part" "$target"
(cd "$root/backups" && sha256sum "$name.cms" > "$name.cms.sha256")
find "$root/backups" -maxdepth 1 -type f -name 'khalil-*.cms*' -mtime +7 -delete
echo "Encrypted Khalil backup completed: $name"
