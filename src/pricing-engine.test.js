const test=require('node:test'),assert=require('node:assert/strict');
const {eventHours,suggestUnitPrices,calculateBookingPrice:calc,validatePolicy,reservationDemand}=require('./pricing-engine');
const O=(id,type='equipment',extra={})=>({id,name:id,type,...extra});
const P=(offeringId,pricingMode,baseAmountCents,extra={})=>({id:`p-${offeringId}-${pricingMode}${extra.priority||0}`,offeringId,name:'p',pricingMode,baseAmountCents,status:'active',priority:0,version:1,...extra});
const run=(offerings,policies,selections,event={},extra={})=>calc({selections,event,...extra},{offerings,policies,today:'2026-06-01',taxes:extra.taxes||[]});
const q=(offeringId,quantity=1)=>({offeringId,quantity});

test('fixed, hourly (minimum duration), daily, per unit, per unit per day',()=>{
 assert.equal(run([O('a','service')],[P('a','fixed',50000)],[q('a')]).total,50000);
 assert.equal(run([O('a','service')],[P('a','hourly',10000,{minimumDuration:4})],[q('a')],{hours:3}).total,40000);
 assert.equal(run([O('a','service')],[P('a','hourly',10000)],[q('a')],{hours:6}).total,60000);
 assert.equal(run([O('a')],[P('a','daily',2000)],[q('a')],{days:3}).total,6000);
 assert.equal(run([O('a')],[P('a','per_unit',1500)],[q('a',4)]).total,6000);
 assert.equal(run([O('a')],[P('a','per_unit_per_day',1500)],[q('a',4)],{days:2}).total,12000);
});
test('hourly without hours needs a quote, never a guessed price',()=>{
 const r=run([O('a','service')],[P('a','hourly',10000)],[q('a')]);
 assert.equal(r.quoteRequired,true);assert.equal(r.status,'quote_required');assert.equal(r.total,0);
});
test('tier boundaries',()=>{
 const pol=P('a','tiered',0,{tiers:[{from:1,to:4,rateCents:1000},{from:5,to:null,rateCents:800}]});
 assert.equal(run([O('a')],[pol],[q('a',4)]).total,4000);
 assert.equal(run([O('a')],[pol],[q('a',5)]).total,4000);
 assert.equal(run([O('a')],[pol],[q('a',6)]).total,4800);
});
test('no policy, custom quote, included',()=>{
 assert.equal(run([O('a')],[],[q('a')]).quoteRequired,true);
 assert.equal(run([O('a')],[P('a','custom_quote',0)],[q('a')]).quoteRequired,true);
 const r=run([O('a')],[P('a','included',0)],[q('a')]);assert.equal(r.quoteRequired,false);assert.equal(r.total,0);
});
test('policy effective dates and priority',()=>{
 const pols=[P('a','fixed',1000),P('a','fixed',900,{priority:5,effectiveFrom:'2026-12-01',effectiveUntil:'2026-12-31'})];
 assert.equal(run([O('a')],pols,[q('a')],{date:'2026-06-10'}).total,1000);
 assert.equal(run([O('a')],pols,[q('a')],{date:'2026-12-10'}).total,900);
 assert.equal(run([O('a')],[{...pols[0],status:'draft'}],[q('a')]).quoteRequired,true);
});
test('conditional adjustments: fixed, percent on base, per additional hour, override; no rule = no surcharge',()=>{
 const c=(field,operator,value,adjustmentType,adjustmentValue,priority=0)=>({field,operator,value,adjustmentType,adjustmentValue,priority});
 const off=[O('a','service')];
 assert.equal(run(off,[P('a','fixed',10000,{conditions:[c('weekend','eq',true,'percent',1000)]})],[q('a')],{weekend:true}).total,11000);
 assert.equal(run(off,[P('a','fixed',10000,{conditions:[c('weekend','eq',true,'percent',1000)]})],[q('a')],{weekend:false}).total,10000);
 assert.equal(run(off,[P('a','hourly',10000,{minimumDuration:4,conditions:[c('hours','gt',4,'per_additional_hour',2500)]})],[q('a')],{hours:6}).total,60000+5000);
 assert.equal(run(off,[P('a','fixed',10000,{conditions:[c('venue','in',['x','y'],'override',7000),c('venue','eq','x','fixed',500,1)]})],[q('a')],{venue:'x'}).total,7500);
});
test('packages: fixed price does not double charge, priced upgrade does, derived sums, nested',()=>{
 const offs=[O('pkg','package',{components:[{offeringId:'spk',quantity:2,inclusion:'included'},{offeringId:'sub',quantity:1,inclusion:'priced'}]}),O('spk'),O('sub'),
  O('d','package',{components:[{offeringId:'spk',quantity:2,inclusion:'included'},{offeringId:'inner',quantity:1,inclusion:'included'}]}),O('inner','package',{components:[{offeringId:'sub',quantity:3,inclusion:'included'}]})];
 const pol=[P('pkg','fixed',100000),P('spk','per_unit',5000),P('sub','per_unit',8000)];
 const r=run(offs,pol,[q('pkg')]);
 assert.equal(r.total,108000); // 100000 + the explicit sub upgrade; speakers not charged again
 assert.equal(r.items.find(i=>i.offeringId==='spk').status,'included');
 assert.equal(run(offs,pol,[q('d')]).total,2*5000+3*8000); // derived, nested
 assert.equal(run(offs,pol,[q('pkg',2)]).total,216000);
});
test('circular packages are rejected',()=>{
 const offs=[O('a','package',{components:[{offeringId:'b',quantity:1}]}),O('b','package',{components:[{offeringId:'a',quantity:1}]})];
 assert.throws(()=>run(offs,[],[q('a')]),/Circular/);
});
test('quantity validation and minimum',()=>{
 assert.equal(run([O('a',undefined,{minQuantity:2})],[P('a','per_unit',100)],[q('a',1)]).quoteRequired,true);
 assert.equal(run([O('a')],[P('a','per_unit',100)],[q('a',0)]).quoteRequired,true);
 assert.equal(run([O('a')],[P('a','per_unit',100)],[q('a',1.5)]).quoteRequired,true);
});
test('discounts, fees, tax and rounding in cents; subtotals by bucket',()=>{
 const offs=[O('dj','service'),O('spk')],pol=[P('dj','fixed',100001),P('spk','per_unit',3333)];
 const r=run(offs,pol,[q('dj'),q('spk',3)],{},{discounts:[{name:'promo',type:'percent',value:1000}],fees:[{name:'delivery',amountCents:5000}],taxes:[{name:'HST',rateBps:1300}]});
 assert.equal(r.serviceSubtotal,100001);assert.equal(r.equipmentSubtotal,9999);
 assert.equal(r.discountTotal,Math.round(110000*0.1));
 assert.equal(r.subtotalBeforeTax,110000-11000+5000);
 assert.equal(r.taxes[0].amount,Math.round(104000*.13));
 assert.equal(r.total,104000+13520);assert.ok(Number.isInteger(r.total));
});
test('policy version and conflicts',()=>{
 const r=run([O('a')],[P('a','fixed',1),{...P('a','fixed',2),id:'other'}],[q('a')]);
 assert.ok(r.warnings.some(w=>/Conflicting/.test(w)));assert.match(r.policyVersion,/@1/);
});
test('validatePolicy rejects overlap, bad tiers, bad dates',()=>{
 const base=P('a','fixed',100);
 assert.deepEqual(validatePolicy(base,[]),[]);
 assert.ok(validatePolicy({...base,id:'x'},[base])[0].includes('same priority'));
 assert.ok(validatePolicy(P('a','tiered',0,{tiers:[{from:1,to:5,rateCents:1},{from:5,to:null,rateCents:1}]})).includes('Tiers overlap.'));
 assert.ok(validatePolicy(P('a','fixed',1.5)).length);
 assert.ok(validatePolicy(P('a','fixed',1,{effectiveFrom:'2026-02-01',effectiveUntil:'2026-01-01'})).length);
});
test('reservation demand counts included package equipment',()=>{
 const offs=[O('pkg','package',{components:[{offeringId:'spk',quantity:2,inclusion:'included'}]}),O('spk')];
 const r=run(offs,[P('pkg','fixed',1000)],[q('pkg',2)]);
 assert.equal(reservationDemand(r).get('spk'),4);
});

