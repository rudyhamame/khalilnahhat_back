# Domain email activation

## Addresses and delivery

- `bookings@djkhalilnahhat.ca`: send and receive in Business → Email (`/admin/echo?tab=email`).
- `noreply@djkhalilnahhat.ca`: Brevo sender for automated notifications. Incoming mail to this address is rejected.

Cloudflare Email Routing delivers bookings mail to `deploy/email-worker/worker.mjs`. The worker signs the exact MIME body and sends it to the Render API over HTTPS. The API checks the HMAC, timestamp and recipient before parsing, and acknowledges only after MongoDB commits the message. Messages and incoming attachments are stored in the application's existing MongoDB database. This is a custom inbox, not Cloudflare webmail or an IMAP service.

The admin tab lists Inbox, Sent, Archive, Needs attention and Trash with 50 messages per page, reads safe plain text without tracking images, downloads incoming attachments and sends/replies through Brevo. Compose retains a private draft in this browser tab for the signed-in administrator. Outgoing attachments are not implemented. All mailbox reading and sending endpoints require an administrator session. Provider credentials never enter the frontend.

Incoming messages are limited to 5 MiB and total new mailbox storage to 100 MiB. Sent drafts reserve quota before sending; permanently deleting a Trash message releases its reserved bytes. A failed or full receiver rejects delivery rather than claiming the message was saved. A sleeping Render instance or provider outage can therefore cause a delivery rejection; the sender must resend. This free setup has no managed mailbox availability guarantee. MongoDB storage and the providers' free quotas still apply. Do not activate a paid plan automatically.

## Cloudflare DNS and receiver

1. Keep the domain registered at Squarespace and the website hosted on Render. Import and preserve the existing website A/CNAME records with DNS-only proxy mode.
2. Change Squarespace nameservers to the exact pair assigned by Cloudflare. If the registrar requires disabling its existing DNSSEC setting, obtain action-time approval. Enable Cloudflare DNSSEC after activation and publish its assigned DS record at the registrar.
3. Deploy `deploy/email-worker/worker.mjs` as an Email Worker. Generate a random 32-byte hexadecimal `MAIL_INGRESS_SECRET`; store the same value as a Worker secret and a private Render API environment variable. Never commit or send it in chat.
4. Enable Email Routing, use its exact MX/SPF records, and route only `bookings@djkhalilnahhat.ca` to this Worker. Reject other addresses, including noreply; no catch-all forwarding.
5. Set `DOMAIN_MAIL_PROVIDER=cloudflare` and deploy the API. Set `DOMAIN_MAIL_RECEIVING_ACTIVE=true` after external delivery reaches the admin inbox. The flag is operator confirmation, not an automatic DNS check.

The public ingress is `POST /api/mail/inbound`, accepts only `message/rfc822` and requires a valid body-bound signature within five minutes. Duplicate deliveries are acknowledged without storing a second copy. MIME bodies do not get written to logs. The database requires transaction support, as provided by MongoDB Atlas.

## Brevo sending

Authenticate `djkhalilnahhat.ca` in Brevo using the exact verification and DKIM records shown for this account. Keep one SPF TXT record; merge authorized mechanisms rather than adding conflicting SPF records. Preserve DMARC and verify aligned DKIM. Register bookings and noreply as senders.

Use the existing server-only `BREVO_API_KEY`, or have the owner provision a replacement if invalid. Set `DOMAIN_MAIL_SENDING_ACTIVE=true` only when the bookings sender is verified. Outgoing messages always use bookings; automatic mail uses noreply after cutover. Requests have unique owner/request IDs. An ambiguous submission stays in Needs attention and cannot automatically send a duplicate. Check provider delivery logs before manually composing another copy.

## Controlled cutover

After an external message arrives in Inbox and its reply is actually delivered, set the API environment:

```dotenv
DOMAIN_MAIL_PROVIDER=cloudflare
DOMAIN_MAIL_RECEIVING_ACTIVE=true
DOMAIN_MAIL_SENDING_ACTIVE=true
DOMAIN_EMAIL_ACTIVE=true
EMAIL_FROM_ADDRESS=noreply@djkhalilnahhat.ca
SERVICE_REQUEST_NOTIFICATION_EMAIL=bookings@djkhalilnahhat.ca
ADMIN_SERVICES_URL=https://djkhalilnahhat.ca/admin/services
CUSTOMER_SERVICES_URL=https://djkhalilnahhat.ca/dashboard/services
```

Set frontend `VITE_PUBLIC_CONTACT_EMAIL=bookings@djkhalilnahhat.ca` and rebuild. This updates contact links and LocalBusiness metadata together. Keep the previous contact route until actual inbound and outbound delivery are confirmed. Flags and credentials alone do not prove delivery.

The existing administrator Google login remains unchanged. Do not delete the Google account. Old Gmail history is not imported automatically.

## Optional Zoho adapter

The original Zoho API adapter remains available with `DOMAIN_MAIL_PROVIDER=zoho`, `ZOHO_REGION`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` and `ZOHO_REFRESH_TOKEN`. Canadian custom-domain hosting required payment when checked, so it is not the chosen free setup. Do not enable a paid trial.

## Module boundaries

- `src/mail/routes.js`: admin admission, request schemas, private errors and raw ingress.
- `src/mail/service.js`: mailbox identity, capabilities and read/move/delete contracts.
- `src/mail/store.js`: fixed-mailbox queries, indexes, transactional quota and delivery idempotency.
- `src/mail/receive.js`: body-bound HMAC verification and safe MIME parsing.
- `src/mail/send.js`: validated bookings sender, reply threading and uncertain-send preservation.
- `src/mail/text.js`, `validation.js`, `constants.js`: shared rendering, limits and rules.
- `src/mail/zoho.js`: optional legacy adapter; it is not used by the active Cloudflare setup.

Frontend `src/echo/mail/` separates HTTP requests, mailbox state, draft state, folders, list, reader and composer. The Email tab fills the dashboard content area; its list and reader scroll independently. Folder search is server-side and escapes regular-expression characters. A message move uses the current folder as a concurrency guard. Restore to Sent or Needs attention is only allowed from Trash to its recorded previous folder. Permanent removal is restricted to Trash.

Cloudflare's Worker runtime does not accept `redirect: "error"`; the receiver uses `redirect: "manual"` and rejects every non-success response. Redirects are never followed with the signing headers or MIME body. Failure diagnostics contain only event names, status codes and exception names.
