// Stable entry point; provider adapters, HTTP handlers and rendering now have separate modules.
const { BOOKINGS, NOREPLY } = require("./business-mail-identity");
const { createDomainMail, parseJson } = require("./mail/zoho");
const { registerDomainMail } = require("./mail/routes");
const { textFromHtml } = require("./mail/text");
module.exports = {
  BOOKINGS,
  NOREPLY,
  createDomainMail,
  registerDomainMail,
  textFromHtml,
  parseJson,
};
