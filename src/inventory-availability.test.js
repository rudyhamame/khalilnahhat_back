const test=require('node:test'),assert=require('node:assert/strict');
const {reservationWindow:win,checkAvailability:check,overlaps}=require('./inventory-availability');
const spk={id:'spk',name:'Speaker',type:'equipment',stock:10},mc={id:'svc-mc',name:'MC',type:'service',stock:1};
const D=o=>new Map(Object.entries(o)),ev=(date,startTime,endTime,b)=>win({date,startTime,endTime},b);
test('windows: overnight, buffers, missing times block the whole day',()=>{
 const w=ev('2026-06-01','20:00','02:00');assert.equal(w.end-w.start,6*60);
 const b=ev('2026-06-01','20:00','23:00',{prepMinutes:120,dismantleMinutes:60});assert.equal(b.end-b.start,(3+3)*60);
 assert.equal(ev('2026-06-01').wholeDay,true);assert.equal(win({date:'nope'}),null);
});
test('overlap is half-open: back-to-back windows do not clash',()=>{
 assert.equal(overlaps({start:0,end:10},{start:10,end:20}),false);assert.equal(overlaps({start:0,end:11},{start:10,end:20}),true);
});
test('shortage only counts overlapping reservations',()=>{
 const other=(d,s,e,n)=>({window:ev(d,s,e),demand:D({spk:n})});
 const req=ev('2026-06-01','18:00','23:00');
 let r=check({demand:D({spk:4}),offerings:[spk],reservations:[other('2026-06-01','20:00','23:00',8)],window:req});
 assert.equal(r.ok,false);assert.equal(r.lines[0].available,2);assert.equal(r.lines[0].shortBy,2);
 r=check({demand:D({spk:4}),offerings:[spk],reservations:[other('2026-06-02','20:00','23:00',8)],window:req});assert.equal(r.ok,true);
 // a prep buffer pulls an earlier booking into the window
 const early=other('2026-06-01','12:00','16:00',8),buffered=ev('2026-06-01','18:00','23:00',{prepMinutes:150});
 assert.equal(check({demand:D({spk:4}),offerings:[spk],reservations:[early],window:buffered}).ok,false);
 assert.equal(check({demand:D({spk:4}),offerings:[spk],reservations:[early],window:req}).ok,true);
});
test('staff capacity, maintenance, inactive, on-request and packages',()=>{
 const busy={window:ev('2026-06-01','19:00','22:00'),demand:D({'svc-mc':1})},req=ev('2026-06-01','18:00','23:00');
 assert.equal(check({demand:D({'svc-mc':1}),offerings:[mc],reservations:[busy],window:req}).ok,false);
 assert.equal(check({demand:D({spk:1}),offerings:[spk],window:req,unavailable:new Set(['spk'])}).ok,false);
 assert.equal(check({demand:D({spk:1}),offerings:[{...spk,isActive:false}],window:req}).ok,false);
 const ext=check({demand:D({rx:1}),offerings:[{id:'rx',name:'Receiver',type:'equipment',stock:null}],window:req});
 assert.equal(ext.ok,true);assert.equal(ext.needsConfirmation,true);
 assert.equal(check({demand:D({pkg:1}),offerings:[{id:'pkg',name:'8-piece',type:'package',stock:1}],window:req}).lines.length,0);
 assert.equal(check({demand:D({ghost:1}),offerings:[],window:req}).ok,false);
});
