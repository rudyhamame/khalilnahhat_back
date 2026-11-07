const BOOKINGS = "bookings@djkhalilnahhat.ca";
const NOREPLY = "noreply@djkhalilnahhat.ca";
const active = (env = process.env) => env.DOMAIN_EMAIL_ACTIVE === "true";
const notificationAddress = (env = process.env) =>
  active(env)
    ? BOOKINGS
    : env.SERVICE_REQUEST_NOTIFICATION_EMAIL?.trim() || BOOKINGS;
const senderAddress = (env = process.env) =>
  active(env) ? NOREPLY : env.EMAIL_FROM_ADDRESS?.trim() || NOREPLY;
module.exports = {
  BOOKINGS,
  NOREPLY,
  active,
  notificationAddress,
  senderAddress,
};
