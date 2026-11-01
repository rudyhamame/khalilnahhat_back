const {Venue}=require('./models');
const {ServiceRequest}=require('../models');
// Additive and idempotent. Never syncIndexes(): unrelated indexes must remain.
async function ensureVenueMapIndexes(){
 await Venue.createCollection();
 await Venue.createIndexes();
 await ServiceRequest.collection.createIndex({'order.event.venue.recordId':1,userId:1},{name:'venue_record_owner'});
}
module.exports={ensureVenueMapIndexes};
