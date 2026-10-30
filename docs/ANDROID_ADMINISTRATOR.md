# Echo DJ Android Administrator

## Architecture and audit

The existing app at `/home/rudy/projects/echo-dj/android` is native Kotlin with Android views, AGP built-in Kotlin, lifecycle coroutines, LiveKit studio and HttpsURLConnection. Application ID remains `ca.echo.dj`; version is 0.3.2 (12). MainActivity retains its manual modules and adds the administrator entry. EchoStyle supplies the existing design. SessionStore retains AndroidKeyStore AES/GCM session storage. BroadcastService remains the foreground broadcast implementation; dictation refuses to take its microphone.

One server engine serves the web dashboard and Android. Android never receives an OpenAI key or executes administrative jobs. Existing username/role checks, ownership, task leases, exact approval digests, business handlers, readback verification and audit logs remain authoritative. Typed and dictated text use the same endpoint. Push-to-talk uses the Android recognition service, preferring on-device recognition where available. Otherwise recognition may use the user's configured platform provider; no continuous recording or background microphone is introduced. Dictation fills an editable composer and never approves or submits automatically.

## Client features

- Encrypted pending instruction and stable request UUID survive restart; duplicate submission reuses the server task.
- Persistent server task/conversation history, current status, verified tool actions, error details and audits. Workspace loads the latest 100 tasks; the UI initially shows 10.
- Exact before/proposed-value dialogs and authenticated digest approvals, safe retry, cancellation and global emergency stop.
- Lifecycle polling/reconnection; server tasks run independently. Network failures preserve drafts.
- FCM generic task completion, failure and approval notifications, session-bound registration and deep links. Tapping reloads the owned task after current administrator authentication. No approval action is available directly in notifications.
- Manual controls work without AI provider credentials. AI commands need the existing server OpenAI configuration.

## APIs reused

`GET /api/admin/ai-administrator`, `POST /tasks`, `GET /tasks/:id`, `POST /tasks/:id/approve`, `POST /tasks/:id/cancel`, `POST /tasks/:id/retry`, `PUT /control`. Only device registration is new: `PUT /devices`, `DELETE /devices/:installationId` under the same authenticated base. `X-Echo-Client: android` labels history; it does not grant permission.

## Firebase

Project `echo-dj` was created under khalilnahhatdj@gmail.com on the Spark no-cost plan. Billing remains disabled. Existing Android package `ca.echo.dj` was registered. `android/app/google-services.json` contains public application configuration only. Gradle reads it into FirebaseOptions; a Google services plugin is not required for this explicit initialization. Public Gradle property overrides are `ECHO_FIREBASE_APP_ID`, `ECHO_FIREBASE_API_KEY`, `ECHO_FIREBASE_PROJECT_ID`, `ECHO_FIREBASE_SENDER_ID`. Analytics and messaging auto-init are disabled until the signed-in administrator enables task notifications.

Server configuration: `FCM_PROJECT_ID=echo-dj` plus either private `FCM_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS` pointing to a protected server file. Never put a service-account private key in Android, Git, task text or frontend environment variables. The approved dedicated push sender holds only `roles/firebasecloudmessaging.admin`. FCM HTTP v1 is enabled. Its private key is stored outside the repository in a mode-0600 file and referenced by the local backend environment. A live validation-only HTTP v1 request returned 200; no push was sent. Push registration rechecks the current administrator and stores a session hash. The sender rechecks current administrator/session authority for each delivery. FCM is at least once; durable receipts and stable notification IDs prevent repeated UI notifications from executing actions. No push payload contains command text, customer information, raw error reports or approval digests.

Completed report tasks use the same notification path. There is no implemented scheduled-report scheduler in the current engine; report scheduling remains unsupported, not claimed live.

## Worker deployment (not deployed)

Current `render.yaml` is a free web service, so it cannot establish continuous execution. `deploy/render-ai-worker.yaml` is an optional, unapplied paid worker template. No plan purchase or production service creation occurred. Review all existing API environment requirements before applying it: same MongoDB replica set, admin/session records, OpenAI configuration, persistent media storage and business-service credentials. Add any required existing API secrets through a private environment group. Cloudinary is the current Render media provider. Local storage deployments must mount the same durable media volume in API and worker.

Start the identical backend image with `node scripts/ai-administrator-worker.js` under an existing always-on host supervisor (Docker restart policy or systemd), or provision an always-on Render worker separately after approval. It needs outbound TLS, no public listening port. Only after its health/logs and task takeover are verified, set `ECHO_ADMIN_WORKER_MODE=external` on the web API. The shared MongoDB worker lease prevents concurrent execution. Keep existing image/environment and return the API to its previous worker mode for rollback; do not delete task or audit collections.

