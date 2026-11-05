const GROQ_MODEL='whisper-large-v3-turbo';
const GROQ_RATE_PER_MINUTE=0.04/60;
function transcriptionTarget(stt={},timed=false){
 if(stt.provider==='groq')return {provider:'groq',model:GROQ_MODEL,rate:GROQ_RATE_PER_MINUTE,keyName:'GROQ_API_KEY',label:'Groq',url:'https://api.groq.com/openai/v1/audio/transcriptions'};
 if(timed||stt.provider!=='alibaba')return {provider:'openai',model:timed?'whisper-1':stt.model,rate:timed?0.006:stt.providerRates?.audioMinute,keyName:'OPENAI_API_KEY',label:'OpenAI',url:'https://api.openai.com/v1/audio/transcriptions'};
 return {provider:'alibaba',model:stt.model,rate:stt.providerRates?.audioMinute,keyName:'DASHSCOPE_API_KEY',label:'Alibaba Cloud'};
}
module.exports={GROQ_MODEL,GROQ_RATE_PER_MINUTE,transcriptionTarget};
