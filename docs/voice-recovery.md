# Voice connection recovery

An Alibaba upstream close with code 1006 is an abnormal transport disconnect;
the close code alone does not establish a provider, account or quota root cause.
Use `[alibaba-voice]` server records for closing side, readiness and duration.
Never log audio, conversation text or API keys when diagnosing this path.

The booking admission limiter previously consumed session allowance before
rejecting an existing call, and retained it after a failed provider start. The
updated handler checks active-call conflicts first and refunds failed starts,
unattached Alibaba socket tickets and abnormal provider disconnects. Ordinary
completed calls still consume the configured session allowance. A separate
20-attempt per-account / ten-minute limiter bounds reconnection attempts. Rate
responses include `Retry-After`, a machine-readable code and retry seconds.

The Alibaba bridge sends WebSocket pings to both sides every twenty seconds,
checks upstream pong replies, enforces a fifteen-second handshake timeout and
a twenty-second session-setup timeout, and clears timers on every exit. This
helps detect dead connections and keeps idle transport paths active; it cannot
guarantee that a remote provider or network never disconnects. Reconnection
remains an explicit user action and starts a new session with the saved draft
and available conversation context. It does not submit a booking.

Validation: `node --test test/voice-recovery.test.js` covers provider-start
failure/refunds, bounded attempts, active-call conflicts, normal limits with
retry timing, four forced upstream 1006 disconnect/reconnect cycles, setup
timeouts and keepalive cleanup. The admission regressions fail against the
unchanged baseline. The older opening-greeting translator test fails on both
baseline and current source because it expects audio to be committed before
configuration acknowledgement; this change does not alter that translator.

These backend changes require deployment. No real customer call or live
Alibaba account validation was performed as part of these local tests.

## Live eligibility diagnosis (2026-11-03)

Render application logs showed `AccessDenied.Unpurchased` at 01:35:32 Eastern,
followed by upstream close 1006, `ready:false`, after 2,972 ms. The selected model
was `qwen3.8-omni-flash-realtime`. This establishes provider eligibility/service
activation as the reported rejection, rather than proving a transport outage.
Alibaba's error-code documentation describes this code as service activation or
model eligibility. Verify the account/workspace associated with the deployed API
key and the chosen region. Enabling a service or accepting provider terms must be
completed by the account owner. No activation, purchase, API-key change or provider
switch was performed here.

The bridge now preserves the provider error code and actionable explanation and
closes the rejected session immediately. A later socket close cannot overwrite it
with the generic 1006 notice. This additional change is local until deployed.
