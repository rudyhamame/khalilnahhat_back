const hidden=/^(password|passwordHash|sessionToken|token|apiKey|secret|authorization|obsStreamKey|muxStreamKey|streamKey|accessKey|privateKey|credentials|resetTokenHash|verifyTokenHash|verificationToken|resetToken|refreshToken|accessToken|cookie|cookies|dashscopeApiKey|openaiApiKey)$/i;
function redact(value,depth=0){
 if(depth>18)return '[depth limit]';
 if(value instanceof Date)return value.toISOString();
 if(value&&typeof value.toHexString==='function')return value.toHexString();
 if(Array.isArray(value))return value.slice(0,1000).map(item=>redact(item,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,hidden.test(key)?'[redacted]':redact(item,depth+1)]));
 if(typeof value==='string')return value.replace(/\bsk-[\w.-]{8,}/g,'[redacted]').slice(0,100000);
 return value;
}
module.exports={redact};
