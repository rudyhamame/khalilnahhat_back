const {polygonMetrics,inside,norm}=require('./measurements');
const agent='KhalilVenueResearch/1.0 (https://echo-khalil.onrender.com)';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function createProviders({env=process.env,fetchImpl=fetch}={}){
 let geocoderQueue=Promise.resolve(),lastGeocode=0;const geocodeCache=new Map();
 const geocode=async(name,address,refresh=false)=>{
  if(!env.VENUE_GEOCODER_URL)throw new Error('Configure VENUE_GEOCODER_URL with an authorized Nominatim-compatible geocoder.');
  const query=[name,address].filter(Boolean).join(', ');const cached=geocodeCache.get(query);if(!refresh&&cached&&cached.until>Date.now())return structuredClone(cached.items);
  const work=geocoderQueue.catch(()=>{}).then(async()=>{await wait(Math.max(0,1100-(Date.now()-lastGeocode)));lastGeocode=Date.now();const url=new URL(env.VENUE_GEOCODER_URL);url.search=new URLSearchParams({q:query,format:'jsonv2',addressdetails:'1',extratags:'1',limit:'5'});const response=await fetchImpl(url,{headers:{'User-Agent':agent},signal:AbortSignal.timeout(12000)});if(!response.ok)throw new Error('Venue identification service is unavailable.');const rows=await response.json();if(!Array.isArray(rows))throw new Error('Invalid identification response.');const candidates=rows.flatMap(row=>{const latitude=Number(row.lat),longitude=Number(row.lon);if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||Math.abs(latitude)>85||Math.abs(longitude)>180)return [];return [{id:`osm:${row.osm_type}:${row.osm_id}`,name:String(row.name||row.display_name||'').slice(0,240),address:String(row.display_name||'').slice(0,700),latitude,longitude,category:row.type||'unknown',website:row.extratags?.website||row.extratags?.['contact:website']||null,provider:'OpenStreetMap',sourceUrl:`https://www.openstreetmap.org/${row.osm_type}/${row.osm_id}`,attribution:'© OpenStreetMap contributors · ODbL'}];});const unique=[...new Map(candidates.map(c=>[c.id,c])).values()];if(geocodeCache.size>=100)geocodeCache.delete(geocodeCache.keys().next().value);geocodeCache.set(query,{items:unique,until:Date.now()+86400000});return unique;});geocoderQueue=work;return work;
 };
 const photon=async input=>{
  const endpoint=env.VENUE_PHOTON_URL||'https://photon.komoot.io/api/';
  const key='photon:'+JSON.stringify([input.name,input.address]);const cached=geocodeCache.get(key);
  if(!input.refresh&&cached&&cached.until>Date.now())return structuredClone(cached.items);
  const work=geocoderQueue.catch(()=>{}).then(async()=>{
   const queued=geocodeCache.get(key);if(!input.refresh&&queued&&queued.until>Date.now())return structuredClone(queued.items);
   const queries=[[input.name,input.address].filter(Boolean).join(', '),input.address];
   for(let index=0;index<queries.length;index++){
    await wait(Math.max(0,1100-(Date.now()-lastGeocode)));lastGeocode=Date.now();
    const url=new URL(endpoint);url.search=new URLSearchParams({q:queries[index],limit:'5',lang:'en'});
    const response=await fetchImpl(url,{headers:{'User-Agent':agent,Accept:'application/json'},signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw new Error(response.status===429?'Venue lookup is rate limited. Please retry shortly.':'The venue lookup provider is temporarily unavailable. Please retry.');
    const body=await response.json();if(!Array.isArray(body.features))throw new Error('The venue lookup provider returned an invalid response.');
    const candidates=body.features.flatMap(feature=>{
     const p=feature.properties||{},point=feature.geometry;
     const type=({N:'node',W:'way',R:'relation',node:'node',way:'way',relation:'relation'})[p.osm_type];
     if(point?.type!=='Point'||!Array.isArray(point.coordinates)||point.coordinates.length!==2||!point.coordinates.every(Number.isFinite)||!type||!/^\d+$/.test(String(p.osm_id)))return [];
     const [longitude,latitude]=point.coordinates;if(Math.abs(latitude)>85||Math.abs(longitude)>180)return [];
     const street=[p.housenumber,p.street].filter(Boolean).join(' ');
     const address=[street,p.district,p.city||p.town||p.village||p.county,p.postcode,p.state,p.country].filter(Boolean).join(', ');
     if(!address)return [];
     return [{id:`osm:${type}:${p.osm_id}`,name:String(p.name||street||address).slice(0,240),address:address.slice(0,700),latitude,longitude,category:String(p.osm_value||'unknown'),website:p.website||p['contact:website']||null,provider:'OpenStreetMap',lookupProvider:'Photon',matchType:index===0&&norm(input.name).split(' ').filter(word=>word.length>2).every(word=>norm(p.name).includes(word))?'name_and_location':'address_only',sourceUrl:`https://www.openstreetmap.org/${type}/${p.osm_id}`,attribution:'© OpenStreetMap contributors · ODbL · Search by Photon'}];
    });
    const unique=[...new Map(candidates.map(candidate=>[candidate.id,candidate])).values()];
    if(unique.length||index===queries.length-1){if(geocodeCache.size>=100)geocodeCache.delete(geocodeCache.keys().next().value);geocodeCache.set(key,{items:unique,until:Date.now()+86400000});return structuredClone(unique);}
   }
  });geocoderQueue=work;return work;
 };
 const identify=async input=>{
  if(env.VENUE_GEOCODER_URL)return geocode(input.name,input.address,input.refresh);
  // Places results are transient. Stored records retain only the place ID and user-entered identity.
  if(env.GOOGLE_PLACES_API_KEY){const response=await fetchImpl('https://places.googleapis.com/v1/places:searchText',{method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':env.GOOGLE_PLACES_API_KEY,'X-Goog-FieldMask':'places.id,places.displayName,places.formattedAddress,places.location,places.websiteUri,places.googleMapsUri'},body:JSON.stringify({textQuery:`${input.name}, ${input.address}`,pageSize:5}),signal:AbortSignal.timeout(12000)});if(!response.ok)throw new Error('Google Places identification failed. Check the server API key and Places API permission.');return ((await response.json()).places||[]).map(p=>({id:'google:'+p.id,placeId:p.id,name:p.displayName?.text,address:p.formattedAddress,latitude:p.location?.latitude,longitude:p.location?.longitude,website:p.websiteUri||null,provider:'Google Maps',sourceUrl:p.googleMapsUri||'https://maps.google.com',attribution:'Google Maps'}));}
  if(env.VENUE_PHOTON_URL||env.VENUE_DISABLE_PUBLIC_PHOTON!=='true')return photon(input);
  throw new Error('Venue identification is disabled. Configure VENUE_PHOTON_URL, VENUE_GEOCODER_URL or GOOGLE_PLACES_API_KEY on the API server.');
 };
 const discover=async(query)=>{if(!env.BRAVE_SEARCH_API_KEY)return [];const url=new URL('https://api.search.brave.com/res/v1/web/search');url.search=new URLSearchParams({q:query,count:'5',search_lang:'en'});const response=await fetchImpl(url,{headers:{'X-Subscription-Token':env.BRAVE_SEARCH_API_KEY,Accept:'application/json'},signal:AbortSignal.timeout(12000)});if(!response.ok)throw new Error('Web research search service is unavailable.');return ((await response.json()).web?.results||[]).map(row=>({url:row.url,title:row.title}));};
 const footprint=async candidate=>{
  if(candidate.provider==='Google Maps')return {status:'unavailable',reason:'An independently licensed building match is needed before storing geometry from this Google Places match.'};
  const url=env.VENUE_OVERPASS_URL||'https://overpass-api.de/api/interpreter';const {latitude:lat,longitude:lon}=candidate;
  const query=`[out:json][timeout:12];(way["building"](around:100,${lat},${lon});relation["building"]["type"="multipolygon"](around:100,${lat},${lon}););out body geom;`;
  const response=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':agent},body:new URLSearchParams({data:query}),signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('Building geometry service is unavailable.');const elements=(await response.json()).elements||[];const matches=[];
  for(const row of elements){if(!row.geometry)continue;const coordinates=[row.geometry.map(p=>[p.lon,p.lat])];if(!inside([lon,lat],coordinates[0]))continue;try{matches.push({geometry:{type:'Polygon',coordinates},...polygonMetrics(coordinates),sourceUrl:`https://www.openstreetmap.org/${row.type}/${row.id}`,buildingId:`osm:${row.type}:${row.id}`,attribution:'© OpenStreetMap contributors · ODbL',method:'Containing building polygon from public OSM geometry',status:'estimated',space:'building_only',buildingLevels:row.tags?.['building:levels']||null,multiTenant:row.tags?.['building:use']==='mixed_use'||Boolean(row.tags?.['addr:unit'])});}catch{/* Reject invalid or oversized polygons. */}}
  if(matches.length!==1)return {status:'unavailable',reason:matches.length?'Several building boundaries contain the venue point. A building match needs manual review.':'No valid containing building polygon was found. A nearby building was not assigned to the venue.'};return matches[0];
 };
 return {identify,discover,footprint,configuration:()=>({identification:{configured:!!(env.VENUE_GEOCODER_URL||env.GOOGLE_PLACES_API_KEY||env.VENUE_PHOTON_URL||env.VENUE_DISABLE_PUBLIC_PHOTON!=='true'),provider:env.VENUE_GEOCODER_URL?'Nominatim':env.GOOGLE_PLACES_API_KEY?'Google Places':'Photon',requirement:'Photon works without an API key for modest usage. An authorized VENUE_PHOTON_URL, VENUE_GEOCODER_URL or GOOGLE_PLACES_API_KEY can override the default.'},webSearch:{configured:!!env.BRAVE_SEARCH_API_KEY,requirement:'BRAVE_SEARCH_API_KEY for official and property source discovery'},satellite:{configured:!!(env.VENUE_SATELLITE_TILE_URL&&env.VENUE_SATELLITE_ATTRIBUTION),requirement:'VENUE_SATELLITE_TILE_URL and VENUE_SATELLITE_ATTRIBUTION from a licensed tile provider',attribution:env.VENUE_SATELLITE_ATTRIBUTION||null},imageAnalysis:{configured:false,requirement:'Uncalibrated photos and virtual tours are not used as measurement evidence; no calibrated image-analysis connector is configured.'},googleSolar:{configured:false,requirement:'Google Solar building geometry connector is not configured.'},municipalRecords:{configured:false,requirement:'No municipal GIS/permit connector is configured; these records will not be reported as searched.'}})};
}
module.exports={createProviders};
