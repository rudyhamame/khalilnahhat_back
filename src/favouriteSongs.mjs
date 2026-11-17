export function isYouTubeLink(value){
 if(typeof value!=='string'||value.length>2048)return false;
 try{
  const url=new URL(value);
  return url.protocol==='https:'&&!url.username&&!url.password&&(url.hostname==='youtu.be'||url.hostname==='youtube.com'||url.hostname.endsWith('.youtube.com'));
 }catch{return false;}
}

// Any https link without a login in it (the manual route: the client may paste a link from anywhere).
export function isSafeLink(value){
 if(typeof value!=='string'||value.length>2048)return false;
 try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&Boolean(url.hostname);}catch{return false;}
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
  (row.artist===undefined||(typeof row.artist==='string'&&row.artist.length<=200))&& // older entries have no artist, so the artist stays optional here; the form asks for it on new manual entries
  (row.link===undefined||isSafeLink(row.link)));
}
