#!/usr/bin/env node
require('dotenv').config({quiet:true});
const mongoose=require('mongoose');
const {seedBookingAtoms,bookingAtomBindings}=require('../src/eden-eidos');
const {BOOKING_ATOMS}=require('../src/booking-atom-eidos');
(async()=>{
 if(!process.env.MONGODB_URI)throw Error('Configure MONGODB_URI before seeding Booking Eidos.');
 await mongoose.connect(process.env.MONGODB_URI,{dbName:process.env.MONGODB_DB_NAME||'khalil',autoCreate:false,autoIndex:true,serverSelectionTimeoutMS:10000});
 const result=await seedBookingAtoms();
 const links=await bookingAtomBindings(),mapped=new Map(links.map(row=>[row.atomId,row.eidosId]));
 if(BOOKING_ATOMS.some(atom=>!mapped.has(atom.atomId))||new Set(BOOKING_ATOMS.map(atom=>mapped.get(atom.atomId))).size!==BOOKING_ATOMS.length)throw Error('Booking seed verification failed.');
 console.log(JSON.stringify({created:result.created,totalBookingAtoms:BOOKING_ATOMS.length,linkedBookingAtoms:BOOKING_ATOMS.filter(atom=>mapped.has(atom.atomId)).length}));
})().catch(error=>{console.error(error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g,'[database connection]'));process.exitCode=1;}).finally(()=>mongoose.disconnect());
