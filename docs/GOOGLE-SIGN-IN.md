# Google sign-in — 2026-10-27

Owner: Khalil Nahhat, Google Cloud project DJKN (`djkn-504300`).
Website: https://echo-khalil.onrender.com
API: https://echo-khalil-api.onrender.com/api

Google Web client: `1078181832657-ljs7329qke2u2b46g69pprb2osep4tb6.apps.googleusercontent.com`.
Set `GOOGLE_CLIENT_ID` on the API, then deploy. No Google client secret is used by this integration.

The official Google Identity Services button receives a nonce-bound ID token, which the API verifies using Google's library (signature, audience, issuer and expiry). Challenges expire after five minutes and are single use. JSON requests from unapproved browser origins are rejected; login attempts are throttled.

Accounts are identified by Google's stable subject. A unique existing Gmail/Workspace client can retain its existing Echo account identity. The existing reserved administrator account may also link and sign in with the verified Google address `khalilnahhatdj@gmail.com`; its stored email must match. This retains its account ID, password and permissions. Other administrator accounts, ambiguous emails and conflicting Google links require the existing email/password flow. An email match never grants administrator permissions. Non-Google-hosted email addresses never auto-link by email alone. New Google accounts have no usable local password; the existing password-reset flow can add one. Phone and event details are completed in the order form. Login stores an ordinary Echo session and returns clients to their pending order.

Only basic Google identity is requested; Gmail messages, contacts and Drive are not requested. Google Cloud still displays Testing because publishing requires additional branding information. Basic identity scopes are exempt from the testing allowlist restriction according to https://developers.google.com/identity/protocols/oauth2/production-readiness/overview . The Google account chooser is verified. Completing a real client sign-in still needs testing.

Deployment verified on 2026-10-27: backend fbc15a4 and frontend c116214 are live on the current Render services. The official button and Google account chooser are verified; no real account was selected during QA. Detailed evidence is in artifacts/google-signin-20261027.
