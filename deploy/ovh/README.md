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

## YouTube proof-of-origin tokens

The API image installs `bgutil-ytdlp-pot-provider==2.0.2`. The private provider
must run on OVH too. Pull `brainicism/bgutil-ytdlp-pot-provider:2.0.2`, resolve its
repository digest with `docker image inspect`, then run
`sudo python3 deploy/ovh/install-youtube-pot.py /srv/rh/khalil-security/api-compose.private.json <image@sha256:digest>`.
The installer backs up the compose file, adds a private API/provider network and
an outbound provider network, and starts only the provider. No host ports are
published. A normal API rollout then enables `YOUTUBE_PO_TOKEN_BASE_URL`.
The service has a 384 MB memory limit and a half-core CPU limit. Check `/ping`
from inside the API container and inspect yt-dlp verbose output for the
`bgutil:http` provider and token generation. The converter selects `mweb` when
configured, and continues to avoid cookies and automatic browser credentials.
PO tokens do not guarantee that YouTube accepts an OVH address; a login-required
response remains a visible, retryable failure. Rollback: restore the saved compose
file and recreate the API using its previous image; remove the provider service
only after the API no longer uses it.

## Authenticated YouTube converter session

Run `sudo python3 deploy/ovh/install-youtube-session.py` before an API rollout.
It creates a mode-0700 directory owned by the container user under
`/srv/rh/khalil-security/runtime/youtube-session`, bind mounts it privately, and
sets `YT_DLP_COOKIES_FILE`. No cookie values are part of the image or repository.
Admins connect a session once at `/admin/youtube`, then use **Check access**.
Saving a session never claims access is verified: an actual conversion must pass.
Each conversion validates the session and uses a temporary mode-0600 snapshot,
which is removed with all other temporary files on success or failure. yt-dlp
cannot overwrite the saved session or recover browser credentials automatically.
Disconnecting removes the persistent credentials; no existing conversion retains
a snapshot after it finishes. The shared conversion lock also prevents replacing
or disconnecting the session during imports, checks and guest-request conversion.
