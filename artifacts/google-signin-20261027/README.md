# Echo Google sign-in — 2026-10-27

Current website: https://echo-khalil.onrender.com/login
API: https://echo-khalil-api.onrender.com/api
Google Cloud owner account: Khalil Nahhat. Project: DJKN (`djkn-504300`).
Client ID: `1078181832657-ljs7329qke2u2b46g69pprb2osep4tb6.apps.googleusercontent.com`.
Authorized JavaScript origins were saved and reloaded: current Render frontend, `http://localhost:5176`, and `http://localhost`. Both earlier website domains were removed from the client/branding configuration. No Google client secret is used or stored by this integration.

Render API environment GOOGLE_CLIENT_ID was added using Save only; the following automatic code deployment activated it. Backend commits: `a98b15d` (Google authentication) and `fbc15a4` (per-client throttling behind Render proxy). Frontend commit: `c116214` (Google button, authenticated order flow and current Render URLs). Releases were prepared in `/tmp/echo-google-back-release` and `/tmp/echo-google-front-release` from the deployed Git HEADs. Unrelated existing working-tree edits were excluded and preserved in the original checkouts. Their local Git branches were not reset or fast-forwarded over those edits.

Verification:
- 53 focused backend checks including 18 Google login checks; 9 frontend order/draft checks pass. The original backend suite passed 52 checks before the additional per-client throttle regression was added; all 18 Google checks pass after that change.
- Production frontend build and backend JavaScript syntax check pass.
- Live API reports configured true and the expected public client ID. Unauthenticated Google POST from the correct Render origin returns 401 and its CORS header; an unapproved origin returns 403 without an allow-origin header.
- Deployed login displays the official Continue with Google button. Clicking it opens Google's Choose an account page for echo-khalil.onrender.com with only openid/email/profile scopes. No account was selected and no real Google client account was created or linked by this check.
- A signed-out visit to /#how-to-book displays only the sign-in requirement in the order panel.
- Screenshot: live-login.png.

Google Cloud still shows Testing and disables Publish app pending further Branding configuration. Basic identity-only sign-in is exempt from the testing allowlist restriction according to Google's official app-state documentation. No public verification or completed interactive client login is claimed. The Google account chooser accepted the request; completion still requires a client to choose and approve their account.

Existing-password sign-in remains available. Administrator accounts continue using the password flow. Existing unique Google-hosted client emails retain the same account owner; duplicates or mismatched identity links fail closed.

Final Render verification: deployment `dep-dbgfa3ks728c73fekt8g` for backend `fbc15a4` reports Live. An invalid ID token with a fresh real challenge is rejected with HTTP 401 and a generic verification error. API health remains HTTP 200.
