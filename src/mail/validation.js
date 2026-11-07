const { z } = require("zod");
const { FOLDERS } = require("./constants");
const fail = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, mailSafe: true, ...extra });
const objectId = (value) =>
  typeof value === "string" && /^[a-f0-9]{24}$/.test(value);
const validFolder = (value) => FOLDERS.some((folder) => folder.id === value);
const email = z
  .string()
  .trim()
  .email()
  .max(254)
  .refine((value) => !/[\r\n]/.test(value));
const draftSchema = z
  .object({
    requestId: z.string().uuid(),
    to: z.array(email).min(1).max(10),
    cc: z.array(email).max(10).default([]),
    subject: z
      .string()
      .trim()
      .min(1)
      .max(250)
      .refine((value) => !/[\r\n]/.test(value)),
    text: z.string().trim().min(1).max(50000),
    replyMessageId: z
      .string()
      .regex(/^[a-f0-9]{24}$/)
      .optional(),
  })
  .strict();
module.exports = { fail, objectId, validFolder, draftSchema };
