// Recording staging is a separately configured S3-compatible service.
// Cloudinary remains the final archive; no deployment-local storage host is inferred.
function recordingStorageConfig(env=process.env){
  const publicEndpoint=env.ECHO_RECORDING_PUBLIC_ENDPOINT?.trim();
  const storageEndpoint=(env.ECHO_RECORDING_STORAGE_ENDPOINT||publicEndpoint)?.trim();
  if(!publicEndpoint||!storageEndpoint||!env.ECHO_RECORDING_ACCESS_KEY||!env.ECHO_RECORDING_SECRET)return null;
  const parse=value=>{
    try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&['','/'].includes(url.pathname)?url:null;}catch{return null;}
  };
  const publicUrl=parse(publicEndpoint),storageUrl=parse(storageEndpoint);
  if(!publicUrl||!storageUrl)return null;
  return {
    publicEndpoint:publicUrl.origin,
    storageEndpoint:storageUrl.origin,
    host:storageUrl.hostname,port:Number(storageUrl.port||443),useSSL:true,
    bucket:env.ECHO_RECORDING_BUCKET||'echo-live-archive',
    region:env.ECHO_RECORDING_REGION||'us-east-1',
    accessKey:env.ECHO_RECORDING_ACCESS_KEY,secretKey:env.ECHO_RECORDING_SECRET,
  };
}
module.exports={recordingStorageConfig};
