# Notifications → Emails

Open `/admin/echo?tab=notifications` from **Website → Notifications → Emails** of the admin dashboard. The editor uses the existing Brevo sender and server credentials.

Choose one of the 15 live stream, account, booking, quote, or meeting emails. Enable or disable that event, edit its subject and plain-text message, and insert supported `{{variables}}` using the Insert detail menu. Required variables keep account links and essential event details in the message. **Preview** substitutes sample details without saving or sending. **Save email** applies that rule to future sends. Switching events keeps unsaved drafts during the visit; **Discard** restores the last saved rule.

Meeting reminders default to 24 hours before the meeting; quote expiry reminders default to 48 hours before expiry. Each can be set from 0.25 to 720 hours. The existing reminder jobs check every 10 minutes and retain delivered-reminder timestamps. Changing a lead time does not resend a reminder already delivered. Date details use Toronto time.

Existing rich emails remain in use until their rule is saved. Saved messages are escaped and formatted for email, retaining the existing sender, recipient, reply-to, and Brevo tags. Provider secrets stay on the server. Concurrent saves use revision checks and return HTTP 409 instead of overwriting a newer edit.

Admin-only routes:

- `GET /api/admin/notifications/emails`
- `PUT /api/admin/notifications/emails/:id`
- `POST /api/admin/notifications/emails/:id/preview`

Rules are stored in MongoDB as `NotificationEmailRule` documents. Preview never calls Brevo or writes a rule. No bulk-mail or test-send endpoint is provided.

Choose an optional photo from the existing Gallery in the message editor. Each email stores its own selection; Change photo and Remove photo update only the current draft. Save email persists it. The preview and sent HTML place the photo on the right of the message; plain-text email remains readable without it.

**Live started** is enabled by default and announces each new broadcast to all verified, unblocked members who existed when it started. It includes the live title, selected live goal, and public watch link. These three details are required placeholders when customizing the message. OBS preparation does not trigger mail: its published media must become live. Browser go-live and external stream starts also trigger the announcement.

MongoDB LiveEmailCampaign and LiveEmailDelivery documents preserve one announcement per broadcast and member across reconnects, repeated polls, multiple workers and restarts. The queue checks every 15 seconds, sends up to 20 recipients per pass, and rechecks verification/block status and that the same broadcast is still live before sending. Disabled rules skip pending deliveries. Failed or interrupted in-flight attempts are retained for review and are not automatically retried, avoiding duplicates after uncertain provider responses. Brevo credentials and sender must be configured; missing configuration leaves queued mail pending while the broadcast remains live. Existing broadcasts are not announced simply by deploying this feature.
