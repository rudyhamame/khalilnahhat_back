const {WebSocketServer,WebSocket}=require('ws');
const {randomUUID}=require('node:crypto');
const {isAdminUser}=require('./admin-role');

// Events carry no chat content or credentials; authenticated HTTP reads provide
// the current topic snapshot and private attachments after each change.
function createProjectChatSocket({authenticate,allowedOrigins=[],onHeartbeat=async()=>{},onOffline=async()=>{},heartbeatMs=15000}={}){
 const wss=new WebSocketServer({noServer:true,maxPayload:16*1024});
 const publish=reason=>{for(const client of wss.clients)if(client.authorized&&client.readyState===WebSocket.OPEN){if(client.bufferedAmount>64*1024)client.terminate();else client.send(JSON.stringify({type:'changed',reason}));}};
 const attach=server=>{
  const upgrade=(req,socket,head)=>{
   if(req.url?.split('?')[0]!=='/api/echo-project-chat/socket')return;
   const origin=req.headers.origin;
   if(origin&&!allowedOrigins.includes(origin.replace(/\/+$/,''))){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
   wss.handleUpgrade(req,socket,head,client=>{
    client.on('error',()=>{});client.alive=true;client.connectionId=randomUUID();
    const touch=()=>{client.presenceWrite=(client.presenceWrite||Promise.resolve()).then(()=>onHeartbeat(client.user,client.connectionId));return client.presenceWrite;};
    client.on('pong',()=>{client.alive=true;if(client.authorized)touch().catch(()=>client.close(1011,'Presence unavailable'));});
    client.once('close',()=>{if(client.user)(client.presenceWrite||Promise.resolve()).catch(()=>{}).then(()=>onOffline(client.user,client.connectionId)).then(()=>publish('presence')).catch(()=>{});});
    const deadline=setTimeout(()=>client.close(4401,'Authentication required'),5000);deadline.unref?.();
    client.once('close',()=>clearTimeout(deadline));
    client.on('message',async bytes=>{
     if(client.authenticating||client.authorized)return;
     client.authenticating=true;
     try{
      const message=JSON.parse(bytes.toString());
      if(message.type!=='authenticate'||typeof message.token!=='string'||message.token.length>8192){client.close(4401,'Invalid authentication');return;}
      const user=await authenticate({headers:{authorization:'Bearer '+message.token}});
      if(!isAdminUser(user)||user.isBlocked){client.close(4401,'Administrator authentication required');return;}
      if(client.readyState!==WebSocket.OPEN)return;
      client.user=user;await touch();
      if(client.readyState!==WebSocket.OPEN)return;
      client.token=message.token;client.authorized=true;clearTimeout(deadline);
      client.send(JSON.stringify({type:'ready'}));publish('presence');
     }catch{client.close(1011,'Chat connection temporarily unavailable');}
    });
   });
  };
  server.on('upgrade',upgrade);
  const heartbeat=setInterval(()=>{for(const client of wss.clients){
   if(!client.alive){client.terminate();continue;}client.alive=false;client.ping();
   if(client.authorized&&!client.checking){client.checking=true;Promise.resolve().then(()=>authenticate({headers:{authorization:'Bearer '+client.token}})).then(user=>{if(!isAdminUser(user)||user.isBlocked)client.close(4401,'Session expired');}).catch(()=>client.close(1011,'Authentication unavailable')).finally(()=>{client.checking=false;});}
  }},heartbeatMs);heartbeat.unref?.();
  server.once('close',()=>{clearInterval(heartbeat);server.off('upgrade',upgrade);for(const client of wss.clients)client.terminate();wss.close();});
 };
 return {publish,attach};
}
module.exports={createProjectChatSocket};
