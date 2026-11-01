const mongoose = require('mongoose');
const room = new mongoose.Schema({
  name: {type:String, required:true}, seatedCapacity:{type:Number,default:null}, standingCapacity:{type:Number,default:null},
  layoutNotes:{type:String,default:''}, capacitySource:{type:String,default:''}, areaSqM:{type:Number,default:null},
  areaMethod:{type:String,default:''}, areaSource:{type:String,default:''},
}, {_id:false});
const schema = new mongoose.Schema({
  name:{type:String,required:true}, address:{type:String,required:true}, city:{type:String,default:''},postalCode:{type:String,default:''},country:{type:String,default:'Canada'},
  location:{type:{type:String,enum:['Point'],default:'Point'},coordinates:{type:[Number],required:true}},
  venueType:{type:String,enum:['restaurant','banquet_hall','outdoor','other'],required:true},
  source:{type:String,required:true}, sourceId:{type:String,default:''}, sourceAttribution:{type:String,default:''},
  verificationStatus:{type:String,enum:['unverified','verified'],default:'unverified'}, lastVerifiedAt:{type:Date,default:null},
  rooms:{type:[room],default:[]},
  eventLinks:{type:[new mongoose.Schema({kind:{type:String,enum:['booking','service_request']},id:String},{_id:false})],default:[]},
  version:{type:Number,default:1},
},{timestamps:true});
schema.index({location:'2dsphere'});
module.exports = {Venue:mongoose.models.MapVenue || mongoose.model('MapVenue',schema)};
