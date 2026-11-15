# Instagram card on About

The Social media → Instagram admin tab (`/admin/echo?tab=instagram`) accepts a
long-lived Instagram Login user access token generated in Meta's app dashboard
for a Business or Creator account with `instagram_business_basic` permission.
The site never asks for an Instagram password.

1. Deploy the frontend and backend changes together.
2. Set `ECHO_INSTAGRAM_ENCRYPTION_KEY` to 64 random hexadecimal characters, or
   use the backend's existing `SESSION_ENCRYPTION_KEY`. Keep the key stable
   across restarts and API instances. Changing the key requires reconnecting.
3. In your Meta app, open Instagram → API setup with Instagram business login.
   Add the account and generate its long-lived token. Paste it into the tab and
   choose Connect Instagram. Tokens from Meta's dashboard are normally valid
   for 60 days; a normal short-lived login token is not suitable for this setup.
4. The connection is verified against `graph.instagram.com/v27.0/me` before
   saving. Only successful responses containing the username and all three
   counts are published. An invalid replacement leaves the existing connection
   intact. The bio and website are editorial fields; the API supplies the name,
   photo, post count, follower count and following count.

The API stores tokens using AES-256-GCM with a dedicated derived key and never
returns them to the browser. Admin endpoints use the existing admin middleware.
Disconnect clears the token and profile and hides the public card. Turning off
the visibility switch keeps the private connection but hides the card.

Public visits refresh the saved profile at most every 15 minutes and coalesce
simultaneous fetches within each API process. Open About pages fetch every 15
minutes. This is on-demand refresh, not a background cron job. Failed updates
retain the last successful data, label it with its sync time and retry after a
minute. Admins can explicitly refresh. Long-lived tokens are refreshed on an
eligible visit after seven days; revoked or expired access must be reconnected.
No data is invented for an unconnected account: the placeholder card has dashes
for counts and links to the existing site Instagram account.

Follow and Message links open Instagram; the card does not follow accounts or
send messages on the visitor's behalf.

Reference: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started

Validation: `node --test src/instagram-profile.test.js`.
