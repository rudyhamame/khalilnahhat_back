const test = require('node:test');
const assert = require('node:assert/strict');
const { messageFor } = require('../src/client-push');

test('clients are only notified of admin-driven booking changes', () => {
  assert.equal(messageFor({ status: 'quoted' })[0], 'Booking quote ready');
  assert.equal(messageFor({ status: 'confirmed' })[0], 'Booked');
  assert.equal(messageFor({ status: 'cancelled', declinedBy: 'admin' })[0], 'Request declined');
  assert.equal(messageFor({ status: 'cancelled', declinedBy: 'client' }), null);
  assert.equal(messageFor({ status: 'accepted' }), null);
  assert.equal(messageFor({ status: 'changes_requested' }), null);
});

test('a status change on a saved booking notifies its owner, an unrelated edit does not', async () => {
  const mongoose = require('mongoose');
  const { watchSchema } = require('../src/client-push');
  const calls = [];
  const schema = new mongoose.Schema({ userId: String, status: String, note: String });
  watchSchema(schema, async (user, msg) => calls.push([user, msg.title]));
  const M = mongoose.model('PushProbe', schema);
  const doc = new M({ userId: 'u1', status: 'pending' }); doc.isNew = false; // no database: exercise the hooks directly
  doc.status = 'quoted';
  for (const fn of schema.s.hooks._pres.get('save')) fn.fn.call(doc, () => {});
  for (const fn of schema.s.hooks._posts.get('save')) fn.fn.call(doc, doc, () => {});
  assert.deepEqual(calls, [['u1', 'Booking quote ready']]);
});

test('availability push uses the new stages and only the current event window',()=>{
 const sr={status:'pending',event:{eventDate:'2099-06-01',startTime:'18:00',endTime:'23:00'},availabilityAcceptedAt:new Date()};
 assert.equal(messageFor(sr)[0],'Booking date and/or time available');
 sr.availabilityAcceptedAt=null;sr.availabilityUnavailableAt=new Date();sr.availabilityReason='Already booked';
 assert.equal(messageFor(sr)[0],'Booking date and/or time unavailable');assert.match(messageFor(sr)[1],/optional meeting/);
 sr.availabilityWindow=require('../src/booking-availability').windowKey(sr);sr.event.eventDate='2099-06-02';assert.equal(messageFor(sr),null);
});
test('availability changes trigger one owner-scoped push without changing the internal status',()=>{
 const {watchSchema}=require('../src/client-push'),hooks={};
 const schema={pre:(_event,fn)=>hooks.pre=fn,post:(_event,fn)=>hooks.post=fn};const calls=[];
 watchSchema(schema,async(user,msg)=>{calls.push([user,msg.title]);});
 const doc={isNew:false,$locals:{},userId:'owner',externalId:'r1',status:'pending',availabilityAcceptedAt:new Date(),isModified:key=>key==='availabilityAcceptedAt'};
 hooks.pre.call(doc);hooks.post(doc);assert.deepEqual(calls,[['owner','Booking date and/or time available']]);
 doc.isModified=()=>false;hooks.pre.call(doc);hooks.post(doc);assert.equal(calls.length,1);
 doc.isNew=true;doc.isModified=()=>true;hooks.pre.call(doc);hooks.post(doc);assert.equal(calls.length,1);
});
