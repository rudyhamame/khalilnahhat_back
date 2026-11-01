const {test}=require('node:test');const assert=require('node:assert/strict');
const {searchWords}=require('../src/venue-map/routes');
test('business-name search supports articles, apostrophes, partial names and address fallback',async()=>{
 assert.deepEqual(searchWords(' THE Kég '),['keg']);assert.deepEqual(searchWords('Lara’s'),['lara']);
 const express=require('express'),local=express(),calls=[];
 const poi={name:"Lara's Restaurant",formatted:'155 Consumers Rd, Toronto',lat:43.77,lon:-79.33,place_id:'lara',categories:['catering.restaurant']};
 const guard=(req,res,next)=>{req.authUser={_id:'qa-flexible'};next();};
 require('../src/venue-map/routes').registerVenueMap(local,{requireAdmin:guard,requireAuth:guard,env:{VENUE_SEARCH_API_KEY:'fixture-secret'},fetchImpl:async url=>{
  calls.push({path:url.pathname,name:url.searchParams.get('name'),text:url.searchParams.get('text')});
  assert.equal(url.searchParams.get('filter'),'rect:-80,43,-79,44');
  if(url.pathname==='/v2/places')return new Response(JSON.stringify({features: url.searchParams.get('name')==='lara'?[{properties:poi},{properties:{...poi,place_id:'outside',lon:-85}}]:url.searchParams.get('name')==='keg'?[{properties:{...poi,name:'The Keg Steakhouse',place_id:'keg'}}]:[]}));
  if(url.pathname==='/v1/geocode/autocomplete'){assert.equal(url.searchParams.get('type'),'amenity');return new Response(JSON.stringify({results:[{...poi,name:'Remo Restaurant',place_id:'remo'}]}));}
  if(url.searchParams.get('text')==="Dino's")return new Response(JSON.stringify({results:[{...poi,name:"Dino's Restaurant",place_id:'dino'}]}));
  return new Response(JSON.stringify({results:['Remos',"Remo's",'Dinos'].includes(url.searchParams.get('text'))?[]:[{...poi,name:'Address result',place_id:'address'}]}));
 }});
 const server=local.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const run=async q=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/api/venue-map/search?`+new URLSearchParams({q,bounds:'-80,43,-79,44'}));assert.equal(res.status,200);return (await res.json()).items;};
  assert.equal((await run('The Keg'))[0].name,'The Keg Steakhouse');
  const lara=await run('Lara’s');assert.equal(lara.length,1);assert.equal(lara[0].venueType,'restaurant');assert.equal('saved' in lara[0],false);assert.equal('eventLinks' in lara[0],false);assert.equal((await run('Laras'))[0].name,poi.name);
  assert.equal((await run('Lara private banquet'))[0].name,poi.name);assert.equal(calls.at(-1).name,'lara');
  const before=calls.length;assert.equal((await run('155 Consumers Road'))[0].name,'Address result');assert.equal(calls.length,before+1);assert.equal(calls.at(-1).path,'/v1/geocode/search');
  assert.equal((await run('Dinos'))[0].name,"Dino's Restaurant");assert.equal(calls.at(-1).text,"Dino's");
  assert.equal((await run('Remos'))[0].name,'Remo Restaurant');assert.equal(calls.at(-1).path,'/v1/geocode/autocomplete');assert.equal(calls.at(-1).text,'remo');
  assert.equal((await run('unknown'))[0].name,'Address result');assert.equal(calls.at(-1).path,'/v1/geocode/search');
 }finally{await new Promise(r=>server.close(r));}
});

test('worldwide venue search avoids a world POI rectangle and handles provider failures',async()=>{
 const express=require('express'),local=express();let mode='world',calls=[];
 const guard=(req,res,next)=>{req.authUser={_id:'qa-global'};next();};
 const result={name:'Rawabi Cafe',formatted:'Hamilton, Ontario, Canada',place_id:'qa-rawabi',lat:43.25,lon:-79.87};
 require('../src/venue-map/routes').registerVenueMap(local,{requireAdmin:guard,requireAuth:guard,env:{VENUE_SEARCH_API_KEY:'fixture-private'},fetchImpl:async url=>{
  calls.push(url.pathname);
  if(mode==='world'){assert.equal(url.pathname,'/v1/geocode/search');assert.equal(url.searchParams.has('filter'),false);return new Response(JSON.stringify({results:[result]}));}
  if(mode==='area'){assert.equal(url.searchParams.get('filter'),'rect:-80,43,-79,44');return url.pathname==='/v2/places'?new Response('{}',{status:400}):new Response(JSON.stringify({results:[result]}));}
  if(mode==='quota')return new Response('{}',{status:429});
  throw Object.assign(new Error('provider deadline'),{name:'TimeoutError'});
 }});
 const server=local.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const run=async bounds=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/venue-map/search?`+new URLSearchParams({q:'Rawabi cafe Hamilton',bounds}));return {status:response.status,body:await response.json()};};
  let r=await run('-180,-85,180,85');assert.equal(r.status,200);assert.equal(r.body.items[0].name,'Rawabi Cafe');assert.deepEqual(calls,['/v1/geocode/search']);
  mode='area';calls=[];r=await run('-80,43,-79,44');assert.equal(r.status,200);assert.equal(r.body.items[0].name,'Rawabi Cafe');assert.deepEqual(calls,['/v2/places','/v1/geocode/search']);
  mode='quota';r=await run('-180,-85,180,85');assert.equal(r.status,429);assert.match(r.body.message,/busy|limit/i);
  mode='timeout';r=await run('-180,-85,180,85');assert.equal(r.status,504);assert.match(r.body.message,/timed out/i);assert.ok(!JSON.stringify(r).includes('fixture-private'));
 }finally{await new Promise(r=>server.close(r));}
});

