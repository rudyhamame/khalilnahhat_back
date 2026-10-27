const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const crypto=require('node:crypto');
const express=require('express');
const mongoose=require('mongoose');
const {User}=require('./models');
const {usageModel:Usage,createAiConfiguration}=require('./ai-configuration');
const {Invoice,mongoBillingStore,createAiBilling,registerAiBilling}=require('./ai-billing');
let child,folder,server,service;
const id=()=>crypto.randomBytes(16).toString('hex');
const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
before(async()=>{
 folder=await fs.mkdtemp(path.join(os.tmpdir(),'echo-billing-test-'));
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 child=spawn('mongod',['--dbpath',folder,'--port',String(port),'--bind_ip','127.0.0.1','--replSet','echoBillingTests','--logpath',path.join(folder,'mongo.log'),'--quiet'],{stdio:'ignore'});
 const uri=`mongodb://127.0.0.1:${port}/echo_billing_test?directConnection=true`;
 const client=new mongoose.mongo.MongoClient(uri,{serverSelectionTimeoutMS:300});
 let ready=false;
 for(let n=0;n<150;n++){try{await client.connect();await client.db('admin').command({ping:1});ready=true;break;}catch{await pause();}}
 assert.ok(ready,'Isolated test MongoDB starts');
 await client.db('admin').command({replSetInitiate:{_id:'echoBillingTests',members:[{_id:0,host:`127.0.0.1:${port}`}]}});
 for(let n=0;n<150;n++){if((await client.db('admin').command({hello:1})).isWritablePrimary)break;await pause();}
 await client.close();await mongoose.connect(uri);await Promise.all([User.init(),Usage.init(),Invoice.init()]);
 service=createAiBilling({store:mongoBillingStore(Usage)});
});
after(async()=>{
 if(server)await new Promise(resolve=>server.close(resolve));
 await mongoose.disconnect();
 if(child){const closed=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await closed;}
 if(folder)await fs.rm(folder,{recursive:true,force:true});
});
async function account(name='Alice'){
 const owner=new mongoose.Types.ObjectId().toString();
 await User.collection.insertOne({_id:new mongoose.Types.ObjectId(owner),firstName:name,lastName:'Example',email:`${owner}@example.test`,username:owner,passwordHash:'private-test-hash',sessionToken:'private-test-token'});
 return owner;
}
async function usage(owner,{cents=125,currency='CAD',status='unbilled',state='completed',count=1}={}){
 const rows=Array.from({length:count},()=>({_id:crypto.randomBytes(32).toString('hex'),owner,mode:'chat',model:'test/free',revision:1,state,billingStatus:status,customerCents:cents,currency,providerUsdEstimate:0,metrics:{}}));
 await Usage.create(rows);return rows;
}
const create=(owner,rows,extra={})=>service.create({id:id(),owner,currency:'CAD',usageIds:rows.map(row=>row._id),dueDays:30,note:'Pay by bank transfer.',...extra},'admin');
const pay=(invoice,cents,extra={})=>service.update(invoice.id,{action:'payment',id:crypto.randomUUID(),cents,method:'etransfer',reference:'receipt-123',...extra},'admin');
test('all-time totals include more than 100 requests, keep currencies separate and reveal only client fields',async()=>{
 const owner=await account('Search[Literal]');await usage(owner,{count:125});await usage(owner,{count:5,currency:'USD',cents:200});
 const summary=await service.accounts({},owner);assert.equal(summary.items.length,2);assert.equal(summary.items.find(x=>x.currency==='CAD').outstandingCents,15625);
 assert.equal(summary.items.find(x=>x.currency==='USD').outstandingCents,1000);
 assert.equal(summary.items[0].client.name,'Search[Literal] Example');assert.doesNotMatch(JSON.stringify(summary),/private-test/);
 const first=await service.usage({owner,page:'1'}),third=await service.usage({owner,page:'3'});assert.equal(first.items.length,50);assert.equal(third.items.length,30);assert.equal(first.total,130);
 assert.equal((await service.accounts({search:'Search[Literal]'})).total,2);assert.equal((await service.accounts({search:'Search.*'})).total,0);
});
test('invoice snapshots persist accepted charges and client identity; retries never double invoice',async()=>{
 const owner=await account();const rows=await usage(owner,{count:2});const requestId=id();
 const [one,two]=await Promise.all([create(owner,rows,{id:requestId}),create(owner,rows,{id:requestId})]);assert.equal(one.id,two.id);assert.equal(one.totalCents,250);assert.equal(one.items.length,2);
 assert.equal(await Invoice.countDocuments({_id:requestId}),1);assert.equal(await Usage.countDocuments({owner,billingStatus:'invoiced',invoiceId:requestId}),2);
 await User.updateOne({_id:owner},{$set:{email:'changed@example.test'}});const saved=await service.invoice(requestId,owner);assert.notEqual(saved.client.email,'changed@example.test');assert.equal(saved.totalCents,250);
 await assert.rejects(create(owner,rows),{status:409});
 await assert.rejects(create(owner,rows,{id:requestId,currency:'USD'}),{status:409});
});
test('partial payments reconcile account balances, concurrent retries do not duplicate receipts and overpayment is rejected',async()=>{
 const owner=await account();const invoice=await create(owner,await usage(owner,{cents:1000}));const paymentId=crypto.randomUUID();
 const results=await Promise.all([pay(invoice,300,{id:paymentId}),pay(invoice,300,{id:paymentId})]);assert.equal(results[1].paidCents,300);assert.equal(results[1].payments.length,1);
 let totals=(await service.accounts({},owner)).items[0];assert.equal(totals.paidCents,300);assert.equal(totals.invoicedCents,700);assert.equal(totals.outstandingCents,700);
 await assert.rejects(pay(invoice,301,{id:paymentId}),{status:409});await assert.rejects(pay(invoice,701),{status:409});
 await assert.rejects(service.update(invoice.id,{action:'void',reason:'cannot void money received'},'admin'),{status:409});
 const settled=await pay(invoice,700);assert.equal(settled.status,'paid');assert.equal(settled.balanceCents,0);assert.equal(settled.payments.length,2);
 totals=(await service.accounts({},owner)).items[0];assert.equal(totals.paidCents,1000);assert.equal(totals.invoicedCents,0);assert.equal(totals.outstandingCents,0);
 assert.equal((await Usage.findOne({owner})).billingStatus,'paid');
});
test('competing invoices and payments cannot reuse charges or exceed the balance',async()=>{
 const owner=await account();const rows=await usage(owner,{cents:1000});const attempts=await Promise.allSettled([create(owner,rows),create(owner,rows)]);
 assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);assert.equal(attempts.filter(x=>x.status==='rejected')[0].reason.status,409);
 const invoice=attempts.find(x=>x.status==='fulfilled').value;const payments=await Promise.allSettled([pay(invoice,700),pay(invoice,700)]);
 assert.equal(payments.filter(x=>x.status==='fulfilled').length,1);assert.equal((await service.invoice(invoice.id,owner)).paidCents,700);
});
test('voiding uncollected invoices preserves history, clears balance and prevents re-invoicing',async()=>{
 const owner=await account();const rows=await usage(owner);const invoice=await create(owner,rows);
 const result=await service.update(invoice.id,{action:'void',reason:'Waived by Echo'},'admin');assert.equal(result.status,'void');assert.equal(result.balanceCents,0);assert.equal(result.voidReason,'Waived by Echo');
 assert.equal((await Usage.findOne({owner})).billingStatus,'void');assert.equal((await service.accounts({},owner)).items[0].outstandingCents,0);
 await assert.rejects(create(owner,rows),{status:409});await assert.rejects(pay(invoice,1),{status:409});
});
test('invoice selection rejects mixed accounts/currencies, failed or included usage and duplicate lines atomically',async()=>{
 const owner=await account(),other=await account();const [row]=await usage(owner),[foreign]=await usage(other),[usd]=await usage(owner,{currency:'USD'}),[included]=await usage(owner,{status:'included',cents:0}),[failed]=await usage(owner,{state:'failed'});
 for(const bad of [foreign,usd,included,failed])await assert.rejects(create(owner,[row,bad]),{status:409});
 await assert.rejects(create(owner,[row,row]),{status:400});assert.equal(await Invoice.countDocuments({owner}),0);assert.equal((await Usage.findById(row._id)).billingStatus,'unbilled');
 const invoice=await create(owner,[row]);
 const config=createAiConfiguration();await assert.rejects(config.billing(row._id,'admin',{status:'paid',reference:'bypass',paymentMethod:'etransfer'}),{status:409});
 assert.equal((await service.invoice(invoice.id,owner)).paidCents,0);
});
test('account list paginates without excluding old clients from search',async()=>{
 for(let n=0;n<22;n++){const owner=await account(`Paging${String(n).padStart(2,'0')}`);await usage(owner);}
 const one=await service.accounts({search:'Paging',page:'1'}),two=await service.accounts({search:'Paging',page:'2'});assert.equal(one.total,22);assert.equal(one.items.length,20);assert.equal(two.items.length,2);
 assert.equal(new Set([...one.items,...two.items].map(x=>x.owner)).size,22);
});
test('billing APIs are admin-only and client billing routes do not exist',async()=>{
 const alice=await account();const invoice=await create(alice,await usage(alice));
 const app=express();app.use(express.json());const authenticate=(req,res,next)=>{const token=req.get('authorization');if(!token)return res.sendStatus(401);if(token!=='Bearer admin')return res.sendStatus(403);req.authUser={id:'admin'};next();};
 registerAiBilling(app,{requireAdmin:authenticate,service});server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}/api/ai-booking`;
 const get=async(path,token='alice')=>fetch(base+path,{headers:{Authorization:`Bearer ${token}`}});
 for(const route of ['/admin/billing/accounts','/admin/billing/usage?owner='+alice,'/admin/billing/invoices','/admin/billing/invoices/'+invoice.id])assert.equal((await get(route)).status,403);
 for(const route of ['/billing/accounts','/billing/invoices','/billing/invoices/'+invoice.id])assert.equal((await get(route)).status,404);
 assert.equal((await get('/admin/billing/accounts','admin')).status,200);assert.equal((await get('/admin/billing/invoices/'+invoice.id,'admin')).status,200);
 let response=await fetch(base+'/admin/billing/invoices',{method:'POST',headers:{Authorization:'Bearer alice','Content-Type':'application/json'},body:JSON.stringify({})});assert.equal(response.status,403);
 response=await fetch(base+'/admin/billing/invoices/'+invoice.id,{method:'PATCH',headers:{Authorization:'Bearer alice','Content-Type':'application/json'},body:JSON.stringify({action:'void',reason:'bypass'})});assert.equal(response.status,403);
 assert.equal((await get('/admin/billing/usage?owner=invalid','admin')).status,400);
});
