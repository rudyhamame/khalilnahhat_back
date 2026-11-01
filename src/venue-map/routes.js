const {z}=require('zod');
const {Venue}=require('./models');
const {Booking,ServiceRequest}=require('../models');
const nullableNumber=z.number().positive().max(1000000).nullable().default(null);
const text=(n=500)=>z.string().trim().max(n).default('');
const room=z.object({name:z.string().trim().min(1).max(160),seatedCapacity:nullableNumber,standingCapacity:nullableNumber,layoutNotes:text(2000),capacitySource:text(),areaSqM:nullableNumber,areaMethod:text(200),areaSource:text()}).strict()
 .refine(r=>[r.seatedCapacity,r.standingCapacity].every(n=>n===null||Number.isInteger(n)),'Capacities must be whole numbers.')
 .refine(r=>(r.seatedCapacity===null&&r.standingCapacity===null)||!!r.capacitySource,'Capacity needs a source.')
 .refine(r=>r.areaSqM===null||!!(r.areaMethod&&r.areaSource),'Area needs a measurement method and source.')
 .refine(r=>r.areaSqM===null||!(/footprint|capacity|guest/i.test(r.areaMethod)),'Interior area cannot be inferred from a footprint or capacity.');
const link=z.object({kind:z.enum(['booking','service_request']),id:z.string().regex(/^[a-f\d]{24}$/i)}).strict();
const venueInput=z.object({name:z.string().trim().min(1).max(240),address:z.string().trim().min(1).max(500),city:text(160),postalCode:text(12),country:text(80),latitude:z.number().min(-85).max(85),longitude:z.number().min(-180).max(180),venueType:z.enum(['restaurant','banquet_hall','outdoor','other']),source:z.enum(['manual','geoapify']),sourceId:text(500),sourceAttribution:text(2000),verificationStatus:z.enum(['verified','unverified']),lastVerifiedAt:z.iso.datetime().nullable().default(null),rooms:z.array(room).max(100).default([]),eventLinks:z.array(link).max(100).default([]),version:z.number().int().positive().optional()}).strict().refine(r=>(r.verificationStatus==='verified')===!!r.lastVerifiedAt,'Verification requires a date; unverified venues must have no verification date.').refine(r=>r.source==='manual'||!!(r.sourceId&&r.sourceAttribution),'External records require source ID and attribution.');
function searchWords(value){return String(value).normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[’‘']/g,"'").replace(/'s\b/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/).filter(w=>w&&w!=='the');}
function parseBounds(value){const a=String(value||'').split(',').map(Number);if(a.length!==4||!a.every(Number.isFinite)||a[0]<-180||a[2]>180||a[1]<-85||a[3]>85||a[0]>=a[2]||a[1]>=a[3])throw Object.assign(new Error('Use valid west,south,east,north bounds.'),{status:400});return a;}
function listQuery(query){const [w,s,e,n]=parseBounds(query.bounds);
 const region=(west,east)=>({location:{$geoWithin:{$geometry:{type:'Polygon',coordinates:[[[west,s],[east,s],[east,n],[west,n],[west,s]]]}}}});
 // Wide views must be split: a full-world spherical polygon degenerates at ±180,
 // and a >hemisphere ring can select the opposite side of the earth.
 const filter=e-w<179?region(w,e):{$and:[{$or:Array.from({length:Math.ceil((e-w)/90)},(_,i)=>region(w+i*90,Math.min(e,w+(i+1)*90)))}]};
 if(query.type){if(!['restaurant','banquet_hall','outdoor','other'].includes(query.type))throw Object.assign(new Error('Invalid venue type.'),{status:400});filter.venueType=query.type;}
 if(query.q){const terms=searchWords(String(query.q).slice(0,160));if(terms.length)filter.$and=[...(filter.$and||[]),...terms.map(term=>({$or:['name','address','city'].map(k=>({[k]:{$regex:[...term].join("[’‘']?"),$options:'i'}}))}))];}

 if(query.capacity==='known')filter.rooms={$elemMatch:{$or:[{seatedCapacity:{$gt:0}},{standingCapacity:{$gt:0}}]}};
 else if(query.capacity==='unknown')filter.rooms={$not:{$elemMatch:{$or:[{seatedCapacity:{$gt:0}},{standingCapacity:{$gt:0}}]}}};
 else if(query.capacity)throw Object.assign(new Error('Invalid capacity filter.'),{status:400});return filter;}
function view(row){const v=row.toObject?row.toObject():row;return {...v,id:String(v._id),latitude:v.location.coordinates[1],longitude:v.location.coordinates[0],saved:true};}
const eventModels={booking:Booking,service_request:ServiceRequest};
async function eventViews(links,owner=null){const out=[];for(const {kind,id} of links){const item=await eventModels[kind].findOne({_id:id,...(owner?(kind==='service_request'?{userId:owner._id}:{email:owner.email}):{})}).select('reference fullName eventType eventDate city requestNumber event status').lean();if(item)out.push({kind,id:String(item._id),label:kind==='booking'?`${item.reference} · ${item.eventType} · ${item.eventDate}`:`${item.requestNumber||'Request'} · ${item.event?.eventType||'Event'} · ${item.event?.eventDate||''}`});}return out;}
function registerVenueMap(app,{requireAdmin,requireAuth,env=process.env,fetchImpl=fetch,model=Venue}={}){
 const base='/api/admin/venue-map',buckets=new Map();let active=0;
 const guard=(fn,auth=requireAdmin)=>[auth,async(req,res)=>{res.set('Cache-Control','no-store');try{await fn(req,res);}catch(e){res.status(e.status||503).json({message:e.status?e.message:'Venue service unavailable. Please retry.'});}}];
 const customerView=row=>{const {eventLinks,...v}=view(row);return v;};
 app.get('/api/venue-map/configuration',...guard(async(_req,res)=>res.json({searchConfigured:!!env.VENUE_SEARCH_API_KEY,searchProvider:env.VENUE_SEARCH_PROVIDER||'geoapify'}),requireAuth));
 app.get('/api/venue-map/venues',...guard(async(req,res)=>{const rows=await model.find(listQuery(req.query)).sort({name:1,_id:1}).limit(301).lean();res.json({items:rows.slice(0,300).map(customerView),truncated:rows.length>300});},requireAuth));
 app.get('/api/venue-map/venues/:id',...guard(async(req,res)=>{if(!/^[a-f\d]{24}$/i.test(req.params.id))return res.status(404).end();const row=await model.findById(req.params.id).lean();if(!row)return res.status(404).json({message:'Venue not found.'});const own=await ServiceRequest.find({userId:req.authUser._id,'order.event.venue.recordId':req.params.id}).select('_id').limit(100).lean();const links=[...row.eventLinks,...own.map(v=>({kind:'service_request',id:String(v._id)}))];const events=await eventViews([...new Map(links.map(l=>[l.kind+l.id,l])).values()],req.authUser);res.json({item:customerView(row),events});},requireAuth));
 app.get(base+'/configuration',...guard(async(_req,res)=>res.json({searchConfigured:!!env.VENUE_SEARCH_API_KEY,searchProvider:env.VENUE_SEARCH_PROVIDER||'geoapify',searchAttribution:'Powered by Geoapify · © OpenStreetMap contributors'})));
 app.get(base+'/venues',...guard(async(req,res)=>{const items=await model.find(listQuery(req.query)).sort({name:1,_id:1}).limit(301).lean();res.json({items:items.slice(0,300).map(view),truncated:items.length>300});}));
 app.get(base+'/events',...guard(async(req,res)=>{const q=String(req.query.q||'').trim().slice(0,100).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const rows=[];for(const [kind,m] of Object.entries(eventModels)){const filter=q?{$or:(kind==='booking'?['reference','eventType','venueName']:['requestNumber','event.eventType','event.venueName']).map(k=>({[k]:{$regex:q,$options:'i'}}))}:{};const items=await m.find(filter).sort({createdAt:-1}).limit(30).select('_id').lean();rows.push(...await eventViews(items.map(v=>({kind,id:String(v._id)}))));}res.json({items:rows});}));
 app.get(base+'/venues/:id',...guard(async(req,res)=>{if(!/^[a-f\d]{24}$/i.test(req.params.id))return res.status(404).end();const item=await model.findById(req.params.id).lean();if(!item)return res.status(404).json({message:'Venue not found.'});const associated=await ServiceRequest.find({'order.event.venue.recordId':req.params.id}).select('_id').limit(100).lean();const links=[...item.eventLinks,...associated.map(v=>({kind:'service_request',id:String(v._id)}))];res.json({item:view(item),events:await eventViews([...new Map(links.map(l=>[l.kind+l.id,l])).values()])});}));
 const save=async(req,res)=>{const parsed=venueInput.safeParse(req.body);if(!parsed.success)return res.status(400).json({message:parsed.error.issues.map(x=>x.message).join(' ')});const {latitude,longitude,version,...data}=parsed.data;
  if(req.params.id&&!/^[a-f\d]{24}$/i.test(req.params.id))return res.status(404).end();
  if(req.params.id&&!version)return res.status(400).json({message:'Reload the current version before editing.'});
  for(const l of data.eventLinks)if(!await eventModels[l.kind].exists({_id:l.id}))return res.status(400).json({message:'An event no longer exists. Reload the event list.'});
  data.location={type:'Point',coordinates:[longitude,latitude]};const item=req.params.id?await model.findOneAndUpdate({_id:req.params.id,version},{$set:data,$inc:{version:1}},{returnDocument:'after',runValidators:true}):await model.create(data);
  if(!item)return res.status(409).json({message:'Venue changed or was removed. Reload before editing.'});res.status(req.params.id?200:201).json({item:view(item)});
 };
 app.post(base+'/venues',...guard(save));app.put(base+'/venues/:id',...guard(save));
 const search=async(req,res)=>{
  if((env.VENUE_SEARCH_PROVIDER||'geoapify')!=='geoapify'||!env.VENUE_SEARCH_API_KEY)return res.status(503).json({message:'Place search needs a server-side Geoapify key.'});
  const q=z.string().trim().min(3).max(160).safeParse(req.query.q);if(!q.success)return res.status(400).json({message:'Enter 3–160 characters.'});const bounds=parseBounds(req.query.bounds);
  const now=Date.now();for(const [k,b]of buckets)if(b.until<now)buckets.delete(k);const owner=String(req.authUser?._id||req.user?._id||req.ip),b=buckets.get(owner)||{count:0,until:now+60000};if(b.count>=10||active>=2||buckets.size>1000)return res.status(429).json({message:'Search limit reached. Please wait a minute.'});b.count++;buckets.set(owner,b);
  active++;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);const closed=()=>controller.abort();res.on('close',closed);
  try{
   const request=async(path,params)=>{const url=new URL(path,'https://api.geoapify.com');url.search=new URLSearchParams({...params,filter:'rect:'+bounds.join(','),apiKey:env.VENUE_SEARCH_API_KEY}).toString();const upstream=await fetchImpl(url,{signal:controller.signal,redirect:'error'});if(!upstream.ok)throw new Error('Provider failure');const raw=await upstream.text();if(raw.length>500000)throw new Error('Oversized response');return JSON.parse(raw);};
   // Geocoding alone misses many businesses. Search named POIs first, with a
   // bounded partial-name retry, then retain address/city lookup as a fallback.
   const words=searchWords(q.data),name=words.join(' '),partial=words[0]?.length>4?words[0].replace(/s$/,''):words[0],categories='catering,accommodation,activity,entertainment,leisure,tourism';
   let rows=[];
   const places=async(term)=>{const data=await request('/v2/places',{name:term,categories,limit:'30'});if(!Array.isArray(data.features))throw new Error('Invalid response');return data.features.map(f=>f.properties).filter(Boolean);};
   const addressQuery=/^\d+\s/.test(q.data);
   if(!addressQuery&&name){rows=await places(name);if(!rows.length&&partial!==name)rows=await places(partial);}
   if(!rows.length){const data=await request('/v1/geocode/search',{text:q.data,limit:'10',format:'json'});if(!Array.isArray(data.results))throw new Error('Invalid response');rows=data.results;if(!rows.length&&!addressQuery&&partial&&partial!==q.data.toLowerCase()){const relaxed=await request('/v1/geocode/autocomplete',{text:partial,limit:'10',format:'json'});if(!Array.isArray(relaxed.results))throw new Error('Invalid response');rows=relaxed.results;}}
   const score=p=>{const title=searchWords(p.name||p.address_line1||'').join(' ');return words.reduce((n,w)=>n+(title.includes(w)?10:0),0)+(title===name?20:0);};
   const items=rows.filter(p=>typeof p.place_id==='string'&&p.place_id.length>0&&Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&p.lat>=bounds[1]&&p.lat<=bounds[3]&&p.lon>=bounds[0]&&p.lon<=bounds[2]).sort((a,b)=>score(b)-score(a)).slice(0,10).map(p=>({name:String(p.name||p.address_line1||p.formatted||'Venue').slice(0,240),address:String(p.formatted||'').slice(0,500),city:String(p.city||'').slice(0,160),postalCode:String(p.postcode||'').slice(0,12),country:String(p.country||'').slice(0,80),latitude:p.lat,longitude:p.lon,venueType:(p.categories||[p.category]).some(c=>c?.startsWith('catering.restaurant'))?'restaurant':'other',source:'geoapify',sourceId:String(p.place_id).slice(0,500),sourceAttribution:'Powered by Geoapify · '+String(p.datasource?.attribution||'© OpenStreetMap contributors').slice(0,1000),verificationStatus:'unverified',lastVerifiedAt:null,rooms:[],eventLinks:[],saved:false}));res.json({items,attribution:'Powered by Geoapify · © OpenStreetMap contributors'});

  }finally{active--;clearTimeout(timer);res.off('close',closed);}
 };
 app.get(base+'/search',...guard(search));
 app.get('/api/venue-map/search',...guard(search,requireAuth));
}
module.exports={registerVenueMap,venueInput,listQuery,parseBounds,searchWords};
