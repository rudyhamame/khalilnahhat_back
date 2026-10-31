const configured = () => Boolean(process.env.ECHO_OBS_RELAY_URL && process.env.ECHO_OBS_RELAY_TOKEN);
function base() {
 const url=new URL(process.env.ECHO_OBS_RELAY_URL);
 if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.pathname!=='/')throw new Error('Invalid OBS relay configuration');
 return url.origin;
}
async function request(route,{method='GET',body,raw=false,allowMissing=false}={}) {
 if(!configured())throw Object.assign(new Error('OVH streaming is not configured.'),{status:503});
 const response=await fetch(`${base()}/control/${route}`,{method,headers:{Authorization:`Bearer ${process.env.ECHO_OBS_RELAY_TOKEN}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(raw?600000:20000)});
 if(response.status===404 && allowMissing)return null;
 if(!response.ok) {
  const data=await response.json().catch(()=>({}));
  throw Object.assign(new Error([409,507].includes(response.status)?data.message:'OVH streaming is temporarily unavailable. Try again shortly.'),{status:response.status===409?409:503});
 }
 return raw?response:response.json();
}
const sessionRoute = id => {
 if(!/^khalil-obs-[a-f0-9-]{36}$/.test(id))throw new Error('Invalid OBS connection');
 return `sessions/${id}`;
};
const segmentRoute=(id,segment)=>{
 if(!/^[0-9_-]+\.mp4$/.test(segment))throw new Error('Invalid recording segment');
 return `${sessionRoute(id)}/segments/${segment}`;
};
module.exports={configured,request,sessionRoute,segmentRoute};
