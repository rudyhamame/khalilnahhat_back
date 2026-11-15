export function isYouTubeLink(value){
 if(typeof value!=='string'||value.length>2048)return false;
 try{
  const url=new URL(value);
  return url.protocol==='https:'&&!url.username&&!url.password&&(url.hostname==='youtu.be'||url.hostname==='youtube.com'||url.hostname.endsWith('.youtube.com'));
 }catch{return false;}
}

export function favouriteSongEntries(value){
 const rows=Array.isArray(value)?value:String(value||'').split(/[\n,;]+/).map(song=>song.trim()).filter(Boolean);
 return rows.map(row=>typeof row==='string'?{song:row,artist:'',link:''}:{song:row?.song||'',artist:row?.artist||'',link:row?.link||''});
}

export function validFavouriteSongs(value){
 return Array.isArray(value)&&value.length<=40&&value.every(row=>
  // Keep names already saved before artist and YouTube fields were available.
  typeof row==='string'?row.trim().length>0&&row.length<=80:
  row&&typeof row==='object'&&typeof row.song==='string'&&row.song.trim().length>0&&row.song.length<=200&&
  typeof row.artist==='string'&&row.artist.trim().length>0&&row.artist.length<=200&&
  (row.link===undefined||isYouTubeLink(row.link)));
}
