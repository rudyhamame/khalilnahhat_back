// Compatibility entry point for the server and existing mailbox transport checks.
const { createCloudflareMail } = require("./mail/service");
const { registerMailIngress } = require("./mail/routes");
const { MAX_EMAIL_BYTES, MAX_STORAGE_BYTES } = require("./mail/constants");
module.exports = {
  createCloudflareMail,
  registerMailIngress,
  MAX_EMAIL_BYTES,
  MAX_STORAGE_BYTES,
};
