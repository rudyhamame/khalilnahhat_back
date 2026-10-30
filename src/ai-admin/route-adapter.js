const {EventEmitter}=require('node:events');
const failure=(status,message)=>Object.assign(new Error(message),{status});
// In-process dispatch to an EXACT registered route. No network access, URL supplied
// by a model, guard bypass, or stored session token. The normal auth middleware runs.
function createRouteAdapter(app){
 return async(method,path,{actor,params={},query={},body={}}={})=>{
  const route=app.router.stack.find(layer=>layer.route?.path===path&&layer.route.methods[method.toLowerCase()])?.route;
  if(!route)throw failure(503,`Administrative adapter unavailable: ${method} ${path}`);
  if(!actor?.sessionToken)throw failure(403,'The initiating administrator must have an active account session.');
  return new Promise((resolve,reject)=>{
   const req=Object.assign(new EventEmitter(),{method:method.toUpperCase(),url:path,originalUrl:path,params,query,body,headers:{authorization:`Bearer ${actor.sessionToken}`,'content-type':'application/json'},app,ip:'127.0.0.1',get(name){return this.headers[name.toLowerCase()];}});
   let done=false;const timer=setTimeout(()=>finish(failure(504,'Administrative service timed out. Its result must be reconciled before retrying.')),60000);timer.unref?.();
   const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);};
   const res=Object.assign(new EventEmitter(),{statusCode:200,locals:{},headersSent:false,status(code){this.statusCode=code;return this;},set(){return this;},header(){return this;},json(value){this.headersSent=true;this.emit('finish');if(this.statusCode>=400)finish(failure(this.statusCode,value?.message||'Administrative service rejected the operation.'));else finish(null,JSON.parse(JSON.stringify(value)));return this;},send(value){return this.json(value);},end(){return this.json(null);}});
   try{route.dispatch(req,res,error=>finish(error||failure(500,'Administrative service did not return a result.')));}catch(error){finish(error);}
  });
 };
}
module.exports={createRouteAdapter,failure};
