const assert=require('node:assert'),{test}=require('node:test');
const {registerQuoteTerms,termsSchema,pick}=require('./quote-terms');
test('quote terms defaults: validated, saved once, read back; bad terms are refused',async()=>{
 const routes={};const app={get:(p,_a,h)=>{routes['GET '+p]=h;},put:(p,_a,h)=>{routes['PUT '+p]=h;}};
 let doc=null;const Model={findOne:async()=>doc,findOneAndUpdate:async(_q,u)=>{doc={...doc,...u.$set};return doc;}};
 registerQuoteTerms(app,{requireAdmin:1,Model});
 const call=async(key,body)=>{const res={code:200,status(c){this.code=c;return this;},set(){return this;},json(b){this.body=b;return this;}};await routes[key]({body},res);return res;};
 assert.equal((await call('GET /api/admin/quote-terms')).body.terms.validDays,7);
 assert.equal((await call('PUT /api/admin/quote-terms',{validDays:0})).code,400);
 assert.equal((await call('PUT /api/admin/quote-terms',{validDays:10,paymentOptions:['etransfer','etransfer'],etransferEmail:'pay@x.co',paymentInstructions:'Pay within 3 days'})).body.terms.paymentOptions.length,1);
 assert.equal((await call('GET /api/admin/quote-terms')).body.terms.etransferEmail,'pay@x.co');
 assert.equal((await call('PUT /api/admin/quote-terms',{validDays:5,etransferEmail:'not-an-email'})).code,400);
});
