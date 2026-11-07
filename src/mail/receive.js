const crypto = require("node:crypto");
const { simpleParser } = require("mailparser");
const { BOOKINGS, MAX_EMAIL_BYTES } = require("./constants");
const { fail } = require("./validation");
const { textFromHtml, cleanHeader } = require("./text");

function createReceiver({
  env,
  store,
  clock = Date.now,
  parser = simpleParser,
}) {
  return async function receive(raw, headers) {
    if (!Buffer.isBuffer(raw) || !raw.length || raw.length > MAX_EMAIL_BYTES)
      throw fail(413, "Message must be smaller than 5 MB.");
    if (!/^[a-f0-9]{64}$/i.test(env.MAIL_INGRESS_SECRET || ""))
      throw fail(503, "Mail receiving is not configured.");
    const timestamp = String(headers["x-echo-mail-timestamp"] || ""),
      to = String(headers["x-echo-mail-to"] || "").toLowerCase(),
      from = String(headers["x-echo-mail-from"] || "");
    if (
      !/^\d{13}$/.test(timestamp) ||
      Math.abs(clock() - Number(timestamp)) > 300000 ||
      to !== BOOKINGS ||
      /[\r\n]/.test(from)
    )
      throw fail(401, "Invalid mail delivery.");
    const digest = crypto.createHash("sha256").update(raw).digest("hex");
    const expected = crypto
      .createHmac("sha256", Buffer.from(env.MAIL_INGRESS_SECRET, "hex"))
      .update(`${timestamp}\n${to}\n${from}\n${digest}`)
      .digest();
    const signature = String(headers["x-echo-mail-signature"] || "");
    if (
      !/^[a-f0-9]{64}$/i.test(signature) ||
      !crypto.timingSafeEqual(expected, Buffer.from(signature, "hex"))
    )
      throw fail(401, "Invalid mail delivery.");
    const parsed = await parser(raw, {
      skipImageLinks: true,
      skipTextToHtml: true,
      skipHtmlToText: true,
    });
    const headerFrom = parsed.from?.value?.[0];
    const text = String(parsed.text || textFromHtml(parsed.html) || "").slice(
      0,
      1000000,
    );
    const attachments = (parsed.attachments || [])
      .filter((file) => file.contentDisposition !== "inline")
      .map((file) => ({
        name: cleanHeader(file.filename || "attachment"),
        data: Buffer.from(file.content),
        size: file.size || file.content.length,
      }));
    return store.receive({
      mailbox: BOOKINGS,
      folder: "1",
      state: "received",
      deliveryKey: crypto
        .createHash("sha256")
        .update(`${BOOKINGS}\n${from}\n${digest}`)
        .digest("hex"),
      from: headerFrom?.address || from,
      sender: headerFrom?.name || headerFrom?.address || from,
      to: (parsed.to?.value || [{ address: BOOKINGS }]).map(
        (item) => item.address,
      ),
      cc: (parsed.cc?.value || []).map((item) => item.address),
      replyTo:
        parsed.replyTo?.value?.[0]?.address || headerFrom?.address || from,
      subject: cleanHeader(parsed.subject).slice(0, 250),
      text,
      rfcMessageId: cleanHeader(parsed.messageId),
      references: cleanHeader(
        Array.isArray(parsed.references)
          ? parsed.references.join(" ")
          : parsed.references,
      ),
      attachments,
      bytes: raw.length,
      time: new Date(clock()),
    });
  };
}
module.exports = { createReceiver };
