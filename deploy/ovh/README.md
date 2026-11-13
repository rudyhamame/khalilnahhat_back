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

## Recording disk maintenance

`khalil-recording-maintenance.timer` runs hourly. Its service invokes `/usr/local/sbin/khalil-recording-maintenance`, which deletes only untagged Docker images unused for at least 24 hours and verifies archived recording parts before removing redundant direct-recording folders. Tagged rollback images, volumes, active captures, unsaved recordings and folders without a database record are preserved. Recording cleanup shares the API's recording lease so it cannot race capture or archive jobs.

Install the two unit files from this directory under `/etc/systemd/system/`, `recording-maintenance.sh` as `/usr/local/sbin/khalil-recording-maintenance` (0755), and `recording-maintenance.cjs` under `/usr/local/lib/khalil/` (0644). Then run `systemctl daemon-reload` and `systemctl enable --now khalil-recording-maintenance.timer`. Inspect the last run with `systemctl status khalil-recording-maintenance.service`.

Recording comments are snapshotted when browser recording finalizes. Capture timelines preserve the wall-clock ranges actually recorded, excluding pauses, so archived comments and host replies follow playback and preview trims. Older recordings use an approximate timestamp based on their creation time. Device-only recordings retain their timing and available comment history in their local `recording.json` manifest.
