# Notifications → Emails

Open `/admin/echo?tab=emails` from the **Notifications** area of the admin dashboard. The editor uses the existing Brevo sender and server credentials.

Choose one of the 14 account, booking, quote, or meeting emails. Enable or disable that event, edit its subject and plain-text message, and insert supported `{{variables}}` using the detail buttons. Required variables keep account links and essential event details in the message. **Preview email** substitutes sample details without saving or sending. **Save email** applies that rule to future sends. Switching events keeps unsaved drafts during the visit; **Discard changes** restores the last saved rule.

Meeting reminders default to 24 hours before the meeting; quote expiry reminders default to 48 hours before expiry. Each can be set from 0.25 to 720 hours. The existing reminder jobs check every 10 minutes and retain delivered-reminder timestamps. Changing a lead time does not resend a reminder already delivered. Date details use Toronto time.

Existing rich emails remain in use until their rule is saved. Saved messages are escaped and formatted for email, retaining the existing sender, recipient, reply-to, and Brevo tags. Provider secrets stay on the server. Concurrent saves use revision checks and return HTTP 409 instead of overwriting a newer edit.

Admin-only routes:

- `GET /api/admin/notifications/emails`
- `PUT /api/admin/notifications/emails/:id`
- `POST /api/admin/notifications/emails/:id/preview`

Rules are stored in MongoDB as `NotificationEmailRule` documents. Preview never calls Brevo or writes a rule. No bulk-mail or test-send endpoint is provided.
