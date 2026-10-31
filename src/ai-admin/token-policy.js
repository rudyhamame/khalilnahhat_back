const bounded=(value,fallback,min,max)=>{const number=Number(value);return Number.isSafeInteger(number)&&number>=min&&number<=max?number:fallback;};
function tokenPolicy(env=process.env){return {
 historyChars:bounded(env.ECHO_ADMIN_HISTORY_CHARS,8000,2000,24000),
 historyRequests:bounded(env.ECHO_ADMIN_HISTORY_REQUESTS,12,2,24),
 historyRecordChars:2000,
 maxOutputTokens:bounded(env.ECHO_ADMIN_MAX_OUTPUT_TOKENS,3000,1500,8000),
};}
module.exports={tokenPolicy};
