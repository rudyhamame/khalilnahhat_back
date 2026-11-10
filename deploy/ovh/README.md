# Automatic deploys to OVH

Pushing to `main` in **khalilnahhat_front** or **khalilnahhat_back** deploys that repo to the OVH server through GitHub Actions
(`.github/workflows/deploy-ovh.yml`). Both repos need the same three Actions secrets:

| Secret | Value |
|---|---|
| `OVH_HOST` | the server address |
| `OVH_DEPLOY_KEY` | private half of a dedicated deploy key (its public half is in `~ubuntu/.ssh/authorized_keys` on the server, restricted: no port forwarding, no pty) |
| `OVH_KNOWN_HOSTS` | the server's ed25519 host key line, so CI refuses to talk to any other machine |

**Site** (`khalil-front/deploy/ovh/deploy-web.sh`): CI builds with the production API URLs, uploads `dist/`, the script copies it into
`/srv/rh/projects/khalil-front/dist` without deleting old hashed assets, saves the previous `index.html` under `releases/`, and restores it
if the public site does not serve the new build.

**API** (`deploy/ovh/deploy-api.sh`): CI uploads the source, the server builds `rh-khalil-api:git-<sha>` from the repo `Dockerfile`, switches
`/srv/rh/khalil-security/api-compose.private.json` to it and waits for the container to be healthy. If it is not healthy the previous image is
restored automatically (the old compose file is kept at `ci/api-compose.before-<sha>.json`). The last 3 builds are kept.

Manual rollback of the API: put the previous `rh-khalil-api:<tag>` back in the compose file and
`sudo docker compose -p khalil-api -f /srv/rh/khalil-security/api-compose.private.json up -d --no-deps rh-khalil-api`.
Revoke the deploy key by deleting its line (comment `github-actions-deploy@khalil`) from `~ubuntu/.ssh/authorized_keys`.