test('eventHours handles overnight and missing times',()=>{
 assert.equal(eventHours({startTime:'18:00',endTime:'23:30'}),5.5);
 assert.equal(eventHours({startTime:'20:00',endTime:'02:00'}),6);
 assert.equal(eventHours({startTime:'20:00'}),null);
});
test('suggested unit prices: per unit, derived package, quote required, indivisible',()=>{
 const offs=[O('dj','service'),O('spk'),O('p','package',{components:[{offeringId:'spk',quantity:2,inclusion:'included'}]}),O('x'),O('y')];
 const pol=[P('dj','hourly',10000),P('spk','per_unit',5000),P('y','fixed',1000)];
 const sel=[q('dj'),q('p',2),q('x'),q('y',3)];
 const r=run(offs,pol,sel,{hours:4});
 const s=Object.fromEntries(suggestUnitPrices(r,sel).map(x=>[x.serviceId,x.unitPrice]));
 assert.equal(s.dj,400);assert.equal(s.p,100);assert.equal(s.x,null);assert.equal(s.y,10);
 const odd=run([O('z')],[P('z','fixed',1000)],[q('z',3)]);
 assert.equal(suggestUnitPrices(odd,[q('z',3)])[0].unitPrice,10); // 3 × fixed 1000 = 3000 → 10.00 each
});
