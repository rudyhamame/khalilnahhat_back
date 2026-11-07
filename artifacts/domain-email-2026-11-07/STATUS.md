# Domain email activation — November 7, 2026

## Activated and observed

- Cloudflare Free account `ffd971b6560321535003e37dce58dac6`, zone `d5e6c8f3b10e30580e7a822668b83397`. The .ca registry delegates to `dalary.ns.cloudflare.com` and `jaime.ns.cloudflare.com`. Render website records remain DNS-only.
- Cloudflare Email Routing is enabled. Exact `bookings@djkhalilnahhat.ca` routes to `echo-bookings-mail`; catch-all is disabled. The old deny-all SPF was replaced with the single required Cloudflare SPF record.
- Brevo authenticates the domain and both bookings/noreply senders. The Gmail sender is absent; only the two verified domain senders remain. Google login is preserved.
- Matching ingress secrets are stored privately in Render and the Worker. Temporary Desktop and /tmp secret copies were removed after provisioning.
- Initial receiving checks failed because the Worker runtime rejects `redirect:error` before HTTP dispatch. Fixed to `manual`, with non-success rejection and bounded private diagnostics. Active corrected Worker version observed `1ccc4055`.
- Authorized external check: Zoho's `Final receiving confirmation — Cloudflare fix` arrived in the admin Inbox at approximately 6:00 PM Eastern. Reply from the admin Email tab arrived in the Zoho mailbox as `Re: Final receiving confirmation — Cloudflare fix`, with the exact domain sender and reply text. Earlier rejected setup attempts produced explicit delivery-failure emails; no successful receipt was claimed for those attempts.
- Render cutover values: receiving/sending enabled, `DOMAIN_EMAIL_ACTIVE=true`, automated sender noreply, administrator notifications bookings, public contact bookings. Cutover deployments were started before the refactor.
- Squarespace accepted Cloudflare's DS record (2371 / algorithm13 / digest type2; digest `3DB0924EF61F20D309A329FB404242D117EB72DC7989CA8AE13CBC436E0BBF8D`). Registry publication and final validated DNSSEC status still need a final propagation check.

## Refactor

User requested full email UI/UX and backend refactor after activation, and specifically required `.ae-workspace` to fill the tab. Backend modules now separate routes, validation, mailbox service, storage/quota, MIME receiving, Brevo sending and safe rendering. Frontend modules separate API requests, mailbox state, retained drafts, folders, list, reader and composer. Added scoped search, read/unread, Archive, recoverable Trash/restore and storage display. Permanent removal requires a user action in Trash; no production message was permanently deleted during setup.

The focused 24 existing mail checks pass, including MIME safety, attachment byte boundaries, forced sender, admin access, HMAC verification and idempotency. Worker regression also asserts manual redirect mode. Frontend production build passed; final deployment/layout review follows. No paid plan was purchased.
