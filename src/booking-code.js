const {randomBytes}=require('node:crypto');
const alphabet='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
// Twelve readable characters, grouped for memorising; uniqueness is enforced in MongoDB.
function createBookingCode(){
 const code=[...randomBytes(12)].map(byte=>alphabet[byte&31]).join('');
 return 'ECHO-'+code.match(/.{4}/g).join('-');
}
const bookingCodeCollision=error=>error?.code===11000&&Boolean(error.keyPattern?.confirmationCode||error.keyValue?.confirmationCode);
module.exports={createBookingCode,bookingCodeCollision};
