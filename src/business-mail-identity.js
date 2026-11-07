const BOOKINGS='bookings@djkhalilnahhat.ca';
const NOREPLY='noreply@djkhalilnahhat.ca';
const LEGACY='khalilnahhatdj@gmail.com';
const active=(env=process.env)=>env.DOMAIN_EMAIL_ACTIVE==='true';
const notificationAddress=(env=process.env)=>active(env)?BOOKINGS:env.SERVICE_REQUEST_NOTIFICATION_EMAIL?.trim()||LEGACY;
const senderAddress=(env=process.env)=>active(env)?NOREPLY:env.EMAIL_FROM_ADDRESS?.trim()||'';
module.exports={BOOKINGS,NOREPLY,active,notificationAddress,senderAddress};
