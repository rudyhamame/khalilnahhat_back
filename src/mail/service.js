const {
  BOOKINGS,
  NOREPLY,
  FOLDERS,
  MAX_EMAIL_BYTES,
  MAX_STORAGE_BYTES,
} = require("./constants");
const { fail, objectId, validFolder } = require("./validation");
const { mongoStore } = require("./store");
const { createReceiver } = require("./receive");
const { createSender } = require("./send");

function summary(row) {
  return {
    id: String(row._id),
    folderId: row.folder,
    previousFolder: row.previousFolder,
    subject: row.subject || "(No subject)",
    from: row.from || "",
    to: (row.to || []).join(", "),
    sender: row.sender || row.from || "",
    summary: String(row.text || "").slice(0, 180),
    time: new Date(row.time).getTime(),
    attachments: Boolean(row.attachments?.length),
    state: row.state,
    read: Boolean(row.read),
  };
}
function assertMessage(folder, id) {
  if (!validFolder(folder) || !objectId(id))
    throw fail(400, "Choose a valid message and folder.");
}
function createCloudflareMail({
  env = process.env,
  fetchImpl = fetch,
  store = mongoStore,
  clock = Date.now,
  parser,
} = {}) {
  const receiving = () =>
    env.DOMAIN_MAIL_RECEIVING_ACTIVE === "true" &&
    /^[a-f0-9]{64}$/i.test(env.MAIL_INGRESS_SECRET || "");
  const sending = () =>
    env.DOMAIN_MAIL_SENDING_ACTIVE === "true" &&
    Boolean(env.BREVO_API_KEY?.trim());
  return {
    sendStatus:(owner,requestId)=>require('./send-status').sendStatus(store,owner,requestId),
    status() {
      return {
        provider: "Cloudflare + Brevo",
        mailbox: BOOKINGS,
        configured: receiving(),
        receivingConfigured: receiving(),
        sendingConfigured: sending(),
        setupUrl: "https://dash.cloudflare.com/",
        active: env.DOMAIN_EMAIL_ACTIVE === "true",
        automation: {
          address: NOREPLY,
          configured:
            env.DOMAIN_EMAIL_ACTIVE === "true" &&
            Boolean(env.BREVO_API_KEY?.trim()),
        },
        limits: {
          messageBytes: MAX_EMAIL_BYTES,
          storageBytes: MAX_STORAGE_BYTES,
        },
        capabilities: { search: true, read: true, move: true, remove: true },
      };
    },
    async folders() {
      const counts = store.folders ? await store.folders() : [];
      return FOLDERS.map((folder) => {
        const count = counts.find((row) => row._id === folder.id);
        return {
          ...folder,
          total: count?.total || 0,
          unread: count?.unread || 0,
        };
      });
    },
    storage: () =>
      store.storage
        ? store.storage()
        : { usedBytes: 0, limitBytes: MAX_STORAGE_BYTES },
    async messages(folder, start = 1, search = "") {
      if (!validFolder(folder)) throw fail(400, "Choose a valid mail folder.");
      return (await store.list(folder, start, search)).map(summary);
    },
    async message(folder, id) {
      assertMessage(folder, id);
      const row = await store.get(folder, id);
      if (!row) throw fail(404, "Message not found. Refresh the folder.");
      return {
        ...summary(row),
        cc: (row.cc || []).join(", "),
        replyTo: row.replyTo || row.from,
        text: row.text || "",
        attachments: (row.attachments || []).map((file) => ({
          id: String(file._id),
          name: file.name,
          size: file.size,
        })),
      };
    },
    async attachment(folder, id, attachmentId) {
      assertMessage(folder, id);
      if (!objectId(attachmentId))
        throw fail(400, "Choose a valid attachment.");
      const row = await store.get(folder, id, true);
      const file = row?.attachments?.find(
        (item) => String(item._id) === attachmentId,
      );
      if (!file) throw fail(404, "Attachment not found.");
      // BSON Binary.value() returns the exact bytes; its pooled backing buffer can contain unrelated data.
      const data = Buffer.isBuffer(file.data)
        ? file.data
        : Buffer.from(file.data.value?.() || file.data.buffer || file.data);
      return { name: file.name, data };
    },
    async read(folder, id, read) {
      assertMessage(folder, id);
      if (typeof read !== "boolean")
        throw fail(400, "Choose a valid read status.");
      const row = await store.read(folder, id, read);
      if (!row) throw fail(404, "The message has moved. Refresh the folder.");
      return { confirmed: true, item: summary(row) };
    },
    async move(id, folder, fromFolder) {
      assertMessage(fromFolder, id);
      if (
        !validFolder(folder) ||
        folder === fromFolder ||
        (["2", "4"].includes(folder) && fromFolder !== "3")
      )
        throw fail(400, "Choose a different destination folder.");
      const row = await store.move(id, folder, fromFolder);
      if (!row)
        throw fail(
          409,
          "This message has moved or is still sending. Refresh before trying again.",
        );
      return { confirmed: true, item: summary(row) };
    },
    async remove(id) {
      if (!objectId(id)) throw fail(400, "Choose a valid message.");
      return store.remove(id);
    },
    receive: createReceiver({ env, store, clock, parser }),
    send: createSender({ env, store, clock, fetchImpl }),
  };
}
module.exports = { createCloudflareMail };
