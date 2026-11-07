const express = require("express");
const { z } = require("zod");
const { MAX_EMAIL_BYTES } = require("./constants");
const { fail } = require("./validation");
const { createCloudflareMail } = require("./service");

// Only expected mail errors are safe for the browser. Never return provider credentials or database errors.
function mailError(error, _req, res, _next) {
  const status = Number(error.status) || 500;
  if (status >= 500 && !error.mailSafe)
    console.error("Email operation failed", { code: error.code || error.name });
  res
    .status(status)
    .set("Cache-Control", "no-store")
    .json({
      message:
        error.mailSafe || (status >= 400 && status < 500)
          ? error.message
          : "Email could not complete this request. Your unsent message has been kept.",
      ...(error.sendState ? { sendState: error.sendState } : {}),
    });
}
function getService() {
  return process.env.DOMAIN_MAIL_PROVIDER === "zoho"
    ? require("./zoho").createDomainMail()
    : createCloudflareMail();
}
function registerDomainMail(
  app,
  { requireAdmin, service = getService() } = {},
) {
  const router = express.Router();
  router.use(requireAdmin, (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  const folder = z.string().regex(/^\d{1,30}$/);
  const identifier = z.string().regex(/^(?:\d{1,30}|[a-f0-9]{24})$/);
  const checked = (schema, value) => {
    const result = schema.safeParse(value);
    if (!result.success)
      throw fail(400, "Choose a valid email, folder, or page.");
    return result.data;
  };
  router.get("/status", async (_req, res) => res.json(await service.status()));
  router.get("/folders", async (_req, res) =>
    res.json({ items: await service.folders() }),
  );
  router.get("/storage", async (_req, res) =>
    res.json(service.storage ? await service.storage() : {}),
  );
  router.get("/messages", async (req, res) => {
    const query = checked(
      z.object({
        folderId: folder,
        start: z.coerce.number().int().min(1).max(100000).default(1),
        q: z.string().trim().max(100).default(""),
      }),
      req.query,
    );
    res.json({
      items: await service.messages(query.folderId, query.start, query.q),
    });
  });
  router.get("/folders/:folderId/messages/:messageId", async (req, res) => {
    const { folderId, messageId } = checked(
      z.object({ folderId: folder, messageId: identifier }),
      req.params,
    );
    res.json({ item: await service.message(folderId, messageId) });
  });
  router.get(
    "/folders/:folderId/messages/:messageId/attachments/:attachmentId",
    async (req, res) => {
      const { folderId, messageId, attachmentId } = checked(
        z.object({
          folderId: folder,
          messageId: identifier,
          attachmentId: identifier,
        }),
        req.params,
      );
      const file = await service.attachment(folderId, messageId, attachmentId);
      res
        .set({
          "Content-Type": "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        })
        .send(file.data);
    },
  );
  router.patch(
    "/folders/:folderId/messages/:messageId/read",
    async (req, res) => {
      const { folderId, messageId } = checked(
        z.object({ folderId: folder, messageId: identifier }),
        req.params,
      );
      const { read } = checked(
        z.object({ read: z.boolean() }).strict(),
        req.body,
      );
      if (!service.read)
        throw fail(405, "This provider does not support read status here.");
      res.json(await service.read(folderId, messageId, read));
    },
  );
  router.post("/messages/:messageId/move", async (req, res) => {
    const messageId = checked(identifier, req.params.messageId);
    const { fromFolderId, folderId } = checked(
      z.object({ fromFolderId: folder, folderId: folder }).strict(),
      req.body,
    );
    if (!service.move)
      throw fail(405, "This provider does not support moving messages here.");
    res.json(await service.move(messageId, folderId, fromFolderId));
  });
  router.delete("/messages/:messageId", async (req, res) => {
    const messageId = checked(identifier, req.params.messageId);
    if (!service.remove)
      throw fail(405, "This provider does not support deletion here.");
    res.json(await service.remove(messageId));
  });
  router.post("/send", async (req, res) =>
    res.json(await service.send(String(req.user._id), req.body)),
  );
  router.use(mailError);
  app.use("/api/admin/mail", router);
}
function registerMailIngress(app, { service = createCloudflareMail() } = {}) {
  const router = express.Router();
  router.post(
    "/",
    (req, res, next) => {
      if (!/^[a-f0-9]{64}$/i.test(req.get("x-echo-mail-signature") || ""))
        return res.status(401).json({ message: "Invalid mail delivery." });
      next();
    },
    express.raw({
      type: "message/rfc822",
      limit: MAX_EMAIL_BYTES,
      inflate: false,
    }),
    async (req, res) => {
      res
        .set("Cache-Control", "no-store")
        .json(await service.receive(req.body, req.headers));
    },
  );
  router.use(mailError);
  app.use("/api/mail/inbound", router);
}
module.exports = { registerDomainMail, registerMailIngress };
