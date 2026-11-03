require('dotenv').config();
const mongoose=require('mongoose');
const cloudinary=require('cloudinary').v2;
const {discoverReferenced}=require('../src/cloudinary-assets');
(async()=>{
 const args=process.argv.slice(2);if(args.some(arg=>arg!=='--register'))throw Error('Use --register or no arguments.');
 cloudinary.config(process.env.CLOUDINARY_URL||{cloud_name:process.env.CLOUDINARY_CLOUD_NAME,api_key:process.env.CLOUDINARY_API_KEY,api_secret:process.env.CLOUDINARY_API_SECRET,secure:true});
 // Connect directly: the audit must not invoke application seed routines.
 await mongoose.connect(process.env.MONGODB_URI||'mongodb://127.0.0.1:27017',{dbName:process.env.MONGODB_DB_NAME||'khalil'});
 console.log(JSON.stringify(await discoverReferenced({dryRun:!args.includes('--register')})));
})().catch(error=>{console.error('Asset audit failed:',error.name);process.exitCode=1;}).finally(()=>mongoose.disconnect());
