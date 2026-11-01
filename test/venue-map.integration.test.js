const {test}=require('node:test');const assert=require('node:assert/strict');const mongoose=require('mongoose');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const net=require('node:net');const {spawn}=require('node:child_process');
const {venueInput,listQuery,parseBounds,searchWords}=require('../src/venue-map/routes');
const fixture={name:'QA Venue',address:'100 QA Street',city:'Toronto',latitude:43.7,longitude:-79.4,venueType:'banquet_hall',source:'manual',verificationStatus:'unverified',lastVerifiedAt:null,rooms:[],eventLinks:[]};
test('venue validation rejects invalid coordinates, guessed measurements and absent provenance',()=>{
 assert.equal(venueInput.safeParse(fixture).success,true);
 for(const patch of [{latitude:91},{longitude:181},{verificationStatus:'verified'},{source:'geoapify'},{rooms:[{name:'Hall',seatedCapacity:0}]},{rooms:[{name:'Hall',areaSqM:120,areaMethod:'building footprint',areaSource:'OSM'}]},{rooms:[{name:'Hall',areaSqM:120,areaMethod:'guest capacity',areaSource:'Guess'}]},{rooms:[{name:'Hall',standingCapacity:100}]}])assert.equal(venueInput.safeParse({...fixture,...patch}).success,false,JSON.stringify(patch));
 assert.throws(()=>parseBounds(',,,') );assert.throws(()=>parseBounds('-180,-90,180,90'));assert.throws(()=>listQuery({bounds:'-80,43,-79,44',capacity:'bad'}));
});
test('real Mongo venue CRUD, spatial discovery, owner privacy, event links and provider boundaries',{timeout:60000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'echo-venue-test-'));const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const mongo=spawn('mongod',['--bind_ip','127.0.0.1','--port',String(port),'--dbpath',dir,'--logpath',path.join(dir,'mongo.log')],{stdio:'ignore'});let server;
 t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await mongoose.disconnect();mongo.kill('SIGTERM');await new Promise(resolve=>mongo.exitCode!==null?resolve():mongo.once('exit',resolve));await fs.rm(dir,{recursive:true,force:true});});
 for(let i=0;i<50;i++){try{await mongoose.connect(`mongodb://127.0.0.1:${port}/venue_map_test`,{serverSelectionTimeoutMS:200});break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
 const {spawnSync}=require('node:child_process');for(let i=0;i<2;i++){const migrated=spawnSync(process.execPath,['scripts/venue-map-migrate.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,MONGODB_URI:`mongodb://127.0.0.1:${port}`,MONGODB_DB_NAME:'venue_map_test'},encoding:'utf8'});assert.equal(migrated.status,0,migrated.stderr);}
 const {app}=require('../src/server');const {User,ServiceRequest}=require('../src/models');const {Venue}=require('../src/venue-map/models');await Venue.init();const {ADMIN_USERNAME}=require('../src/default-data');
 const makeUser=(username,sessionToken)=>User.create({firstName:'QA',lastName:'Only',username,email:username+'@example.invalid',phoneNumber:'000000',passwordHash:'fixture',sessionToken});
 const admin=await makeUser(ADMIN_USERNAME,'qa-admin'),customer=await makeUser('venue-customer','qa-customer'),other=await makeUser('venue-other','qa-other');
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}/api`;
 const call=async(route,token='qa-admin',method='GET',body)=>{const r=await fetch(base+route,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json().catch(()=>null)};};
 let id;
 await t.test('anonymous denied and customer cannot create or edit directory',async()=>{assert.equal((await call('/venue-map/venues?bounds=-80,43,-79,44','')).status,401);assert.equal((await call('/admin/venue-map/venues','qa-customer','POST',fixture)).status,401);});
 await t.test('admin creates real venue; null room dimensions survive storage',async()=>{const r=await call('/admin/venue-map/venues','qa-admin','POST',{...fixture,rooms:[{name:'Main hall'}]});assert.equal(r.status,201,JSON.stringify(r));id=r.data.item.id;assert.equal(r.data.item.rooms[0].areaSqM,null);assert.equal(r.data.item.rooms[0].seatedCapacity,null);assert.deepEqual(r.data.item.location.coordinates,[-79.4,43.7]);});
 await t.test('bounds, literal name/city search and capacity filters',async()=>{assert.equal((await call('/venue-map/venues?bounds=-180,-85,180,85','qa-customer')).data.items.length,1);assert.equal((await call('/venue-map/venues?bounds=-80,43,-79,44&q=Toronto','qa-customer')).data.items.length,1);assert.equal((await call('/venue-map/venues?bounds=-78,43,-77,44','qa-customer')).data.items.length,0);assert.equal((await call('/venue-map/venues?bounds=-80,43,-79,44&capacity=known','qa-customer')).data.items.length,0);assert.equal((await call('/venue-map/venues?bounds=-80,43,-79,44&capacity=unknown','qa-customer')).data.items.length,1);assert.equal((await call('/venue-map/venues?bounds=-80,43,-79,44&q=%5B','qa-customer')).status,200);});
 await t.test('saved search accepts apostrophes, articles, partial names and reordered words',async()=>{
  const row=await Venue.create({...fixture,name:'Lara’s Restaurant',location:{type:'Point',coordinates:[-79.4,43.7]}});
  try{for(const q of ["lara's",'laras','THE LARA','restaurant lara','lar']){const result=await call('/venue-map/venues?'+new URLSearchParams({bounds:'-80,43,-79,44',q}),'qa-customer');assert.equal(result.status,200);assert.equal(result.data.items.length,1);assert.equal(result.data.items[0].id,String(row._id));}}finally{await Venue.deleteOne({_id:row._id});}
 });
 const request=await ServiceRequest.create({externalId:'qa-event',userId:customer._id,customerName:'QA',customerUsername:customer.username,customerEmail:customer.email,items:[],requestNumber:'QA-EVENT',event:{eventType:'Corporate',eventDate:'2027-01-02'},order:{event:{venue:{recordId:id}}}});
 await t.test('admin edit links an existing event and enforces optimistic version',async()=>{const r=await call('/admin/venue-map/venues/'+id,'qa-admin','PUT',{...fixture,rooms:[{name:'Main hall',seatedCapacity:200,capacitySource:'Venue manager, 2026-10-31',areaSqM:250,areaMethod:'Measured interior plan',areaSource:'Architect plan A1'}],eventLinks:[{kind:'service_request',id:String(request._id)}],version:1});assert.equal(r.status,200);assert.equal(r.data.item.version,2);assert.equal((await call('/admin/venue-map/venues/'+id,'qa-admin','PUT',{...fixture,version:1})).status,409);assert.equal((await call('/admin/venue-map/venues/'+id,'qa-customer','PUT',{...fixture,version:2})).status,401);assert.equal((await call('/admin/venue-map/venues/'+id)).data.events.length,1);});
 await t.test('customers see only their own events, never directory event IDs',async()=>{const own=await call('/venue-map/venues/'+id,'qa-customer'),stranger=await call('/venue-map/venues/'+id,'qa-other');assert.equal(own.data.events.length,1);assert.equal(stranger.data.events.length,0);assert.equal('eventLinks' in stranger.data.item,false);assert.equal('eventLinks' in (await call('/venue-map/venues?bounds=-80,43,-79,44','qa-other')).data.items[0],false);});
 await t.test('forged saved-venue coordinates are rejected before booking or notification writes',async()=>{
  const core=require('../src/event-order');let order=core.createEventOrder();const values={'customer.fullName':'QA Customer','customer.email':customer.email,'customer.phone':'4165550123','customer.contactMethod':'email','event.type':'wedding','event.date':'2099-06-20','event.startTime':'18:00','event.endTime':'23:00','event.guestCount':150,'event.venue.name':'QA Venue','event.venue.address':'100 QA Street','event.venue.city':'Toronto','event.venue.postalCode':'M1A 1A1','event.venue.area':'gta','event.venue.setting':'indoor','event.venue.recordId':id,'event.venue.latitude':44,'event.venue.longitude':-79.4,services:['dj']};for(const [k,v]of Object.entries(values))order=core.updateOrderField(order,k,v);
  const before=await ServiceRequest.countDocuments();const result=await call('/service-requests','qa-customer','POST',{order,items:[{serviceId:'svc-dj',name:'DJ',category:'service',quantity:1}]});assert.equal(result.status,400);assert.match(result.data.message,/selected venue changed/);assert.equal(await ServiceRequest.countDocuments(),before);
 });
 await t.test('missing external credentials produce setup error',async()=>{const previous=process.env.VENUE_SEARCH_API_KEY;delete process.env.VENUE_SEARCH_API_KEY;try{assert.equal((await call('/venue-map/search?q=Toronto&bounds=-80,43,-79,44','qa-customer')).status,503);}finally{if(previous)process.env.VENUE_SEARCH_API_KEY=previous;}});
 await t.test('hosted search: real route with fixture upstream, bounded results and quota',async()=>{
  const express=require('express'),local=express();let calls=0;const guard=(req,res,next)=>{if(req.headers.authorization!=='Bearer qa')return res.status(401).end();req.authUser=customer;req.user=admin;next();};
  require('../src/venue-map/routes').registerVenueMap(local,{requireAdmin:guard,requireAuth:guard,env:{VENUE_SEARCH_API_KEY:'server-secret-fixture'},fetchImpl:async(url)=>{calls++;assert.equal(url.hostname,'api.geoapify.com');assert.equal(url.searchParams.get('filter'),'rect:-80,43,-79,44');return new Response(JSON.stringify({features:[{properties:{name:'Provider QA',formatted:'QA Address',lat:43.7,lon:-79.4,place_id:'qa-source',postcode:'M5V 1A1',datasource:{attribution:'© OpenStreetMap contributors'}}}]}));}});
  const s=local.listen(0,'127.0.0.1');await new Promise(resolve=>s.once('listening',resolve));try{const url=`http://127.0.0.1:${s.address().port}/api/venue-map/search?q=Toronto&bounds=-80,43,-79,44`;for(let i=0;i<11;i++){const r=await fetch(url,{headers:{Authorization:'Bearer qa'}});assert.equal(r.status,i<10?200:429);if(i===0){const p=await r.json();assert.equal(p.items[0].saved,false);assert.equal(p.items[0].rooms.length,0);assert.ok(!JSON.stringify(p).includes('server-secret-fixture'));}}assert.equal(calls,10);}finally{await new Promise(resolve=>s.close(resolve));}
 });
});

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
  const lara=await run('Lara’s');assert.equal(lara.length,1);assert.equal(lara[0].venueType,'restaurant');assert.equal(lara[0].rooms.length,0);assert.equal((await run('Laras'))[0].name,poi.name);
  assert.equal((await run('Lara private banquet'))[0].name,poi.name);assert.equal(calls.at(-1).name,'lara');
  const before=calls.length;assert.equal((await run('155 Consumers Road'))[0].name,'Address result');assert.equal(calls.length,before+1);assert.equal(calls.at(-1).path,'/v1/geocode/search');
  assert.equal((await run('Dinos'))[0].name,"Dino's Restaurant");assert.equal(calls.at(-1).text,"Dino's");
  assert.equal((await run('Remos'))[0].name,'Remo Restaurant');assert.equal(calls.at(-1).path,'/v1/geocode/autocomplete');assert.equal(calls.at(-1).text,'remo');
  assert.equal((await run('unknown'))[0].name,'Address result');assert.equal(calls.at(-1).path,'/v1/geocode/search');
 }finally{await new Promise(r=>server.close(r));}
});
