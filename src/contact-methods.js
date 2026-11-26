// Contact choices come from the Booking Tree, including account/profile validation.
const tree=require('../contracts/booking-atoms.json');
const field=tree.order.sections.flatMap(section=>section.fields).find(field=>field.key==='customer.contactMethod');
module.exports={CONTACT_METHODS:Object.freeze([...field.options])};
