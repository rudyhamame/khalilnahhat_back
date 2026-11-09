const mongoose = require("mongoose");
const { BOOKINGS, MAX_STORAGE_BYTES, PAGE_SIZE } = require("./constants");
const { fail } = require("./validation");

// Model and collection names preserve the already activated mailbox.
const schema = new mongoose.Schema(
  {
    mailbox: { type: String, required: true, default: BOOKINGS, index: true },
    folder: { type: String, default: "1" },
    previousFolder: String,
    deliveryKey: String,
    owner: String,
    requestId: String,
    hash: String,
    state: { type: String, default: "received" },
    providerMessageId: String,
    from: String,
    sender: String,
    to: [String],
    cc: [String],
    replyTo: String,
    subject: String,
    text: String,
    rfcMessageId: String,
    references: String,
    time: { type: Date, default: Date.now, index: true },
    bytes: { type: Number, default: 0 },
    attachments: [
      { name: String, data: { type: Buffer, select: false }, size: Number },
    ],
    read: { type: Boolean, default: false },
  },
  { timestamps: true },
);
schema.index({ deliveryKey: 1 }, { unique: true, sparse: true });
schema.index(
  { owner: 1, requestId: 1 },
  { unique: true, partialFilterExpression: { requestId: { $type: "string" } } },
);
schema.index({ mailbox: 1, folder: 1, time: -1, _id: -1 });
const Message =
  mongoose.models.DomainInboxMessage ||
  mongoose.model("DomainInboxMessage", schema);
const Quota =
  mongoose.models.DomainMailQuota ||
  mongoose.model(
    "DomainMailQuota",
    new mongoose.Schema({ _id: String, bytes: { type: Number, default: 0 } }),
  );
let initialized;
function ensureIndexes() {
  return (
    initialized ||
    (initialized = Promise.all([Message.init(), Quota.init()]).catch(
      (error) => {
        initialized = null;
        throw error;
      },
    ))
  );
}
async function transaction(work) {
  await ensureIndexes();
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
async function reserve(bytes, session) {
  await Quota.updateOne(
    { _id: BOOKINGS },
    { $setOnInsert: { bytes: 0 } },
    { upsert: true, session },
  );
  const row = await Quota.findOneAndUpdate(
    { _id: BOOKINGS, bytes: { $lte: MAX_STORAGE_BYTES - bytes } },
    { $inc: { bytes } },
    { returnDocument: "after", session },
  );
  if (!row)
    throw fail(
      507,
      "Your mailbox is full. Permanently remove messages from Trash to free space.",
      { sendState: "not_sent" },
    );
}
const scope = (folder, extra = {}) => ({
  mailbox: BOOKINGS,
  folder,
  ...(folder === "2" ? { state: "sent" } : {}),
  ...extra,
});
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mongoStore = {
  sendStatus:(owner,requestId)=>Message.findOne({mailbox:BOOKINGS,owner,requestId}).select('_id state providerMessageId').lean(),
  async receive(row) {
    try {
      return await transaction(async (session) => {
        const existing = await Message.findOne({
          deliveryKey: row.deliveryKey,
          mailbox: BOOKINGS,
        }).session(session);
        if (existing) return { id: String(existing._id), confirmed: true };
        await reserve(row.bytes, session);
        const [item] = await Message.create([row], { session });
        return { id: String(item._id), confirmed: true };
      });
    } catch (error) {
      if (error.code === 11000) {
        const existing = await Message.findOne({
          mailbox: BOOKINGS,
          deliveryKey: row.deliveryKey,
        });
        if (existing) return { id: String(existing._id), confirmed: true };
      }
      throw error;
    }
  },
  async list(folder, start, search = "") {
    const filter = scope(folder);
    if (search) {
      const term = new RegExp(escapeRegex(search), "i");
      filter.$or = ["subject", "from", "sender", "to", "text"].map((key) => ({
        [key]: term,
      }));
    }
    return Message.find(filter)
      .select("-attachments.data")
      .sort({ time: -1, _id: -1 })
      .skip(start - 1)
      .limit(PAGE_SIZE)
      .maxTimeMS(5000)
      .lean();
  },
  get: (folder, id, files = false) =>
    Message.findOne(scope(folder, { _id: id }))
      .select(files ? "+attachments.data" : "-attachments.data")
      .lean(),
  async claim(owner, requestId, hash, row) {
    try {
      return await transaction(async (session) => {
        const old = await Message.findOne({
          mailbox: BOOKINGS,
          owner,
          requestId,
        }).session(session);
        if (old) return { created: false, item: old };
        const bytes =
          Buffer.byteLength(row.text || "") +
          Buffer.byteLength(row.subject || "") +
          2048;
        await reserve(bytes, session);
        const [item] = await Message.create(
          [
            {
              ...row,
              bytes,
              mailbox: BOOKINGS,
              owner,
              requestId,
              hash,
              folder: "4",
              state: "pending",
              read: true,
            },
          ],
          { session },
        );
        return { created: true, item };
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      return {
        created: false,
        item: await Message.findOne({ mailbox: BOOKINGS, owner, requestId }),
      };
    }
  },
  finish: (owner, requestId, values) =>
    Message.updateOne(
      { mailbox: BOOKINGS, owner, requestId },
      { $set: values },
    ),
  async folders() {
    return Message.aggregate([
      { $match: { mailbox: BOOKINGS } },
      {
        $group: {
          _id: "$folder",
          total: { $sum: 1 },
          unread: { $sum: { $cond: [{ $eq: ["$read", true] }, 0, 1] } },
        },
      },
    ]);
  },
  async storage() {
    const row = await Quota.findById(BOOKINGS).lean();
    return { usedBytes: row?.bytes || 0, limitBytes: MAX_STORAGE_BYTES };
  },
  read: (folder, id, read) =>
    Message.findOneAndUpdate(
      scope(folder, { _id: id }),
      { $set: { read } },
      { returnDocument: "after" },
    ).lean(),
  async move(id, folder, fromFolder) {
    return Message.findOneAndUpdate(
      {
        mailbox: BOOKINGS,
        _id: id,
        folder: fromFolder,
        state: { $ne: "pending" },
        ...(["2", "4"].includes(folder) ? { previousFolder: folder } : {}),
      },
      { $set: { folder, previousFolder: fromFolder } },
      { returnDocument: "after" },
    ).lean();
  },
  async remove(id) {
    return transaction(async (session) => {
      const row = await Message.findOneAndDelete(
        { mailbox: BOOKINGS, _id: id, folder: "3", state: { $ne: "pending" } },
        { session },
      );
      if (!row)
        throw fail(
          404,
          "The message is no longer in Trash. Refresh before trying again.",
        );
      if (row.bytes)
        await Quota.updateOne(
          { _id: BOOKINGS },
          { $inc: { bytes: -row.bytes } },
          { session },
        );
      return { confirmed: true };
    });
  },
};
module.exports = { mongoStore };
