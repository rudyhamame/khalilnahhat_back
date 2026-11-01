# Echo Live studio refactor — local implementation

Browser studio retains the original charcoal/Echo theme, preview, source selector and stacked audience panels. The public Live surface keeps its existing design. No blue studio redesign is retained.

## Shared behavior

Browser camera, Android camera and OBS use one authoritative broadcast identity. Camera preparation reserves a room offline; readiness requires published media before the audience is admitted. Exact-room end requests cannot stop a replacement session. Failed media revocation retains the reservation for retry. Android observes remote stops and authentication expiry and releases capture.

Audience playback credentials, comments, song analysis/search and requests require authentication. Public status never includes a usable playback URL. LiveKit audience tokens subscribe only; relay access uses short-lived, room-bound capabilities. The relay controller must deploy the matching access helper. Existing public external-video configurations fail closed.

Requests are tied to the active session and signed-in identity. Approval atomically claims a request and uses a deterministic queue entry to avoid duplicate insertions. Interrupted reviews support bounded recovery. Comments support reversible hide/restore. The browser and native studio reject stale feeds/actions after session changes.

Echo AI Administrator exposes status, title/goal, OBS preparation/end/recording preference, camera end, audience reads, review/recovery and moderation through the same authenticated handlers. Writes retain approval, stale-state protection and independent verification. Android offers command drafts, approval explanations and allowlisted navigation; drafts do not execute automatically.

## Rollout and limits

Changes are local; no production deployment, broadcast, device installation or publication was performed. Coordinate backend, frontend and OBS relay updates, then install the updated Android client. Older Android clients do not send the readiness confirmation and cannot complete the new camera start lifecycle.

The existing account model still has one active session token: a new account login can invalidate the phone. Expiry is handled explicitly; independent simultaneous logins are not implemented. Physical camera/audio, real media delivery, network handover and push delivery require device acceptance. Android remains an administrator app; signed-in customers use the website.

## Validation

Browser: 60 tests pass, lint has no errors (existing warnings remain), production build passes. The restored desktop layout was visually checked; mobile overflow at 390px was checked. Screenshot uses isolated synthetic audience data, not a real broadcast.

Backend: 42 focused access, broadcast, audience and OBS tests pass, including isolated-Mongo integration exercising real authorization and AI approvals. Syntax and whitespace checks pass. The broader AI suite has two failing subtests that also fail against unchanged HEAD (language fixture and navigation fixture); it is not reported as passing.

Android: APK and instrumentation compilation pass; lint has 0 errors and 81 warnings. All 18 focused tests pass. Demo UI screenshots were visually inspected. Verified debug APK: `/home/rudy/projects/echo-dj/dist/Echo-DJ-0.4.1-debug.apk` (versionCode 15, 64,245,170 bytes; SHA-256 `dbb54b2c21e61a2d046ec026425af9baabf0feb082c59c55eecc30a35ece904c`). Signature and ZIP integrity pass. Further validation and handoff details are recorded in the Android repository README. The existing terminology checker reports browser/navigation label mismatches outside this Live refactor.
