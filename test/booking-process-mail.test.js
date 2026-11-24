const {test}=require('node:test');
const assert=require('node:assert/strict');
const {bookingMessage}=require('../src/booking-process-mail');
const {sendBrevoEmail}=require('../src/brevo');
const sr={externalId:'test-booking',customerName:'Alex',customerEmail:'alex@example.invalid',event:{eventDate:'2099-01-01',startTime:'18:00',endTime:'23:00'},availabilityReason:'Already booked <script>bad</script>\nTry another time'};
test('stage emails describe availability, open requests and optional discussions honestly',()=>{
 const requested=bookingMessage(sr,'requested');assert.match(requested.subject,/Booking requested/);assert.match(requested.html,/does not reserve/);
 const available=bookingMessage(sr,'available');assert.match(available.html,/waiting for quote/);
 const unavailable=bookingMessage(sr,'unavailable');assert.match(unavailable.html,/optional/);assert.match(unavailable.html,/request remains open/);assert.match(unavailable.html,/&lt;script&gt;/);assert.doesNotMatch(unavailable.html,/<script>/);
 const url=new URL(unavailable.notificationContext.meetingUrl);assert.equal(url.searchParams.get('booking'),sr.externalId);assert.equal(url.searchParams.get('meeting'),'availability');
 assert.throws(()=>bookingMessage({...sr,availabilityReason:''},'unavailable'),/reason is required/);
});
test('booking and meeting mail use noreply even with a legacy sender configuration',async()=>{
 for(const tag of ['booking-requested','booking-decision-unavailable','service-quote','booking-confirmation','meeting-confirmed','quote-expiry-reminder']){
 let payload;const result=await sendBrevoEmail({to:[{email:sr.customerEmail}],tags:[tag],subject:'Test',htmlContent:'Test'},{env:{BREVO_API_KEY:'test',EMAIL_FROM_ADDRESS:'legacy@example.invalid'},notifications:{apply:async value=>value},fetchImpl:async(_url,options)=>{payload=JSON.parse(options.body);return {ok:true,json:async()=>({messageId:'test'})};}});
 assert.equal(result.sent,true);assert.equal(payload.sender.email,'noreply@djkhalilnahhat.ca');
 }
});
