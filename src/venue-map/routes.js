const {z}=require('zod');
function searchWords(value){return String(value).normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[’‘']/g,"'").replace(/'s\b/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/).filter(w=>w&&w!=='the');}
function parseBounds(value){const a=String(value||'').split(',').map(Number);if(a.length!==4||!a.every(Number.isFinite)||a[0]<-180||a[2]>180||a[1]<-85||a[3]>85||a[0]>=a[2]||a[1]>=a[3])throw Object.assign(new Error('Use valid west,south,east,north bounds.'),{status:400});return a;}
// Geoapify's non-venue result kinds: a search for a venue must not answer with a city, region or street.
const NOT_VENUE=new Set(['country','state','county','city','postcode','suburb','district','locality','street']);
const isVenueResult=p=>!NOT_VENUE.has(p.result_type);
const TYPE_CATEGORIES={restaurant:'catering.restaurant',banquet_hall:'activity.community_center,entertainment,accommodation.hotel',outdoor:'leisure.park,natural,beach',other:''};
function registerVenueMap(app,{requireAuth,env=process.env,fetchImpl=fetch}={}){
 const buckets=new Map();let active=0;
 const guard=fn=>[requireAuth,async(req,res)=>{res.set('Cache-Control','no-store');try{await fn(req,res);}catch(e){res.status(e.status||503).json({message:e.status?e.message:'Venue service unavailable. Please retry.'});}}];
 app.get('/api/venue-map/configuration',...guard(async(_req,res)=>res.json({searchConfigured:!!env.VENUE_SEARCH_API_KEY,searchProvider:env.VENUE_SEARCH_PROVIDER||'geoapify'})));
 const search=async(req,res)=>{
  if((env.VENUE_SEARCH_PROVIDER||'geoapify')!=='geoapify'||!env.VENUE_SEARCH_API_KEY)return res.status(503).json({message:'Place search needs a server-side Geoapify key.'});
  const q=z.string().trim().min(3).max(160).safeParse(req.query.q);if(!q.success)return res.status(400).json({message:'Enter 3–160 characters.'});const bounds=parseBounds(req.query.bounds);
  const now=Date.now();for(const [k,b]of buckets)if(b.until<now)buckets.delete(k);const owner=String(req.authUser?._id||req.user?._id||req.ip),b=buckets.get(owner)||{count:0,until:now+60000};if(b.count>=10||active>=2||buckets.size>1000)return res.status(429).json({message:'Search limit reached. Please wait a minute.'});b.count++;buckets.set(owner,b);
  active++;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);const closed=()=>controller.abort();res.on('close',closed);
  try{
   const worldwide=bounds[2]-bounds[0]>=359&&bounds[3]-bounds[1]>=160;
   const localArea=bounds[2]-bounds[0]<=10&&bounds[3]-bounds[1]<=10;
   const request=async(path,params)=>{const url=new URL(path,'https://api.geoapify.com');url.search=new URLSearchParams({...params,...(worldwide||params.filter?{}:{filter:'rect:'+bounds.join(',')}),apiKey:env.VENUE_SEARCH_API_KEY}).toString();const upstream=await fetchImpl(url,{signal:controller.signal,redirect:'error'});if(!upstream.ok){const status=upstream.status===429?429:503;throw Object.assign(new Error(upstream.status===429?'Venue search provider is busy. Please wait a minute and retry.':'Place search provider is unavailable. Please retry shortly.'),{status,upstreamStatus:upstream.status});}const raw=await upstream.text();if(raw.length>500000)throw new Error('Oversized response');return JSON.parse(raw);};
   // Geocoding alone misses many businesses. Search named POIs first, with a
   // bounded partial-name retry, then retain address/city lookup as a fallback.
   const words=searchWords(q.data),name=words.join(' '),partial=words[0]?.length>4?words[0].replace(/s$/,''):words[0],categories='catering,accommodation,activity,entertainment,leisure,tourism';
   let rows=[],cityType=null;
   const parsedType=z.enum(Object.keys(TYPE_CATEGORIES)).safeParse(req.query.type),venueType=parsedType.success?parsedType.data:'other';
   const places=async(term)=>{const data=await request('/v2/places',{name:term,categories,limit:'30'});if(!Array.isArray(data.features))throw new Error('Invalid response');return data.features.map(f=>f.properties).filter(Boolean);};
   const addressQuery=/^\d+\s/.test(q.data);
   if(!addressQuery&&name&&localArea){try{rows=await places(name);if(!rows.length&&partial!==name)rows=await places(partial);}catch(e){if(![400,404,422].includes(e.upstreamStatus))throw e;}}
   if(!rows.length){const data=await request('/v1/geocode/search',{text:q.data,limit:'10',format:'json'});if(!Array.isArray(data.results))throw new Error('Invalid response');// The search always returns venues: when the answer is a city, list that city's venues (of the chosen type, else any venue type).
   const cityHit=!addressQuery&&data.results.find(p=>p.result_type==='city'&&p.place_id&&searchWords(p.city||p.name||'').length&&searchWords(p.city||p.name||'').every(w=>words.includes(w)));
   if(cityHit){const found=await request('/v2/places',{categories:venueType==='other'?categories:TYPE_CATEGORIES[venueType],filter:'place:'+cityHit.place_id,bias:`proximity:${cityHit.lon},${cityHit.lat}`,limit:'30'});if(!Array.isArray(found.features))throw new Error('Invalid response');rows=found.features.map(f=>f.properties).filter(Boolean);cityType=venueType;}
   else rows=data.results.filter(isVenueResult);if(!rows.length&&!cityType&&!addressQuery&&words.length===1&&!/[’‘']/.test(q.data)&&/s$/i.test(q.data)){const possessive=await request('/v1/geocode/search',{text:q.data.replace(/s$/i,"'s"),limit:'10',format:'json'});if(!Array.isArray(possessive.results))throw new Error('Invalid response');rows=possessive.results.filter(isVenueResult);}if(!rows.length&&!addressQuery&&partial&&partial!==q.data.toLowerCase()){const relaxed=await request('/v1/geocode/autocomplete',{text:partial,type:'amenity',limit:'10',format:'json'});if(!Array.isArray(relaxed.results))throw new Error('Invalid response');rows=relaxed.results.filter(isVenueResult);}}
   const score=p=>{const title=searchWords(p.name||p.address_line1||'').join(' ');return words.reduce((n,w)=>n+(title.includes(w)?10:0),0)+(title===name?20:0);};
   const items=rows.filter(p=>typeof p.place_id==='string'&&p.place_id.length>0&&Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&p.lat>=bounds[1]&&p.lat<=bounds[3]&&p.lon>=bounds[0]&&p.lon<=bounds[2]).sort((a,b)=>score(b)-score(a)).slice(0,10).map(p=>({name:String(p.name||p.address_line1||p.formatted||'Venue').slice(0,240),address:String(p.formatted||'').slice(0,500),city:String(p.city||'').slice(0,160),postalCode:String(p.postcode||'').slice(0,12),country:String(p.country||'').slice(0,80),latitude:p.lat,longitude:p.lon,venueType:cityType||((p.categories||[p.category]).some(c=>c?.startsWith('catering.restaurant'))?'restaurant':'other'),source:'geoapify',sourceId:String(p.place_id).slice(0,500),sourceAttribution:'Powered by Geoapify · '+String(p.datasource?.attribution||'© OpenStreetMap contributors').slice(0,1000),verificationStatus:'unverified',lastVerifiedAt:null}));res.json({items,attribution:'Powered by Geoapify · © OpenStreetMap contributors'});

  }catch(e){if(controller.signal.aborted||['AbortError','TimeoutError'].includes(e.name))throw Object.assign(new Error('Venue search timed out. Try adding a city or choosing a smaller search area.'),{status:504});throw e;}finally{active--;clearTimeout(timer);res.off('close',closed);}
 };
 app.get('/api/venue-map/search',...guard(search));
}
module.exports={registerVenueMap,parseBounds,searchWords};
