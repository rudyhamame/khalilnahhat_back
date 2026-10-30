# Admin Capability Coverage Report

Updated 2026-10-30. Scope: existing OpenAI Administrator, Web Admin Dashboard and existing Echo DJ Android app.

## Measured coverage

- **51 registered AI capabilities** have working adapters to real application handlers and integration checks against an isolated MongoDB replica set.
- **53 of 137 inventoried runtime administrative routes** are integrated; **84 are unsupported or denied**. Tool count and route count are different measures. This is not 100% administrative coverage.
- Full capability names, typed inputs, service routes and every unsupported route: [machine inventory](admin-route-inventory.json).
- Module-by-module operations and exclusions: [implementation coverage](AI_ADMINISTRATOR.md#coverage-summary).

## Operational status

| Capability group | Local implementation and verification | Production/mobile status |
| --- | --- | --- |
| Music Archive | Recording/content/vocabulary/collection CRUD adapters, publication approval, shared metadata inference, readback verification, duplicate search, player selection/order; tested real handlers | Source ready; AI transcription, audio analysis, permanent deletion, global collection ordering and version-history tools unsupported |
| Catalog, equipment, prices, website content, venue drafts | Listed typed adapters use shared services; revision/ownership and saves verified | Manual media uploads, generation jobs and other routes excluded by inventory |
| Customer and booking administration | Search, contact/notes, planning, quote proposals and existing selected actions verified | Payment execution, customer messages, quote publication, booking confirmation/cancellation unsupported |
| OpenAI reasoning and persistent task engine | Existing server engine, exact approvals, receipt verification, recovery, idempotency, cancellation and emergency stop retained; 30 integration tests pass | Always-on production worker not provisioned/deployed; free sleeping web hosting does not establish 24/7 operation |
| Native Android interaction | Existing Kotlin app extended with email/password sign-in, text/dictation composer, history, details, previews, approvals, cancellation, retry and emergency stop | APK built; physical validation recorded separately. Live workflow requires matching server deployment |
| Firebase messaging | Free Echo DJ project, existing Android package registration, dedicated messaging-only sender; local private credential; real HTTP v1 validation-only request returns 200 | No physical task notification delivery claimed until an authenticated device registers against the updated backend |
| Scheduled reports | Completed report tasks use the generic completion notification path | No report scheduler integration exists; scheduling unsupported |
| Former remote bot transport | Adapter, webhook/link routes, model declarations, UI/env documentation removed; retired endpoints return 404 in regression | Historical tasks, approvals and audits preserved. Old remote deployments must be replaced; no claim about undeployed images |

## Validation and blockers

Backend: 248 tests, 242 pass, 6 pre-existing failures reproduced previously on baseline. Administrator-specific integration: 30/30 pass. Frontend: 52/52 pass, production build passes. Android app/instrumentation builds and four JVM tests pass. Live Firebase credential check validates authorization without sending a notification. See [Android validation/deployment](ANDROID_ADMINISTRATOR.md) and [validation evidence](../artifacts/android-administrator/validation.json).

Remaining production blockers: deployment to the API host used by Android, configuring its private FCM credential, verifying an always-on worker, and physical authenticated task/approval/notification checks. No paid hosting, model billing configuration, production data purge or second AI engine was introduced.
