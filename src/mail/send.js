const crypto = require("node:crypto");
const { isIP } = require("node:net");
const { BOOKINGS, FOLDERS } = require("./constants");
const { fail, draftSchema } = require("./validation");
const { cleanHeader, escapeHtml } = require("./text");

function createSender({ env, store, fetchImpl = fetch, clock = Date.now }) {
  return async function send(owner, value) {
    if (env.DOMAIN_MAIL_SENDING_ACTIVE !== "true" || !env.BREVO_API_KEY?.trim())
      throw fail(
        503,
        "The bookings sender has not been verified yet. Complete email setup before sending.",
        { sendState: "not_sent" },
      );
    const result = draftSchema.safeParse(value);
    if (!result.success)
      throw fail(400, "Enter valid recipients, a subject, and a message.");
    const { requestId, ...draft } = result.data;
    let original;
    if (draft.replyMessageId) {
      for (const folder of FOLDERS.map((folder) => folder.id)) {
        original = await store.get(folder, draft.replyMessageId);
        if (original) break;
      }
      if (!original)
        throw fail(404, "The message being replied to was not found.");
    }
    const hash = crypto
      .createHash("sha256")
      .update(JSON.stringify(draft))
      .digest("hex");
    const claim = await store.claim(owner, requestId, hash, {
      from: BOOKINGS,
      sender: "Echo Bookings",
      to: draft.to,
      cc: draft.cc,
      replyTo: BOOKINGS,
      subject: draft.subject,
      text: draft.text,
      time: new Date(clock()),
    });
    if (!claim.created) {
      if (claim.item.hash !== hash)
        throw fail(409, "This request already belongs to a different message.");
      if (claim.item.state === "sent")
        return { sent: true, messageId: String(claim.item._id) };
      if(claim.item.state==='failed')throw fail(409,'The previous send was rejected. Retry with a new send request.',{sendState:'not_sent'});
      throw fail(
        409,
        "This message was already submitted. Check Sent and Needs attention before sending another copy.",
        { sendState: "uncertain" },
      );
    }
    let providerAccepted=false;
    try {
      const headers = {
        idempotencyKey: requestId,
        ...(original?.rfcMessageId
          ? {
              "In-Reply-To": original.rfcMessageId,
              References: cleanHeader(
                `${original.references || ""} ${original.rfcMessageId}`,
              ),
            }
          : {}),
      };
      const response = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": env.BREVO_API_KEY,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          sender: { email: BOOKINGS, name: "Echo Bookings" },
          to: draft.to.map((email) => ({ email })),
          ...(draft.cc.length
            ? { cc: draft.cc.map((email) => ({ email })) }
            : {}),
          replyTo: { email: BOOKINGS },
          subject: draft.subject,
          textContent: draft.text,
          htmlContent: `<div style="white-space:pre-wrap">${escapeHtml(draft.text)}</div>`,
          headers,
          tags: ["bookings-mailbox"],
        }),
        signal: AbortSignal.timeout(20000),
        redirect: "error",
      });
      const payload = await response.json().catch(() => ({}));
      if(!response.ok&&response.status>=400&&response.status<500){
        const address=typeof payload.message==='string'?payload.message.match(/unrecogni[sz]ed IP address\s+([\da-fA-F:.]+)/i)?.[1]?.replace(/\.$/,''):null;
        if((response.status===401||response.status===403)&&address&&isIP(address)){
          throw fail(503,`Brevo blocked this server's IP address (${address}). Add it in Brevo under Security → Authorized IPs, then retry. No email was sent.`,{sendState:'not_sent'});
        }
        if(response.status===401||response.status===403){
          throw fail(503,'Brevo has not authorized this server to send email. Check the API key permissions and authorized IPs in Brevo, then retry. No email was sent.',{sendState:'not_sent'});
        }
        throw fail(response.status,'The email provider rejected this message. Check the recipients and sender configuration, then retry.',{sendState:'not_sent'});
      }
      if (!response.ok || !payload.messageId)
        throw fail(
          response.status === 429 ? 429 : 502,
          "The provider did not confirm sending. Check Sent and Needs attention before trying again.",
        );
      providerAccepted=true;
      await store.finish(owner, requestId, {
        state: "sent",
        folder: "2",
        providerMessageId: payload.messageId,
        rfcMessageId: cleanHeader(payload.messageId),
      });
      return { sent: true, messageId: String(claim.item._id) };
    } catch (error) {
      const notSent=!providerAccepted&&error.sendState==='not_sent';
      await store
        .finish(owner, requestId, { state: notSent?'failed':'uncertain', folder: "4" })
        .catch(() => {});
      throw fail(
        error.status || 502,
        error.status
          ? error.message
          : "Sending was not confirmed. Check Sent and Needs attention before trying again.",
        { sendState: notSent?'not_sent':'uncertain' },
      );
    }
  };
}
module.exports = { createSender };
