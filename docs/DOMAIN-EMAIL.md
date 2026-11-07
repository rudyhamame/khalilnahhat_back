# Domain email activation

## Intended addresses

- `bookings@djkhalilnahhat.ca`: real Zoho mailbox, read and send through Business → Email (`/admin/echo?tab=email`).
- `noreply@djkhalilnahhat.ca`: Brevo sender for the application's automated notifications. Do not create an incoming noreply mailbox unless required by the provider. Customer quote Reply-To points to bookings after activation.

The Email tab lists provider folders and paginated messages, reads messages as safe text without executing HTML or loading tracking images, downloads real attachments (up to 25 MB), and sends or replies from bookings. Compose currently supports text messages; outgoing attachments and saved drafts remain available through Zoho webmail. Incoming mail remains stored at Zoho. Passwords and OAuth credentials never enter the frontend. All mailbox endpoints require the existing administrator session.

## Account and DNS

1. The owner completes the actual Zoho free account registration and accepts its terms. Free custom-domain hosting is only available in selected data centers; Canadian pricing may only display paid plans or trials. Confirm the resulting plan is permanently free before proceeding. Never enter false location details to obtain a plan.
2. Add `djkhalilnahhat.ca` to Zoho and verify the ownership TXT record in Squarespace. Create the exact bookings mailbox. Use the provider's MX and DKIM records for its actual data center, not copied records for another region.
3. Verify the domain and noreply sender in Brevo. Add the exact supplied DKIM and domain-verification TXT/CNAME records. Keep one combined SPF record covering the actual sending services, and check DMARC alignment. Squarespace's default `v=spf1 -all` blocks mail and must be replaced by the provider-authorized SPF value at activation; merge rather than adding a second SPF record. Preserve website A/CNAME records.
4. Do not redirect notifications or replace public contact links until both external inbound delivery and an outbound reply have been confirmed. Sender verification and actual inbox delivery are separate checks.

## Zoho API connection

Create a confidential OAuth client in the correct regional Zoho API Console for this application. The owner must approve mailbox access. Request only `ZohoMail.accounts.READ,ZohoMail.folders.READ,ZohoMail.messages.READ,ZohoMail.messages.CREATE` and offline access. Exchange the owner's authorization grant server-side for a refresh token; never send a secret in chat, source control or a VITE variable.

Store `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, and `ZOHO_REGION` in the API's Render environment. Region values supported: `us`, `eu`, `in`, `ca`. `/api/admin/mail/folders` verifies the connected account contains the confirmed bookings address, is enabled and has verified MX. It never selects another account as a fallback. Confirm that the actual free account permits these API scopes. If it does not, stop and choose another free receiving solution; do not silently upgrade.

The provider token is refreshed on the server with bounded requests and a shared in-flight refresh. Access tokens stay in memory and expire early. Send requests use a MongoDB unique `(owner, requestId)` record; duplicate submissions cannot send a second message. Ambiguous sends must be checked in Sent before retrying with a new request ID.

Official API references:

- https://www.zoho.com/mail/help/api/getting-started-with-api.html
- https://www.zoho.com/mail/help/api/get-all-users-accounts.html
- https://www.zoho.com/mail/help/api/get-all-folder-details.html
- https://www.zoho.com/mail/help/api/get-emails-list.html
- https://www.zoho.com/mail/help/api/get-email-content.html
- https://www.zoho.com/mail/help/api/post-send-an-email.html
- https://www.zoho.com/mail/help/api/post-reply-to-an-email.html

## Controlled cutover

After delivery checks pass, set these API Render values and deploy:

```dotenv
DOMAIN_EMAIL_ACTIVE=true
EMAIL_FROM_ADDRESS=noreply@djkhalilnahhat.ca
SERVICE_REQUEST_NOTIFICATION_EMAIL=bookings@djkhalilnahhat.ca
ADMIN_SERVICES_URL=https://djkhalilnahhat.ca/admin/services
CUSTOMER_SERVICES_URL=https://djkhalilnahhat.ca/dashboard/services
```

`DOMAIN_EMAIL_ACTIVE=true` makes automated sender identity and booking/meeting admin recipients use the exact domain addresses, even if older sender/notification environment values were left over. Brevo must be verified before enabling it.

Set frontend `VITE_PUBLIC_CONTACT_EMAIL=bookings@djkhalilnahhat.ca` and rebuild/deploy. It updates the artist contact badge, Contact page and LocalBusiness metadata together. Before cutover, the existing contact and notification routes remain usable. The Email tab shows connection status without inventing inbox messages or claiming that credential presence proves delivery.

Changing the existing administrator's Google/Gmail login identity is a separate account migration. Do not delete the Google account or invalidate its working sign-in during mailbox setup. The domain addresses do not import old Gmail history automatically.

## Verification

`node --test test/domain-mail.test.js test/notification-emails.test.js` exercises real Express routes with substituted provider/database implementations; no external email is sent. It covers admin admission, mailbox identity/MX verification, long provider IDs, safe message rendering, attachment selection, sender enforcement, shared token refresh, concurrent duplicates and uncertain sends. The frontend production build must pass. Real provider authorization, DNS and actual external send/receive must still be verified separately.
