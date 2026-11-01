#!/usr/bin/env node
// Additive and idempotent: creates the shared directory and its indexes only.
// Existing bookings and research reports are not geocoded, guessed or rewritten.
require('dotenv').config();const mongoose=require('mongoose');
(async()=>{await mongoose.connect(process.env.MONGODB_URI||'mongodb://127.0.0.1:27017',{dbName:process.env.MONGODB_DB_NAME||'khalil'});try{await require('../src/venue-map/migrate').ensureVenueMapIndexes();console.log('Venue directory and additive indexes ready. Existing business records unchanged.');}finally{await mongoose.disconnect();}})().catch(error=>{console.error(error.message);process.exitCode=1;});
