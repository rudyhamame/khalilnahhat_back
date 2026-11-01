#!/usr/bin/env node
// Additive and idempotent: creates the shared directory and its indexes only.
// Existing bookings and research reports are not geocoded, guessed or rewritten.
require('dotenv').config();const mongoose=require('mongoose');
(async()=>{await mongoose.connect(process.env.MONGODB_URI||'mongodb://127.0.0.1:27017',{dbName:process.env.MONGODB_DB_NAME||'khalil'});try{const {Venue}=require('../src/venue-map/models');const {ServiceRequest}=require('../src/models');await Venue.createCollection();await Venue.createIndexes();await ServiceRequest.collection.createIndex({'order.event.venue.recordId':1,userId:1},{name:'venue_record_owner'});console.log('Venue directory and additive indexes ready. Existing business records unchanged.');}finally{await mongoose.disconnect();}})().catch(error=>{console.error(error.message);process.exitCode=1;});
