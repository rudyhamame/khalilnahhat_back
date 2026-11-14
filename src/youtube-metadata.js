const text=(value,max=1000)=>typeof value==='string'?value.trim().slice(0,max):'';
const list=value=>Array.isArray(value)?value.slice(0,80).map(item=>text(item,200)).filter(Boolean):[];
const number=value=>Number.isFinite(value)&&value>=0?value:null;
const url=value=>{try{const parsed=new URL(value);return ['https:','http:'].includes(parsed.protocol)?parsed.href.slice(0,2000):'';}catch{return '';}};
// yt-dlp's info file also contains signed media URLs and request headers. Only
// persist this explicit list of public song/video fields, never the raw file.
function youtubeMetadata(info={}){
 return {videoId:text(info.id,30),title:text(info.title),track:text(info.track),artist:text(info.artist)||list(info.artists).join(', '),album:text(info.album),channel:text(info.channel),uploader:text(info.uploader),channelUrl:url(info.channel_url),durationSec:number(info.duration),uploadDate:text(info.upload_date,20),releaseDate:text(info.release_date,20),language:text(info.language,50),description:text(info.description,6000),categories:list(info.categories),tags:list(info.tags),viewCount:number(info.view_count),likeCount:number(info.like_count),license:text(info.license),ageLimit:number(info.age_limit),thumbnailUrl:url(info.thumbnail),sourceUrl:url(info.webpage_url),audioCodec:text(info.acodec,80),audioSampleRate:number(info.asr),audioBitrate:number(info.abr),fetchedAt:new Date().toISOString()};
}
function songMetadataFields(item,metadata){
 if(!metadata)return {};
 const fields={youtubeMetadata:metadata};
 if(!item.track||item.track==='Song request')fields.track=metadata.track||metadata.title||item.track;
 if(!item.artist&&metadata.artist)fields.artist=metadata.artist;
 if(!item.duration&&metadata.durationSec!=null){const duration=Math.round(metadata.durationSec);fields.duration=`${Math.floor(duration/60)}:${String(duration%60).padStart(2,'0')}`;}
 if(!item.language&&metadata.language)fields.language=metadata.language;
 if(!item.thumbnailUrl&&metadata.thumbnailUrl)fields.thumbnailUrl=metadata.thumbnailUrl;
 return fields;
}
module.exports={youtubeMetadata,songMetadataFields};
