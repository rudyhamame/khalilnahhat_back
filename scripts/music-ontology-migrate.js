#!/usr/bin/env node
require('dotenv').config({quiet:true});
const fs=require('fs');const mongoose=require('mongoose');
(async()=>{
 const args=process.argv.slice(2),apply=args.includes('--apply');
 await mongoose.connect(process.env.MONGODB_URI||'mongodb://127.0.0.1:27017',{dbName:process.env.MONGODB_DB_NAME||'khalil',serverSelectionTimeoutMS:10000,autoIndex:false,autoCreate:false});
 const migration=require('../src/music-ontology/migration');
 const {ownedAsset,deliveryUrl}=require('../src/music-archive');
 const service=require('../src/music-ontology/service').createService({ownedAsset,deliveryUrl});
 let result;
 if(args[0]==='audit')result=await migration.audit();
 else if(args[0]==='migrate'&&args[1])result=await migration.migrate(JSON.parse(fs.readFileSync(args[1],'utf8')),{apply,runId:args.includes('--run-id')?args[args.indexOf('--run-id')+1]:undefined,service});
 else if(args[0]==='rollback'&&args[1])result=await migration.rollback(args[1],{apply,service});
 else throw Error('Usage: node scripts/music-ontology-migrate.js audit | migrate mapping.json [--apply] [--run-id ID] | rollback RUN_ID [--apply]');
 console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e.name+': '+(e.name==='MongooseServerSelectionError'?'Database unavailable.':e.message));process.exitCode=1;}).finally(()=>mongoose.disconnect());
