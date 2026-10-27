# Google sign-in — 2026-10-27

Owner: Khalil Nahhat, Google Cloud project DJKN (`djkn-504300`).
Website: https://echo-khalil.onrender.com
API: https://echo-khalil-api.onrender.com/api
The earlier khalil.mctoshs.ca and djkhalilnahhat.onrender.com website addresses are retired.

Google Web client: `1078181832657-ljs7329qke2u2b46g69pprb2osep4tb6.apps.googleusercontent.com`.
Set `GOOGLE_CLIENT_ID` on the API, then deploy. No Google client secret is used by this integration.

The official Google Identity Services button receives a nonce-bound ID token, which the API verifies using Google's library (signature, audience, issuer and expiry). Challenges expire after five minutes and are single use. JSON requests from unapproved browser origins are rejected; login attempts are throttled.

Accounts are identified by Google's stable subject. A unique existing Gmail/Workspace client can retain its existing Echo account identity. Ambiguous emails, other Google links and administrator accounts require the existing password flow. Non-Google-hosted email addresses never auto-link by email alone. New Google accounts have no usable local password; the existing password-reset flow can add one. Phone and event details are completed in the order form. Login stores an ordinary Echo session and returns clients to their pending order.

Only basic Google identity is requested; Gmail messages, contacts and Drive are not requested. Google Cloud still displays Testing because publishing requires additional branding information. Basic identity scopes are exempt from the testing allowlist restriction according to https://developers.google.com/identity/protocols/oauth2/production-readiness/overview . Actual interactive account-chooser login must still be tested; do not claim an end-to-end login based only on unit tests.
