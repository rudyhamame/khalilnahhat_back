const { randomUUID, randomBytes, createHmac, timingSafeEqual } = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const mongoose = require('mongoose');
const root = path.resolve(process.env.MUSIC_ARCHIVE_STORAGE_DIR || path.join(__dirname, '../data/music-archive'));
const secret = process.env.MUSIC_ARCHIVE_PREVIEW_SECRET || randomBytes(32).toString('hex');
const prefix = '/api/music-archive/media/';
const localAssetPattern = /^\/api\/music-archive\/media\/[a-f0-9-]{36}$/;
const Asset = mongoose.models.MusicArchiveFile || mongoose.model('MusicArchiveFile', new mongoose.Schema({
  externalId:{type:String,unique:true,required:true},mime:String,size:Number,originalName:String,
},{timestamps:true}));
const digest = (url, expires) => createHmac('sha256',secret).update(`${url}:${expires}`).digest('hex');
function previewUrl(url) {
  if (!localAssetPattern.test(url)) return url;
  const expires = Math.floor(Date.now()/1000)+3600;
  return `${url}?expires=${expires}&signature=${digest(url,expires)}`;
}
function validPreview(url, query) {
  const expires = Number(query.expires);
  if (!Number.isInteger(expires) || expires < Date.now()/1000 || expires > Date.now()/1000+3601 || typeof query.signature !== 'string' || !/^[a-f0-9]{64}$/.test(query.signature)) return false;
  return timingSafeEqual(Buffer.from(query.signature),Buffer.from(digest(url,expires)));
}
async function saveLocalFile(file, {AssetModel=Asset,directory=root} = {}) {
  const id = randomUUID(); const filename = path.join(directory,id);
  await fsp.mkdir(directory,{recursive:true,mode:0o700});
  await fsp.writeFile(filename,file.buffer,{flag:'wx',mode:0o600});
  try { await AssetModel.create({externalId:id,mime:file.mimetype,size:file.buffer.length,originalName:file.originalname}); }
  catch (error) { await fsp.unlink(filename).catch(()=>{}); throw error; }
  const url = prefix+id;
  return {url,previewUrl:previewUrl(url),duration:''};
}
function registerArchiveFiles(app,{publicSongs,Collection,AssetModel=Asset,directory=root}) {
  app.get(`${prefix}:id`, async (req,res,next) => {
    const url = prefix+req.params.id;
    if (!localAssetPattern.test(url)) return res.status(404).end();
    try {
      if (!validPreview(url,req.query)) {
        const songs = await publicSongs();
        let published = songs.some(song=>song.audioUrl===url || song.coverImage===url);
        if (!published) {
          published = Boolean(await Collection.exists({coverImage:url,published:true}));
        }
        if (!published) return res.status(404).end();
      }
      const asset = await AssetModel.findOne({externalId:req.params.id});
      if (!asset) return res.status(404).end();
      const filename = path.join(directory,req.params.id);
      const stat = await fsp.stat(filename);
      res.set({'Content-Type':asset.mime,'X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes','Cache-Control':'private, no-store'});
      let start = 0, end = stat.size-1;
      if (req.headers.range) {
        const range = req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
        if (!range || (!range[1]&&!range[2])) return res.status(416).set('Content-Range',`bytes */${stat.size}`).end();
        if (!range[1]) start = Math.max(0,stat.size-Number(range[2]));
        else { start = Number(range[1]); if (range[2]) end = Math.min(end,Number(range[2])); }
        if (start>end || start>=stat.size) return res.status(416).set('Content-Range',`bytes */${stat.size}`).end();
        res.status(206).set('Content-Range',`bytes ${start}-${end}/${stat.size}`);
      }
      res.set('Content-Length',String(end-start+1));
      fs.createReadStream(filename,{start,end}).on('error',next).pipe(res);
    } catch (error) { if (error.code==='ENOENT') return res.status(404).end(); next(error); }
  });
}
async function readLocalAudio(url,maxBytes){
 if(!localAssetPattern.test(url))throw Error('Invalid audio source.');
 const id=url.slice(prefix.length),asset=await Asset.findOne({externalId:id}).lean();
 if(!asset||!/^audio\/|^video\//.test(asset.mime||''))throw Error('Audio asset not found.');
 const filename=path.join(root,id),stat=await fsp.stat(filename);
 if(stat.size>maxBytes)throw Object.assign(Error('Choose recording audio under 25 MB for transcription.'),{status:400});
 return {buffer:await fsp.readFile(filename),originalname:asset.originalName,mimetype:asset.mime,size:stat.size};
}
module.exports={localAssetPattern,previewUrl,validPreview,saveLocalFile,registerArchiveFiles,readLocalAudio};
