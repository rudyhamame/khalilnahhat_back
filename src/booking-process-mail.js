const {sendSimpleEmail}=require('./brevo');
const {windowFor}=require('./booking-availability');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function bookingUrl(sr,meeting=false){const url=new URL(process.env.CUSTOMER_SERVICES_URL||'https://djkhalilnahhat.ca/dashboard/bookings');url.searchParams.set('booking',sr.externalId);if(meeting)url.searchParams.set('meeting','availability');return url.href;}
function bookingMessage(sr,stage){
 const eventCode=sr.confirmationCode||sr.requestNumber||sr.externalId,actionUrl=bookingUrl(sr),meetingUrl=bookingUrl(sr,true),schedule=windowFor(sr),eventDate=schedule.date||'To be discussed',eventTime=[schedule.startTime,schedule.endTime].filter(Boolean).join(' – '),reason=String(sr.availabilityReason||'').trim();
 const shared={to:sr.customerEmail,name:sr.customerName,notificationContext:{customerName:sr.customerName,eventCode,requestId:eventCode,eventDate,eventTime,timezone:schedule.timezone,reason,actionUrl,meetingUrl}};
 const greeting=`<p>Hello ${esc(sr.customerName)},</p>`,scheduleHtml=`<p>Requested date: <strong>${esc(eventDate)}</strong>${eventTime?`<br>Time: ${esc(eventTime)} (${esc(schedule.timezone)})`:''}</p>`,link=`<p><a href="${esc(actionUrl)}">View your booking</a></p>`;
 if(stage==='requested')return {...shared,subject:`Booking requested — ${eventCode}`,tags:['booking-requested'],html:`${greeting}<h2>Booking requested</h2><p>We have received your booking request. Our team will check your requested date and time, then inform you of availability before preparing a quote.</p>${scheduleHtml}<p>This request does not reserve the event date. Your booking is Booked only after quote acceptance, the required deposit, and final confirmation.</p>${link}`};
 if(stage==='available')return {...shared,subject:`Booking date available — ${eventCode}`,tags:['booking-decision','booking-decision-available'],html:`${greeting}<h2>Booking date available</h2>${scheduleHtml}<p>We are available for your requested date and time. Your booking is now waiting for quote. We will notify you when your booking quote is ready.</p><p>Availability confirmation does not reserve the date or mark the event as Booked.</p>${link}`};
 if(stage==='unavailable'){
  if(!reason)throw Error('An availability reason is required');
  return {...shared,subject:`Booking date unavailable — ${eventCode}`,tags:['booking-decision','booking-decision-unavailable'],html:`${greeting}<h2>Booking date unavailable</h2>${scheduleHtml}<p><strong>Reason:</strong> ${esc(reason).replace(/\n/g,'<br>')}</p><p>If you would like, book a meeting to discuss other date or time options. This meeting is optional and does not reserve or confirm your event.</p><p><a href="${esc(meetingUrl)}">Book an optional availability discussion</a></p><p>Your request remains open. You can also suggest another date and time from your booking dashboard.</p>${link}`};
 }
 return {...shared,subject:`Thank you for your interest — ${eventCode}`,tags:['booking-decision','booking-decision-declined'],html:`${greeting}<p>This booking request has been declined and is now closed. Thank you for considering Echo Event Entertainment.</p>${link}`};
}
function sendBookingDecision(sr,decision){return sendSimpleEmail(bookingMessage(sr,decision));}
function sendBookingRequested(sr){return sendSimpleEmail(bookingMessage(sr,'requested'));}
module.exports={sendBookingDecision,sendBookingRequested,bookingMessage,bookingUrl};