Android 0.3.1 uses the current application API, `https://echo-khalil-api.onrender.com/api`, and website `https://echo-khalil.onrender.com`. The old `khalil-api.mctoshs.ca` hostname was repurposed for the token-protected stem worker; it returns a plain-text 401 for login and must not be used as the app API or weakened to accept app sessions. Current deployment documentation, live health (200), JSON login errors and authenticated guards on native admin routes were checked before switching. Public Gradle overrides are `ECHO_API_BASE_URL` and `ECHO_WEBSITE_BASE_URL`. A new APK alone does not deploy the server.

## Migration and retained data

The former bot transport, webhook, account linking, link models, related environment examples, UI controls and documentation were removed. No bot dependency existed in package manifests. Historical task source values, approvals, tasks, audits and dormant old collections are preserved; no database migration deletes them. Negative HTTP tests assert retired routes return 404. Deployment must replace old running images and remove any old host environment entries; source removal alone cannot prove a remote older deployment has changed.

## Validation

See `artifacts/android-administrator/validation.json` for exact automated results and remaining device/deployment checks. Android unit tests and both app/instrumentation APK compilation run locally. Instrumentation source covers the signed-out guard and encrypted draft persistence. Backend integration exercises real business handlers, Android-labeled task submission/idempotency, customer denial, exact approvals, durable push publication/deduplication and revoked sessions. FCM delivery uses an injected transport in deterministic tests; this is not evidence of physical delivery.

The Samsung SM_G781W was updated in place to 0.3.1 without clearing app data. Five new instrumentation checks passed on 0.3.0; the 0.3.1 signed-in rerun passed four and skipped the signed-out guard to preserve the current session: email/password form, signed-out guard, encrypted draft persistence, real client API routing/payloads through an injected HTTPS transport, and normal customer rejection. Five JVM tests and Android lint pass. The user confirmed real email/password login and dashboard access on 0.3.1. The existing physical navigation regression passed across all 13 manual modules against Render. These checks do not establish production AI execution. Microphone/recognizer behavior, real AI task/approval execution, push delivery/deep links while locked and app restart/reconnection during backend execution remain unverified. No claim of 24/7 hosting, production deployment or 100% administrative integration is made.

## Notification sign-in correction — 0.3.2

A read-only check on the connected phone found that its saved session was rejected by `/auth/me` with HTTP 401. The current account implementation stores one session token per account; another sign-in can invalidate the phone session. The notification action now verifies the current session directly instead of rejecting solely from the activity's cached authorization flag. An expired session shows a Sign in again button opening the existing email/password form. Missing server routes, unavailable service and missing server FCM configuration have distinct messages; registration does not claim notifications are enabled without provider configuration. This does not weaken backend authorization or migrate account sessions.

## Notification registration recovery — 0.3.3

After reauthentication, the phone returned HTTP 200 for account, overview and AI workspace endpoints. Notification registration separately returned 409 because its Firebase token was already associated with another installation ID. The app now serializes installation-ID creation and replaces a conflicting phone token once, while retaining backend ownership checks. A live device registration test then returned 200. With explicit user approval, the existing messaging-only Firebase sender key was saved in the API service's private Render environment and the API successfully redeployed. This does not provision always-on hosting.

Live follow-up: device registration returned 200 with `providerConfigured=true`. A bounded read-only report task generated a FAILED task notification that was received and posted on the physical Samsung. The report itself failed with “The model returned invalid tool arguments.” Notification delivery is verified; successful AI report execution is not. No business data was modified by that validation task. Its task/audit history is retained.

## Conversation continuity

Previously the task list persisted history but each new task sent only its current command to the model. The backend now reconstructs a bounded conversation snapshot at first execution, so an earlier queued task can finish before its follow-up receives context. It reads only the same administrator owner and session ID, considers the last 12 task records within a 12,000-character content budget, and records that context was initialized. The current command remains last. Prior requests, responses, errors and verified results can resolve references; raw model tool calls and approval grants are not replayed. Current state and fresh approval remain required for changes. This is recent conversation context, not unlimited permanent model memory.

Android retains the selected conversation ID with its encrypted draft and across activity recreation. New conversation starts a separate ID without deleting old tasks. Continue this conversation on a selected historical task targets its original thread. The existing default Android thread can reuse prior history after the backend change is deployed; separate web and Android threads do not silently mix.

Chat history APIs: `GET /api/admin/ai-administrator/conversations` returns owned chat summaries; `GET /api/admin/ai-administrator/conversations/:sessionId/messages` returns chronological user/reply task pairs, 30 per page. Use returned `nextBefore` as `?before=` to load earlier messages. Both use existing administrator authentication and owner filters. Task details, approvals, cancellation and retries keep their existing endpoints. Context compression happens locally on the backend without an extra model request; full task history remains persisted.
