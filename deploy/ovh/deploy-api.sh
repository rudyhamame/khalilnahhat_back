#!/usr/bin/env bash
# Runs on the OVH server (piped in by the GitHub workflow): builds the API image from the uploaded source, switches the
# production compose file to it and waits for "healthy". If the new container does not become healthy the previous
# image is restored. With --build-only it only builds and checks that the image loads (used to test the pipeline).
set -euo pipefail
SHA=${1:?commit sha}; MODE=${2:-}
ROOT=/srv/rh/khalil-security
CTX=$ROOT/ci/api/$SHA
COMPOSE=$ROOT/api-compose.private.json
TAG=rh-khalil-api:git-${SHA:0:12}
CONTAINER=deploy-rh-khalil-api-1
[ -f "$CTX/Dockerfile" ] || { echo "missing upload $CTX"; exit 1; }
docker build -q -t "$TAG" "$CTX" >/dev/null
docker run --rm --entrypoint node "$TAG" -e "require('./src/live-recordings');require('./src/live-broadcast');require('./src/live-comments');console.log('image loads')"
[ "$MODE" = "--build-only" ] && { echo "built $TAG"; exit 0; }
OLD=$(sudo grep -o 'rh-khalil-api:[A-Za-z0-9._-]*' "$COMPOSE" | head -1)
[ -n "$OLD" ] || { echo "cannot find the current image in $COMPOSE"; exit 1; }
[ "$OLD" = "$TAG" ] && { echo "already running $TAG"; exit 0; }
BACKUP=$ROOT/ci/api-compose.before-${SHA:0:12}.json
sudo cp -p "$COMPOSE" "$BACKUP"
up() {
  sudo docker compose -p khalil-api -f "$COMPOSE" up -d --no-deps rh-khalil-api
  for i in $(seq 1 40); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo none)" = healthy ] && return 0
    sleep 3
  done
  return 1
}
sudo sed -i "s#$OLD#$TAG#" "$COMPOSE"
if up; then
  echo "deployed $TAG (was $OLD)"
else
  echo "new image is not healthy, rolling back to $OLD"
  docker logs --tail 20 "$CONTAINER" 2>&1 | cut -c1-200 || true
  sudo cp -p "$BACKUP" "$COMPOSE"; up || true
  exit 1
fi
ls -dt "$ROOT"/ci/api/*/ | tail -n +4 | xargs -r rm -rf
docker images --format '{{.Repository}}:{{.Tag}}' rh-khalil-api | grep ':git-' | tail -n +4 | xargs -r docker rmi >/dev/null 2>&1 || true
