const mongoose = require('mongoose');
const { z } = require('zod');
const { ArchiveItem } = require('./models');
const { publicSongs, deliveryUrl } = require('./music-archive');
const { localAssetPattern } = require('./music-archive-files');
const isArchiveAudio = (url,cloudName) => localAssetPattern.test(url) || isCloudinaryAudio(url,cloudName);
const schema=new mongoose.Schema({key:{type:String,unique:true,default:'footer'},enabled:{type:Boolean,default:true},archiveIds:{type:[String],default:[]}},{timestamps:true});
const FooterPlaylist=mongoose.models.FooterPlaylist||mongoose.model('FooterPlaylist',schema);
const playlistInput=z.object({enabled:z.boolean(),archiveIds:z.array(z.string().trim().min(1).max(120)).max(100)}).strict();
function isCloudinaryAudio(url,cloudName=process.env.CLOUDINARY_CLOUD_NAME) {
  try {const u=new URL(url);return Boolean(cloudName)&&u.protocol==='https:'&&u.hostname==='res.cloudinary.com'&&['upload','authenticated'].some(type=>u.pathname.startsWith(`/${cloudName}/video/${type}/`));}
  catch{return false;}
}
function validatePlaylistSelection(ids,rows,cloudName=process.env.CLOUDINARY_CLOUD_NAME) {
  if(new Set(ids).size!==ids.length)return 'Each track can appear once in the playlist.';
  const byId=new Map(rows.map(row=>[row.externalId,row]));
  for(const id of ids){const row=byId.get(id);if(!row)return 'An archive item no longer exists. Refresh the archive.';if(!isArchiveAudio(row.audioUrl,cloudName))return `Upload “${row.title}” audio to this website before adding it to the player.`;}
  return '';
}
function registerArchivePlayer(app,{requireAdmin,PlaylistModel=FooterPlaylist,ArchiveModel=ArchiveItem}) {
  app.get('/api/admin/player-playlist',requireAdmin,async(_req,res)=>{
    const row=await PlaylistModel.findOne({key:'footer'});
    res.json({item:{enabled:row?.enabled??true,archiveIds:row?.archiveIds||[],updatedAt:row?.updatedAt||null}});
  });
  app.put('/api/admin/player-playlist',requireAdmin,async(req,res)=>{
    const parsed=playlistInput.safeParse(req.body);
    if(!parsed.success)return res.status(400).json({message:'Choose up to 100 archive tracks.'});
    const rows=await ArchiveModel.find({externalId:{$in:parsed.data.archiveIds}});
    const error=validatePlaylistSelection(parsed.data.archiveIds,rows);
    if(error)return res.status(400).json({message:error});
    const saved=await PlaylistModel.findOneAndUpdate({key:'footer'},{$set:parsed.data},{upsert:true,new:true,setDefaultsOnInsert:true});
    res.json({item:{enabled:saved.enabled,archiveIds:saved.archiveIds,updatedAt:saved.updatedAt}});
  });
  app.get('/api/player/playlist',async(_req,res)=>{
    const row=await PlaylistModel.findOne({key:'footer'});
    const ids=row?.enabled===false?[]:(row?.archiveIds||[]);
    const rows=await publicSongs(ArchiveModel);
    const byId=new Map(rows.map(item=>[item.externalId,item]));
    const items=ids.map(id=>byId.get(id)).filter(item=>item&&isArchiveAudio(item.audioUrl)).map(item=>({id:item.externalId,title:item.title,artist:item.artist||'DJ Khalil',audioUrl:deliveryUrl(item.audioUrl),coverImage:deliveryUrl(item.coverImage||item.image||''),duration:item.duration||''}));
    res.set('Cache-Control','no-store').json({enabled:row?.enabled??true,items});
  });
}
module.exports={registerArchivePlayer,FooterPlaylist,playlistInput,isCloudinaryAudio,isArchiveAudio,validatePlaylistSelection};
