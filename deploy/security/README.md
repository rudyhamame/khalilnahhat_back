# Khalil production security operations

Applied 2026-11-08. Production is on OVH; MongoDB remains remote Atlas. No production secret belongs in this repository.

## Deployment map

| Component | Durable configuration on OVH | Container |
|---|---|---|
| API | `/srv/rh/khalil-security/api-compose.private.json` (symlink to the dated migration configuration) | `deploy-rh-khalil-api-1` |
| Frontend | `/srv/rh/khalil-security/frontend-compose.json` and `frontend.Caddyfile` | `khalil-frontend` |
| Stem worker | `/srv/rh/khalil-security/stem-compose.private.json` | `khalil-stem-worker` |
| Cloudflare connector | `/srv/rh/khalil-cloudflare/compose.json` | `khalil-cloudflared` |

Use the dedicated Compose files for recreation. The API project is `khalil-api`, with its legacy container name retained for backup compatibility. Its external bridge `khalil_api` was created with subnet `172.30.50.0/24`, gateway `172.30.50.1`. Recreate that network first on a replacement server; the API's trusted-proxy configuration depends on that gateway. The checked-in API template requires an immutable image and the private environment file. Do not use the legacy shared-stack API service; its profile is disabled by default.

API secret environment: `/srv/rh/echo-dj/khalil-migration-20261108/production.env`, mode 0600. Preserve `SESSION_ENCRYPTION_KEY` in recovery material: rotating it invalidates server-decrypted background sessions. For an emergency session reset, revoke the stored session hashes/encrypted values and have users sign in again. Do not print environment files, `docker inspect` environments, tokens or connection strings into tickets/logs. Connector token: `/srv/rh/khalil-cloudflare/connector.token`, owned by UID 65532, mode 0600.

The frontend only mounts public distribution files and its Caddy configuration. It does not mount backend source or environment files. Static distribution updates retain previous hashed assets for open clients. Remove obsolete assets only after a deliberate retention review. The API's `/tmp`, `/var/tmp` and `/app/.runtime` are private disk-backed writable directories; removing these mounts breaks uploads/recordings with the read-only root filesystem.

## Authentication policy

New/reset passwords require 12–128 characters. Existing passwords remain supported. Sessions have random bearer tokens; MongoDB stores token hashes and authenticated encryption for necessary server background dispatch. Admin absolute expiry is 12 hours, idle expiry 1 hour; customer absolute expiry 7 days, idle expiry 24 hours. Logout, password reset, blocking and privilege elevation revoke relevant sessions. Browser bearer storage remains localStorage, so CSP and XSS prevention remain important. User reports MFA enabled on Google, Cloudflare, Atlas and Squarespace; this was not independently inspected.

Atlas application identity is restricted to `readWrite@khalil`; do not grant Atlas administration to the application. Allowed IPs at hardening completion: OVH `148.113.249.11/32` and the operator workstation `173.206.122.228/32`. Review/remove the workstation address when it is no longer needed. Old Render CIDRs were removed.

## Backup and recovery

- Root `khalil-backup.timer`: daily 03:00 America/New_York, persistent, randomized delay. Script `/srv/rh/khalil-security/bin/backup.sh`.
- Output `/srv/rh/khalil-security/backups/*.cms` plus SHA-256 manifests; seven-day server retention.
- Typed EJSON export includes every collection and index definitions. It is a logical export, not a transactionally consistent point-in-time snapshot. Encrypted bundle also contains private environment, connector token, component configurations, backend source snapshot and OBS container inspection. Large media/recordings and independent provider account state are not mirrored by this backup.
- Workstation user `khalil-backup-pull.timer` copies encrypted bundles daily 03:30 and after startup; depends on this workstation being awake and online.
- Private decryption key is only at `/home/rudy/.local/share/khalil-recovery/backup-private.pem`, mode 0600. Keep a separate secure offline copy. Losing it makes these backups unrecoverable; exposing it compromises their contents.
- Check `systemctl status khalil-backup.timer`, `journalctl -u khalil-backup.service`, and local `systemctl --user status khalil-backup-pull.timer`. Never paste decrypted contents into support messages.
- Recovery tool `scripts/security-backup-restore.js` requires an explicit separate `KHALIL_RESTORE_URI`, a target database beginning `khalil_restore_`, and an empty destination. Use a separate restore credential authorized for that target; the production app identity cannot access it. Run an isolated restore drill before treating recovery as proven. No production restore or isolated database restore drill was performed during this hardening.

## Monitoring and maintenance

Root `khalil-monitor.timer` runs every five minutes and checks public website, API database readiness, stem health, connector readiness, free disk (<2 GiB) and backup freshness (>30h). Failures appear in systemd journal. External alert delivery is not configured; an operator must review failures until an alert destination is connected.

At completion the 38 GB root disk had about 3.9 GB free (90% used). Do not accumulate build archives on RAM-backed `/tmp`; use `/srv/rh/khalil-security`. Do not globally prune shared images, volumes or databases. A staged B2 recording is about 912 MB; preserve it until an authorized recording workflow confirms finalization/deletion. Review disk capacity before large uploads/recordings or additional deployments.

Four app containers have read-only roots, unprivileged users, no capabilities, no-new-privileges, bounded memory/CPU/PIDs and rotated logs. Network listeners are loopback-only; Cloudflare connector uses host networking and a loopback-only metrics listener. OBS services and the shared VPS remain separate residual exposure and capacity concerns.

Before a later release, review the diff and explicitly authorize functional/regression testing, especially authentication/password reset, bookings, recording storage, uploads, email and stem processing. This hardening used builds, syntax/dependency/configuration inspection and read-only health checks; no test suite or real customer transaction was run. Frontend CSP retains `unsafe-eval` for existing ONNX functionality. Node production dependency audit reports zero known advisories at the recorded time; this is not an OS/Python/Torch or penetration-test result.

## Automatic disk cleanup

Root `khalil-cleanup.timer` runs daily around 04:30 America/New_York, with up to ten minutes of jitter and catch-up after downtime. Its service runs `/srv/rh/khalil-security/bin/cleanup.py --apply`.

The cleaner removes unused Docker images older than 30 days, retaining images used by any running or stopped container, images named in available container Compose configurations, and the two newest images in each service family. Docker removal is never forced and container references are checked again before removal. It also removes unused build cache older than 14 days while retaining a 256 MB cache budget, and rotates/vacuums system journals to 14 days / 200 MB. Cleanup skips if a running container reports unhealthy. An exclusive lock prevents overlapping cleaner runs.

It does not remove project files, backups, recordings, databases, Docker volumes, stopped containers or application runtime directories. These need separate retention and recovery decisions. For a preview run `sudo python3 /srv/rh/khalil-security/bin/cleanup.py`; review service results with `journalctl -u khalil-cleanup.service`. Disable scheduling with `systemctl disable --now khalil-cleanup.timer`.

On 2026-11-08, old deployment/backup files were copied to the operator workstation under `/home/rudy/Documents/khalil/ovh-cleanup-20261108/` for verification before server removal. This is separate from the encrypted daily production backup process.

## Recording storage

LiveKit staging now uses OVH Garage. Preserve the storage volume, HTTPS bucket route and API hostname override. See [recording storage operations](../recording-storage/README.md) for capacity, cleanup, recovery and the remaining LiveKit egress quota blocker.
