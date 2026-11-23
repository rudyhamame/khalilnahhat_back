// One-time cleanup: equipment "sets" no longer exist. Finds every equipment record that is a set (isSet, setItems or modelParts)
// and, with --apply, deletes it exactly like the admin Delete button does (media cleanup included), removes its "removed" marker and
// strips the retired isSet / setItems / modelParts fields from the remaining equipment.
// Default is a DRY RUN: it only prints what it would do. Past quotes and bookings are never changed; the count of those that mention a
// set is printed for information.
//   node scripts/remove-equipment-sets.js           report only
//   node scripts/remove-equipment-sets.js --apply   delete
// Uses MONGODB_URI from the environment (or .env). Run it on the target environment yourself; it is idempotent.
require('dotenv').config({quiet:true});
const mongoose=require('mongoose');
const apply=process.argv.includes('--apply');
async function main(){
 if(!process.env.MONGODB_URI)throw new Error('MONGODB_URI is required.');
 await mongoose.connect(process.env.MONGODB_URI,{serverSelectionTimeoutMS:20000});
 const {Equipment,EquipmentTombstone}=require('../src/equipment');
 const {ServiceRequest}=require('../src/models');
 const permanentDeletion=require('../src/permanent-deletion');
 // The raw collection, because the retired fields are no longer in the schema.
 const raw=Equipment.collection;
 const sets=await raw.find({$or:[{isSet:true},{'setItems.0':{$exists:true}},{'modelParts.0':{$exists:true}}]},{projection:{slug:1,name:1,category:1}}).toArray();
 const slugs=sets.map(row=>row.slug);
 const markers=slugs.length?await EquipmentTombstone.collection.countDocuments({slug:{$in:slugs}}):0;
 const referenced=slugs.length?await ServiceRequest.countDocuments({'items.serviceId':{$in:slugs}}):0;
 const leftovers=await raw.countDocuments({$or:[{isSet:{$exists:true}},{setItems:{$exists:true}},{modelParts:{$exists:true}}],slug:{$nin:slugs}});
 console.log(`${apply?'APPLY':'DRY RUN'}: ${sets.length} set(s) found${sets.length?': '+slugs.join(', '):''}`);
 for(const row of sets)console.log(`  - ${row.slug} | ${row.name} | ${row.category}`);
 console.log(`removed-markers for them: ${markers}; other equipment still carrying retired fields: ${leftovers}; past bookings mentioning a set (left untouched): ${referenced}`);
 if(!apply){console.log('Nothing changed. Re-run with --apply to delete.');return;}
 for(const slug of slugs){const removed=await permanentDeletion.remove(Equipment,{slug});console.log(`deleted ${slug}${removed?'':' (already gone)'}${removed?.cloudinaryCleanupPending?' — media cleanup pending':''}`);}
 if(slugs.length)console.log(`removed-markers deleted: ${(await EquipmentTombstone.collection.deleteMany({slug:{$in:slugs}})).deletedCount}`);
 const stripped=await raw.updateMany({},{$unset:{isSet:'',setItems:'',modelParts:''}});
 console.log(`retired fields stripped from ${stripped.modifiedCount} equipment record(s).`);
}
main().catch(error=>{console.error('Set cleanup failed:',error.name,error.message);process.exitCode=1;}).finally(()=>mongoose.disconnect());
