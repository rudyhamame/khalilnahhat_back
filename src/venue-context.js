const crypto=require('node:crypto');
const {z}=require('zod');
const input=z.object({address:z.string().trim().min(8).max(500)});
const distance=(a,b)=>Math.hypot((a[0]-b[0])*111320*Math.cos(b[1]*Math.PI/180),(a[1]-b[1])*111320);
const inside=(point,polygon)=>{let c=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++)if((polygon[i][1]>point[1])!==(polygon[j][1]>point[1])&&point[0]<(polygon[j][0]-polygon[i][0])*(point[1]-polygon[i][1])/(polygon[j][1]-polygon[i][1])+polygon[i][0])c=!c;return c;};
function venueView(row){
 const lat=Number(row.lat),lon=Number(row.lon);if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)throw new Error('Invalid map result');
 let outline=row.geojson?.type==='Polygon'?row.geojson.coordinates?.[0]:null;
 if(!Array.isArray(outline)||outline.length<4||outline.length>2000||!outline.every(p=>Array.isArray(p)&&p.length>=2&&p.every(Number.isFinite))||!outline.every(p=>distance(p,[lon,lat])<350)||!['building','amenity','leisure','tourism'].includes(row.class||row.category))outline=null;
 const a=row.address||{};return {label:String(row.display_name||'').slice(0,700),latitude:lat,longitude:lon,area:[a.neighbourhood,a.suburb,a.city||a.town||a.village,a.state,a.country].filter(Boolean).join(', '),type:String(row.type||'unknown').slice(0,80),outline: outline?.map(p=>p.slice(0,2))||null,rooms:[],sourceUrl:`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`,floorPlanVerified:false};
}
function createVenueContext({fetchImpl=fetch,now=Date.now}={}){
 const cache=new Map(),buckets=new Map();let nextLookup=0;
 const lookup=async(owner,address)=>{
  for(const [key,value]of cache)if(value.expires<now())cache.delete(key);for(const [key,value]of buckets)if(value.until<now())buckets.delete(key);
  const digest=crypto.createHash('sha256').update(owner+'|'+address.toLowerCase().trim()).digest('hex');const cached=[...cache.values()].find(value=>value.digest===digest);if(cached)return {id:cached.id,...cached.data};
  const bucket=buckets.get(owner)||{count:0,until:now()+60000};if(bucket.count>=5||buckets.size>1000||now()<nextLookup)throw Object.assign(new Error('Please wait a moment before another venue lookup.'),{status:429});bucket.count++;buckets.set(owner,bucket);nextLookup=now()+1100;
  const url=new URL('https://nominatim.openstreetmap.org/search');url.search=new URLSearchParams({q:address,format:'jsonv2',addressdetails:'1',polygon_geojson:'1',limit:'1'}).toString();
  const response=await fetchImpl(url,{headers:{'User-Agent':'EchoEventPlanner/1.0 (https://echo-khalil.onrender.com)','Accept-Language':'en'},signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('Map lookup unavailable');const rows=await response.json();if(!Array.isArray(rows)||!rows[0])throw Object.assign(new Error('No venue match found. Check the full address.'),{status:404});const data=venueView(rows[0]);
  if(data.outline){try{const lats=data.outline.map(p=>p[1]),lons=data.outline.map(p=>p[0]);const bbox=[Math.min(...lats),Math.min(...lons),Math.max(...lats),Math.max(...lons)].join(',');const query=`[out:json][timeout:8];way["indoor"~"^(room|corridor)$"](${bbox});out tags geom 80;`;const r=await fetchImpl('https://overpass-api.de/api/interpreter',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':'EchoEventPlanner/1.0 (https://echo-khalil.onrender.com)'},body:new URLSearchParams({data:query}).toString(),signal:AbortSignal.timeout(10000)});if(r.ok){const value=await r.json();data.rooms=(value.elements||[]).slice(0,80).filter(item=>item.geometry?.length>=4&&item.geometry.length<500).map(item=>({name:String(item.tags?.name||item.tags?.indoor||'Mapped room').slice(0,100),level:String(item.tags?.level||'?').slice(0,12),points:item.geometry.map(p=>[p.lon,p.lat])})).filter(item=>item.points.every(p=>p.every(Number.isFinite))&&inside(item.points[0],data.outline));}}catch{/* Public indoor map details are optional. */}}
  if(cache.size>=100)cache.delete(cache.keys().next().value);const id=crypto.randomUUID();cache.set(id,{id,owner,digest,data,expires:now()+900000});return {id,...data};
 };
 return {lookup,forAdvice:(owner,id)=>{const row=cache.get(id);return row&&row.owner===owner&&row.expires>now()?{area:row.data.area,placeType:row.data.type,publicBuildingOutlineAvailable:!!row.data.outline,publicIndoorRooms:row.data.rooms.map(({name,level})=>({name,level})),floorPlanVerified:false,sourceUrl:row.data.sourceUrl}:null;}};
}
function registerVenueContext(app,{requireAuth,identity,service}){app.post('/api/ai-booking/venue-context',requireAuth,async(req,res)=>{const parsed=input.safeParse(req.body);if(!parsed.success)return res.status(400).json({message:'Enter the full venue address in your event draft first.'});try{res.set('Cache-Control','no-store');res.json(await service.lookup(identity(req),parsed.data.address));}catch(error){res.status([404,429].includes(error.status)?error.status:503).json({message:error.status?error.message:'Public venue maps are unavailable. Your adjustable concept room is still available.'});}});}
module.exports={createVenueContext,registerVenueContext,venueView};
