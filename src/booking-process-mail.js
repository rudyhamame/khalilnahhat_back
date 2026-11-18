const {sendSimpleEmail} = require('./brevo');
const esc = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function sendBookingDecision(sr, decision) {
  const code = sr.confirmationCode || sr.requestNumber || sr.externalId;
  const available = decision === 'available';
  return sendSimpleEmail({to:sr.customerEmail,name:sr.customerName,
    subject:`${available ? 'Availability confirmed' : 'Thank you for your interest'} — ${code}`,
    tags:['booking-decision'],
    html:`<p>Hello ${esc(sr.customerName)},</p><p>${available ? 'We are available for your event. We are preparing your prices and deposit details. When your quote is ready, please log in to accept, decline, or negotiate. After accepting, choose a time to discuss your event by phone or WhatsApp.' : 'Thank you for considering Echo Event Entertainment. This booking request has been declined and is now closed. We appreciate your interest and hope to help with a future event.'}</p><p>Booking ID: <strong>${esc(code)}</strong></p><p><a href="${esc(process.env.CUSTOMER_SERVICES_URL || 'https://djkhalilnahhat.ca/dashboard/bookings?tab=quotes')}">Open your booking dashboard</a></p><p>Echo Website</p>`});
}
module.exports = {sendBookingDecision};
