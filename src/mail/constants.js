const { BOOKINGS, NOREPLY } = require("../business-mail-identity");
const MAX_EMAIL_BYTES = 5 * 1024 * 1024;
const MAX_STORAGE_BYTES = 100 * 1024 * 1024;
const PAGE_SIZE = 50;
const FOLDERS = Object.freeze([
  { id: "1", name: "Inbox", type: "Inbox" },
  { id: "2", name: "Sent", type: "Sent" },
  { id: "5", name: "Archive", type: "Archive" },
  { id: "4", name: "Needs attention", type: "Unconfirmed" },
  { id: "3", name: "Trash", type: "Trash" },
]);
module.exports = {
  BOOKINGS,
  NOREPLY,
  MAX_EMAIL_BYTES,
  MAX_STORAGE_BYTES,
  PAGE_SIZE,
  FOLDERS,
};
