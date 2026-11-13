#!/usr/bin/env bash
set -euo pipefail
exec 9>/run/lock/khalil-recording-maintenance.lock
flock -n 9 || exit 0
# Dangling images only: never remove tagged rollback images, containers or volumes.
docker image prune --force --filter until=24h | tail -n 1
if [ "$(docker inspect -f '{{.State.Health.Status}}' deploy-rh-khalil-api-1 2>/dev/null || true)" = healthy ]; then
  timeout 240 docker exec -i deploy-rh-khalil-api-1 node < /usr/local/lib/khalil/recording-maintenance.cjs
fi
df -h /
