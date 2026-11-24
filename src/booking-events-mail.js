const { notificationEmails, catalog, render } = require('./notification-emails');
const { sendBrevoEmail } = require('./brevo');
const { notificationAddress } = require('./business-mail-identity');
const { windowFor } = require('./booking-availability');
const { bookingUrl } = require('./booking-process-mail');

const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

/**
 * Sends one email of the booking journey (see the catalog ids starting with "booking-" in notification-emails.js).
 * The wording comes from the Notification emails tab; a disabled email is skipped. Never throws: a failed email must not fail the booking action.
 */
async function notifyBooking(sr, id, extra = {}, { notifications = notificationEmails, send = sendBrevoEmail } = {}) {
  try {
    const event = catalog.find((item) => item.id === id);
    if (!event) throw new Error(`Unknown notification email ${id}`);
    const toCustomer = event.recipient === 'Customer';
    const email = toCustomer ? sr.customerEmail : notificationAddress();
    if (!email) return { sent: false, skipped: true };
    const rule = await notifications.get(id);
    if (!rule.enabled) return { sent: false, skipped: true, disabled: true };
    const schedule = windowFor(sr), eventCode = sr.confirmationCode || sr.requestNumber || sr.externalId;
    const context = {
      recipientName: toCustomer ? sr.customerName : 'Khalil',
      customerName: sr.customerName, customerEmail: sr.customerEmail, eventCode, requestId: eventCode,
      eventDate: schedule.date || 'To be discussed', eventTime: [schedule.startTime, schedule.endTime].filter(Boolean).join(' – '),
      actionUrl: toCustomer ? bookingUrl(sr) : (process.env.ADMIN_SERVICES_URL?.trim() || bookingUrl(sr)),
      total: money(Math.round(Number(sr.total || 0) * 100)), depositAmount: money(Math.round(Number(sr.depositAmount || 0) * 100)),
      expiresAt: sr.expiresAt ? new Date(sr.expiresAt).toLocaleDateString('en-CA') : '',
      ...extra,
    };
    const message = render(rule, context);
    return await send({ to: [{ email, name: toCustomer ? sr.customerName : 'Khalil Nahhat' }], subject: message.subject, htmlContent: message.html, textContent: message.text, tags: [id], notificationContext: context });
  } catch (error) {
    console.warn(`Booking email ${id} was not sent: ${error.message}`);
    return { sent: false, error: error.message };
  }
}
module.exports = { notifyBooking, money };