test('venue directory endpoints are absent and search stays authenticated',async()=>{
 const express=require('express'),app=express();let calls=0;
 const guard=(req,res,next)=>req.headers.authorization==='Bearer qa'?(req.authUser={_id:'qa'},next()):res.status(401).end();
 require('../src/venue-map/routes').registerVenueMap(app,{requireAuth:guard,env:{VENUE_SEARCH_API_KEY:'fixture'},fetchImpl:async()=>{calls++;return new Response(JSON.stringify({results:[]}));}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}/api`;
 try{for(const [path,method]of [['/venue-map/venues','GET'],['/venue-map/venues/507f1f77bcf86cd799439011','GET'],['/admin/venue-map/venues','GET'],['/admin/venue-map/venues','POST'],['/admin/venue-map/events','GET']])assert.equal((await fetch(base+path,{method,headers:{Authorization:'Bearer qa'}})).status,404);
  assert.equal((await fetch(base+'/venue-map/search?q=Toronto&bounds=-180,-85,180,85')).status,401);assert.equal(calls,0);
  for(let i=0;i<11;i++)assert.equal((await fetch(base+'/venue-map/search?q=Toronto&bounds=-180,-85,180,85',{headers:{Authorization:'Bearer qa'}})).status,i<10?200:429);
  assert.equal(calls,10);
 }finally{await new Promise(r=>server.close(r));}
});

test('searching a city name lists that city\'s venues, never the city itself',async()=>{
 const express=require('express'),local=express(),calls=[];
 const guard=(req,res,next)=>{req.authUser={_id:'qa-city'};next();};
 const city={name:'Toronto',city:'Toronto',result_type:'city',lat:43.65,lon:-79.38,place_id:'city-toronto',formatted:'Toronto, ON, Canada'};
 const venue={name:'Banquet Palace',formatted:'1 Hall Rd, Toronto, ON, Canada',city:'Toronto',country:'Canada',lat:43.7,lon:-79.4,place_id:'hall-1',categories:['entertainment']};
 require('../src/venue-map/routes').registerVenueMap(local,{requireAdmin:guard,requireAuth:guard,env:{VENUE_SEARCH_API_KEY:'fixture-secret'},fetchImpl:async url=>{
  calls.push({path:url.pathname,categories:url.searchParams.get('categories'),filter:url.searchParams.get('filter')});
  if(url.pathname==='/v1/geocode/search')return new Response(JSON.stringify({results:[city]}));
  if(url.pathname==='/v2/places')return new Response(JSON.stringify({features:[{properties:venue}]}));
  throw new Error('unexpected '+url.pathname);
 }});
 const server=local.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const run=async params=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/api/venue-map/search?`+new URLSearchParams({q:'Toronto',bounds:'-95.2,41.6,-74.3,56.9',...params}));assert.equal(res.status,200);return (await res.json()).items;};
  let items=await run({type:'banquet_hall'});
  assert.deepEqual(items.map(item=>item.name),['Banquet Palace']);assert.equal(items[0].venueType,'banquet_hall');
  assert.equal(calls.at(-1).path,'/v2/places');assert.equal(calls.at(-1).filter,'place:city-toronto');assert.match(calls.at(-1).categories,/community_center/);
  items=await run({});assert.deepEqual(items.map(item=>item.name),['Banquet Palace']);assert.match(calls.at(-1).categories,/catering/,'no type chosen searches every venue category');
 }finally{await new Promise(r=>server.close(r));}
});
