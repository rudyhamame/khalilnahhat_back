const {createHmac, timingSafeEqual}=require('node:crypto');
// Audience capabilities are short lived, scoped to one room, and never publisher credentials.
function signViewer(room,user,secret,now=Date.now()) {
 const payload=Buffer.from(JSON.stringify({room,sub:String(user),exp:Math.floor(now/1000)+120})).toString('base64url');
 return payload+'.'+createHmac('sha256',secret).update(payload).digest('base64url');
}
function verifyViewer(value,room,secret,now=Date.now()) {
 try {const [payload,signature,...rest]=String(value||'').split('.');if(rest.length||!payload||!signature)return false;
 const expected=createHmac('sha256',secret).update(payload).digest();const actual=Buffer.from(signature,'base64url');
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return false;
 const data=JSON.parse(Buffer.from(payload,'base64url'));return data.room===room&&typeof data.sub==='string'&&data.sub.length>0&&data.exp>Math.floor(now/1000)&&data.exp<=Math.floor(now/1000)+120;
 }catch{return false;}
}
function authorizeMedia(data,row,secret,now=Date.now()) {
 if(!row||!['waiting','live'].includes(row.state)||data.protocol!=='webrtc')return false;
 const query=new URLSearchParams(data.query||''),token=data.token||data.password||query.get('token')||query.get('pass');
 if(data.action==='read')return row.state==='live'&&verifyViewer(token,row.id,secret,now);
 if(data.action!=='publish'||!(row.state==='live'||now<row.expiresAt)||typeof token!=='string'||typeof row.publishToken!=='string')return false;
 const value=Buffer.from(token),expected=Buffer.from(row.publishToken);
 return value.length===expected.length&&timingSafeEqual(value,expected);
}
module.exports={signViewer,verifyViewer,authorizeMedia};
