# Free domain email activation — pending DNS

## Completed

- Cloudflare Free account `ffd971b6560321535003e37dce58dac6`, zone `d5e6c8f3b10e30580e7a822668b83397`.
- Squarespace saved `dalary.ns.cloudflare.com` and `jaime.ns.cloudflare.com` on Nov 7, 2026, at 4:07 PM Eastern. Owner approved disabling Squarespace DNSSEC for migration and restoring it through Cloudflare.
- Render apex A `216.24.57.1`, www CNAME `echo-khalil.onrender.com` and other imported records preserved, DNS only.
- Brevo ownership TXT and both DKIM CNAME records saved in Cloudflare. Existing strict DMARC preserved.
- Worker `echo-bookings-mail` deployed from `deploy/email-worker/worker.mjs`. Owner saved its Production signing secret. Matching value stored privately in Render.
- API commit `7113f14` deployed. Environment deployment `dep-dbnpgjbm8hqs73crrb10` is live. Frontend `39995aa` published; Email setup points to Cloudflare.
- Brevo bookings and noreply senders registered, currently Not verified. The live key has restricted SMTP permissions: account/sender metadata returns permission_denied, which does not establish an invalid sending credential.

## Blocker and remaining work

Cloudflare still reports nameserver propagation pending. The .ca authoritative server still returned Squarespace nameservers and old DS key tag 53147 during this session, despite the registrar showing the new settings. Do not publish a replacement DS prematurely.

1. Wait for registry delegation to publish Cloudflare nameservers and remove the previous DS. Confirm website resolution still points to Render.
2. Finish Cloudflare Email Routing onboarding with its exact MX/SPF values. Keep one SPF record. Route only bookings to this Worker; reject noreply and unknown addresses.
3. Cloudflare DNSSEC is enabled on its side, pending registrar delegation. After the previous registry delegation is gone, add this DS at Squarespace and confirm DNSSEC validation:
   - Key tag `2371`, algorithm `13`, digest type `2` (SHA-256).
   - Digest `3DB0924EF61F20D309A329FB404242D117EB72DC7989CA8AE13CBC436E0BBF8D`.
4. Finish Brevo domain authentication and confirm both senders verified. Do not weaken DMARC to match the example policy.
5. Confirm actual incoming persistence and outgoing delivery before retiring Gmail contact links. Ask for authorization for any dedicated send/receive test before running it.
6. Activate receiving/sending flags and final cutover only as setup is confirmed, following `docs/DOMAIN-EMAIL.md`.

Email is not live yet. Contact and automatic notification cutover remain inactive. Google login and Gmail remain intact. No paid plan was purchased. No real end-to-end delivery success is claimed.
