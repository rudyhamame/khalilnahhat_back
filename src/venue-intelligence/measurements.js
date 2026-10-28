const CATEGORIES=['building_footprint','total_building_floor','venue_gross','venue_usable','event_hall','seating','stage','dance_floor','circulation'];
const norm=value=>String(value||'').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const round=n=>Math.round(n*100)/100;
function areaM2(value,unit){if(!Number.isFinite(value)||value<=0)throw new Error('Area must be positive.');if(['m2','sqm','m²'].includes(unit))return round(value);if(['ft2','sqft','ft²'].includes(unit))return round(value*.09290304);throw new Error('Unsupported area unit.');}
function lengthM(value,unit){if(!Number.isFinite(value)||value<=0)throw new Error('Length must be positive.');if(unit==='m')return value;if(unit==='ft')return value*.3048;throw new Error('Unsupported length unit.');}
const inside=(p,ring)=>{let hit=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++)if((ring[i][1]>p[1])!==(ring[j][1]>p[1])&&p[0]<(ring[j][0]-ring[i][0])*(p[1]-ring[i][1])/(ring[j][1]-ring[i][1])+ring[i][0])hit=!hit;return hit;};
function polygonMetrics(coordinates){
 if(!Array.isArray(coordinates)||!coordinates.length||coordinates.length>30)throw new Error('A polygon is required.');
 for(const ring of coordinates){if(!Array.isArray(ring)||ring.length<4||ring.length>2000||!ring.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&Math.abs(p[0])<=180&&Math.abs(p[1])<85)||ring[0].some((v,i)=>v!==ring.at(-1)[i]))throw new Error('Invalid closed polygon.');}
 const origin=coordinates[0][0],r=6371008.8,lat=origin[1]*Math.PI/180;
 const local=coordinates.map(ring=>ring.map(([lon,y])=>[(lon-origin[0])*Math.PI/180*r*Math.cos(lat),(y-origin[1])*Math.PI/180*r]));
 const xs=local[0].map(p=>p[0]),ys=local[0].map(p=>p[1]);const width=Math.max(...xs)-Math.min(...xs),depth=Math.max(...ys)-Math.min(...ys);
 if(Math.max(width,depth)>2000||Math.min(width,depth)<.1)throw new Error('Polygon is outside building scale.');
 const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
 for(const ring of local)for(let i=0;i<ring.length-1;i++)for(let j=i+2;j<ring.length-1;j++){if(i===0&&j===ring.length-2)continue;const a=ring[i],b=ring[i+1],c=ring[j],d=ring[j+1];if(cross(a,b,c)*cross(a,b,d)<=0&&cross(c,d,a)*cross(c,d,b)<=0)throw new Error('Self-intersecting polygon.');}
 for(const hole of local.slice(1))if(!hole.slice(0,-1).every(p=>inside(p,local[0])))throw new Error('Polygon hole is outside its boundary.');
 const signed=ring=>Math.abs(ring.slice(0,-1).reduce((sum,p,i)=>sum+p[0]*ring[i+1][1]-ring[i+1][0]*p[1],0))/2;
 const area=signed(local[0])-local.slice(1).reduce((sum,ring)=>sum+signed(ring),0);
 if(area<=0)throw new Error('Invalid polygon area.');
 const perimeter=local.reduce((total,ring)=>total+ring.slice(0,-1).reduce((sum,p,i)=>sum+Math.hypot(p[0]-ring[i+1][0],p[1]-ring[i+1][1]),0),0);
 const cx=(Math.max(...xs)+Math.min(...xs))/2,cy=(Math.max(...ys)+Math.min(...ys))/2;
 return {areaM2:round(area),areaFt2:round(area/.09290304),perimeterM:round(perimeter),widthM:round(width),depthM:round(depth),localCoordinates:local.map(ring=>ring.map(([x,y])=>[round(x-cx),round(cy-y)])),projection:{type:'local_equirectangular',origin,units:'m',x:'east',z:'south'}};
}
function addressMatches(text,address){const words=norm(address).split(' '),number=words.find(w=>/^\d+[a-z]?$/.test(w)),street=words.slice(words.indexOf(number)+1).filter(w=>!['east','west','north','south','avenue','ave','road','rd','street','st','unit','suite'].includes(w));const hay=norm(text);return Boolean(number&&street.length&&new RegExp(`(?:^| )${number}(?: |$)`).test(hay)&&street.slice(0,1).every(w=>hay.includes(w)));}
function evidenceFromExtraction(row,sources,venue){
 const source=sources.find(s=>s.id===row.sourceId);if(!source||!CATEGORIES.includes(row.category))return null;
 const quote=String(row.quote||'').trim(),identityQuote=String(row.identityQuote||'').trim(),scope=String(row.space||'').trim();
 if(!quote||quote.length>600||!source.text.includes(quote)||!identityQuote||!source.text.includes(identityQuote)||!addressMatches(identityQuote,venue.address))return null;
 const nameWords=norm(venue.name).split(' ').filter(w=>w.length>2);if(!nameWords.length||!nameWords.some(w=>norm(source.text).includes(w)))return null;
 const categoryWords={building_footprint:/building|footprint/i,total_building_floor:/building|total floor/i,venue_gross:/gross|leased|tenant|premises|unit|suite/i,venue_usable:/usable|net (?:floor|area)|usable indoor/i,event_hall:/hall|ballroom|event (?:space|room|area)|banquet|function room/i,seating:/seating|dining/i,stage:/stage/i,dance_floor:/dance/i,circulation:/circulation|corridor/i};
 if(!categoryWords[row.category]?.test(quote))return null;
 if(!scope||row.spaceMatch!==true||row.current!==true||!['official','property'].includes(source.kind))return null;
 if(venue.room&&!norm(scope+' '+quote).includes(norm(venue.room)))return null;
 if(venue.unit&&!norm(identityQuote+' '+scope).includes(norm(venue.unit)))return null;
 if(venue.floor&&!norm(identityQuote+' '+scope).includes(norm(venue.floor)))return null;
 const numbers=quote.match(/\d[\d,]*(?:\.\d+)?/g)?.map(n=>Number(n.replaceAll(',','')))||[];
 const fields=['value','width','depth'].filter(k=>row[k]!==null&&row[k]!==undefined);if(!fields.length||!fields.every(k=>Number.isFinite(row[k])&&row[k]>0&&numbers.includes(row[k])))return null;
 const unit=row.unit;const unitText=quote.toLowerCase();if(!({m2:/m²|m2|sq\.?\s*m|square\s*met/,ft2:/ft²|ft2|sq\.?\s*ft|square\s*f(?:ee|oo)t/,m:/\bmet(?:re|er)s?\b|\bm\b/,ft:/\bfeet\b|\bfoot\b|\bft\b/}[unit]?.test(unitText)))return null;
 let valueM2,widthM=null,depthM=null;try{if(row.method==='explicit_dimensions'){widthM=lengthM(row.width,unit);depthM=lengthM(row.depth,unit);valueM2=round(widthM*depthM);}else if(row.method==='published_area')valueM2=areaM2(row.value,unit);else return null;}catch{return null;}
 if(valueM2>100000)return null;
 // Undated or historical property listings cannot establish the current tenant's area.
 const publishedAt=row.publishedAt&&/^\d{4}-\d{2}-\d{2}$/.test(row.publishedAt)&&source.text.includes(row.publishedAt)?row.publishedAt:null;
 if(source.kind==='property'&&(!publishedAt||Date.now()-Date.parse(publishedAt)>3*365.25*86400000))return null;
 return {id:require('node:crypto').randomUUID(),category:row.category,valueM2,widthM:widthM&&round(widthM),depthM:depthM&&round(depthM),unit:'m2',reported:{value:row.value??null,width:row.width??null,depth:row.depth??null,unit},space:scope,level:row.level||null,sourceId:source.id,sourceTitle:source.title,sourceUrl:source.url,publisher:source.publisher,publishedAt,retrievedAt:source.retrievedAt,quote,identityMatch:'address_and_name',buildingUnitMatch:'explicit_space',quality:source.kind,status:source.kind==='official'&&row.method==='explicit_dimensions'?'verified':'documented',method:row.method,assumptions:[],uncertainty:null};
}
function evaluateMeasurements(evidence){
 const measurements=Object.fromEntries(CATEGORIES.map(key=>[key,null])),conflicts=[];
 for(const category of CATEGORIES){const rows=evidence.filter(e=>e.category===category);if(!rows.length)continue;const spaces=new Map();for(const row of rows){const key=norm(row.space)+'|'+(row.level||'');spaces.set(key,[...(spaces.get(key)||[]),row]);}
  // Different rooms/floors are never added or averaged into a venue total.
  if(spaces.size>1){conflicts.push({category,reason:'Sources describe different rooms or floors. Select the specific space.',evidenceIds:rows.map(r=>r.id)});continue;}
  if(rows.some(a=>rows.some(b=>Math.abs(a.valueM2-b.valueM2)>Math.max(a.valueM2,b.valueM2)*.05))){conflicts.push({category,reason:'Published measurements disagree. No value has been selected.',evidenceIds:rows.map(r=>r.id)});continue;}
  measurements[category]=[...rows].sort((a,b)=>(a.status==='verified'?-1:1)-(b.status==='verified'?-1:1)||String(b.publishedAt||b.retrievedAt).localeCompare(String(a.publishedAt||a.retrievedAt)))[0];
 }
 return {measurements,conflicts};
}
function simulationAdapter(report){
 const m=report.measurements?.event_hall||report.measurements?.venue_usable;
 if(!m)return {readiness:'conceptual_only',level:'conceptual',boundary:null,widthM:null,depthM:null,reason:'The venue’s usable indoor boundary is unknown. A conceptual layout is fictional.'};
 if(m.widthM&&m.depthM)return {readiness:m.status==='verified'?'verified_scale':'estimated_scale',level:m.status==='verified'?'verified':'estimated',widthM:m.widthM,depthM:m.depthM,boundary:[[-m.widthM/2,-m.depthM/2],[m.widthM/2,-m.depthM/2],[m.widthM/2,m.depthM/2],[-m.widthM/2,m.depthM/2]],evidenceIds:[m.id],units:'m',reason:'Rectangle from published room dimensions. Architectural features remain unknown.'};
 return {readiness:'conceptual_only',level:'conceptual',boundary:null,widthM:null,depthM:null,documentedAreaM2:m.valueM2,reason:'Area is documented, but its boundary and dimensions are unknown. No room shape was inferred.'};
}
module.exports={CATEGORIES,areaM2,lengthM,polygonMetrics,inside,norm,addressMatches,evidenceFromExtraction,evaluateMeasurements,simulationAdapter};
