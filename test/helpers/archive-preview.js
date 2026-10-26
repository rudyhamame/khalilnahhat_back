// Local browser QA only. No database, credentials, email, or cloud uploads.
// Run explicitly: node test/helpers/archive-preview.js
const express = require('express');
const { memoryModel } = require('./archive-memory');
const { registerMusicArchive } = require('../../src/music-archive');
const app = express(); app.use(express.json());
app.use((_req,res,next)=>{res.set('Access-Control-Allow-Origin','*');next();});
const categories = memoryModel([{externalId:'qa-entrances',title:'Wedding Entrances',description:'Browser review collection',published:true},{externalId:'qa-remixes',title:'DJ Remixes',published:true}]);
const albums = memoryModel([{externalId:'qa-2026',title:'Wedding Entrances 2026',description:'A collection for unforgettable first moments.',categoryId:'qa-entrances',year:2026,published:true},{externalId:'qa-2025',title:'Remixes 2025',description:'Selected sounds, reimagined.',categoryId:'qa-remixes',year:2025,published:true}]);
const songs = memoryModel([{externalId:'qa-song-1',title:'Entrance — QA recording',artist:'DJ Khalil',description:'Test catalog only; not a published client recording.',albumId:'qa-2026',date:'2026-10-24',published:true,audioUrl:'/__qa-tone.wav',duration:'0:06'}, {externalId:'qa-song-2',title:'Remix — QA recording',artist:'DJ Khalil',albumId:'qa-2025',published:true,date:'2025-05-01',audioUrl:'/__qa-tone.wav',duration:'0:06'}]);
const requireAdmin = (req,res,next) => req.headers.authorization === 'Bearer archive-preview-only' ? next() : res.status(401).json({message:'Sign in required.'});
app.get('/api/auth/me', requireAdmin, (_req,res) => res.json({user:{username:'Archive preview',isAdmin:true}}));
app.get('/api/bootstrap', (_req,res) => res.json({liveSessions:[],archiveItems:[],liveStream:{isLive:false}}));
app.get('/api/player/playlist', (_req,res) => res.json({enabled:true,items:[]}));
app.get('/api/admin/player-playlist', requireAdmin, (_req,res) => res.json({item:{enabled:true,archiveIds:[]}}));
app.post('/api/admin/music-archive/upload', requireAdmin, (_req,res) => res.status(400).json({message:'Cloud uploads are disabled in this isolated QA preview.'}));
app.get('/__qa-tone.wav', (_req,res) => {
  const rate = 16000, length = rate * 60, body = Buffer.alloc(44 + length * 2);
  body.write('RIFF'); body.writeUInt32LE(body.length - 8, 4); body.write('WAVEfmt ', 8); body.writeUInt32LE(16, 16); body.writeUInt16LE(1, 20); body.writeUInt16LE(1, 22); body.writeUInt32LE(rate, 24); body.writeUInt32LE(rate * 2, 28); body.writeUInt16LE(2, 32); body.writeUInt16LE(16, 34); body.write('data', 36); body.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) body.writeInt16LE(Math.round(Math.sin(i * Math.PI * 440 / rate) * 1000), 44 + i * 2);
  res.type('audio/wav').send(body);
});
registerMusicArchive(app,{requireAdmin,CategoryModel:categories,AlbumModel:albums,ArchiveModel:songs});
for (const song of songs.rows) { song.audioUrl = 'http://127.0.0.1:4313/__qa-tone.wav'; song.duration = '1:00'; }
app.get('/api/admin/:unused',requireAdmin,(_req,res)=>res.json({items:[]}));
app.listen(4313,'127.0.0.1',()=>console.log('In-memory archive QA on 127.0.0.1:4313'));
