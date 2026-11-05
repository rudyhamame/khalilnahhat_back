const mongoose = require('mongoose');
const { z } = require('zod');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
const { TrackSource } = require('@livekit/protocol');
const { User } = require('./models');
const { isAdminUser } = require('./admin-role');
const { Presence, ONLINE_WINDOW_MS } = require('./echo-project-chat');

const Call = mongoose.models.EchoProjectChatCall || mongoose.model('EchoProjectChatCall', new mongoose.Schema({
  callerId: {type:String, required:true}, calleeId: {type:String, required:true},
  callerName:String, calleeName:String, callerClient:String, calleeClient:String,
  state: {type:String, enum:['ringing','active','ended'], default:'ringing'},
  callerAt:Date, calleeAt:Date, ringUntil:Date, acceptedAt:Date, endedAt:Date,
}, {timestamps:true}));
Call.schema.index({callerId:1,state:1}); Call.schema.index({calleeId:1,state:1});
const Lock = mongoose.models.EchoProjectChatCallLock || mongoose.model('EchoProjectChatCallLock', new mongoose.Schema({_id:String, callId:String, expiresAt:Date}));
Lock.schema.index({expiresAt:1},{expireAfterSeconds:0});
const actor = req => req.user || req.authUser;
const identity = req => String(actor(req)?._id || actor(req)?.id || '');
const participant = id => ({$or:[{callerId:id},{calleeId:id}]});
const name = user => [user.firstName,user.lastName].filter(Boolean).join(' ') || user.username || 'Admin';
const view = call => ({id:String(call._id),callerId:call.callerId,calleeId:call.calleeId,callerName:call.callerName,calleeName:call.calleeName,state:call.state,callerClient:call.callerClient,calleeClient:call.calleeClient,createdAt:call.createdAt,acceptedAt:call.acceptedAt,ringUntil:call.ringUntil});
const failure = (status,message) => Object.assign(Error(message),{status});
const roomName = call => `echo-admin-call-${call._id}`;

function registerEchoProjectChatCalls(app,{requireAdmin,getConfig}) {
  const closeRoom = async call => {
    try { const {wsUrl,apiKey,apiSecret} = getConfig(); await new RoomServiceClient(wsUrl.replace(/^wss:/,'https:'),apiKey,apiSecret).deleteRoom(roomName(call)); }
    catch { /* Clients also disconnect on the next call-status poll. No credentials are logged. */ }
  };
  const finish = async (filter) => {
    const call = await Call.findOneAndUpdate({...filter,state:{$in:['ringing','active']}},{$set:{state:'ended',endedAt:new Date()}},{new:true}).lean();
    if (call) { await Lock.deleteMany({callId:String(call._id)}); await closeRoom(call); }
    return call;
  };
  const expire = async id => {
    const stale = {$or:[{state:'ringing',ringUntil:{$lte:new Date()}},{state:'ringing',callerAt:{$lt:new Date(Date.now()-45000)}},{state:'active',$or:[{callerAt:{$lt:new Date(Date.now()-45000)}},{calleeAt:{$lt:new Date(Date.now()-45000)}}]}]};
    const rows = await Call.find({$and:[participant(id),stale]}).limit(4).lean();
    for (const call of rows) await finish({_id:call._id,$and:[stale]});
  };
  const route = fn => async(req,res) => {
    if (!identity(req)) return res.status(401).json({message:'Sign in to use voice calls.'});
    res.set('Cache-Control','no-store');
    try { await fn(req,res); }
    catch (error) { res.status(error.status || 503).json({message:error.status ? error.message : 'Voice calling is temporarily unavailable.'}); }
  };
  const root = '/api/echo-project-chat/calls';
  app.get(root,requireAdmin,route(async(req,res) => {
    const client=z.string().uuid().safeParse(req.query.clientId);
    if (!client.success) throw failure(400,'Invalid call client.');
    const id=identity(req); await expire(id);
    const call = await Call.findOne({...participant(id),state:{$in:['ringing','active']}}).sort({createdAt:-1}).lean();
    if (call && (call.callerId===id?call.callerClient:call.calleeClient)===client.data) {
      await Call.updateOne({_id:call._id,state:call.state},{$set:{[call.callerId===id?'callerAt':'calleeAt']:new Date()}});
      await Lock.updateOne({_id:id,callId:String(call._id)},{$set:{expiresAt:new Date(Date.now()+70000)}});
    }
    let ready=true; try { getConfig(); } catch { ready=false; }
    res.json({call:call?view(call):null,ready});
  }));
  app.post(root,requireAdmin,route(async(req,res) => {
    getConfig();
    const parsed=z.object({calleeId:z.string().regex(/^[a-f\d]{24}$/i),clientId:z.string().uuid()}).strict().safeParse(req.body);
    if (!parsed.success || parsed.data.calleeId===identity(req)) throw failure(400,'Choose another online administrator to call.');
    const id=identity(req), other=parsed.data.calleeId;
    const user=await User.findById(other).lean();
    if (!user || user.isBlocked || !isAdminUser(user)) throw failure(404,'Administrator is not available.');
    if (!await Presence.exists({userId:other,lastSeenAt:{$gt:new Date(Date.now()-ONLINE_WINDOW_MS)}})) throw failure(409,'This administrator is offline.');
    await expire(id); await expire(other);
    const callId=new mongoose.Types.ObjectId(), now=new Date();
    try {
      // Globally ordered, leased per-user locks prevent simultaneous or crossed calls.
      for (const userId of [id,other].sort()) {
        try { await Lock.findOneAndUpdate({_id:userId,expiresAt:{$lte:now}},{$set:{callId:String(callId),expiresAt:new Date(Date.now()+70000)}},{upsert:true,new:true}); }
        catch (error) { if (error.code===11000) throw failure(409,'One of you is already in a call.'); throw error; }
      }
      const call=await Call.create({_id:callId,callerId:id,calleeId:other,callerName:name(actor(req)),calleeName:name(user),callerClient:parsed.data.clientId,callerAt:now,calleeAt:now,ringUntil:new Date(Date.now()+60000)});
      res.status(201).json({call:view(call)});
    } catch (error) { await Lock.deleteMany({callId:String(callId)}); throw error; }
  }));
  app.post(root+'/:id/accept',requireAdmin,route(async(req,res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw failure(400,'Invalid call.');
    const client=z.object({clientId:z.string().uuid()}).strict().safeParse(req.body);
    if (!client.success) throw failure(400,'Invalid call client.');
    const id=identity(req); await expire(id);
    const call=await Call.findOneAndUpdate({_id:req.params.id,calleeId:id,state:'ringing',ringUntil:{$gt:new Date()}},{$set:{state:'active',acceptedAt:new Date(),calleeAt:new Date(),calleeClient:client.data.clientId}},{new:true}).lean();
    if (!call) throw failure(409,'This call is no longer ringing.');
    res.json({call:view(call)});
  }));
  app.post(root+'/:id/end',requireAdmin,route(async(req,res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw failure(400,'Invalid call.');
    const filter={_id:req.params.id,...participant(identity(req))};
    const call=await finish(filter);
    if (!call && !await Call.exists(filter)) throw failure(404,'Call not found.');
    res.json({ended:true,id:req.params.id});
  }));
  app.post(root+'/:id/join',requireAdmin,route(async(req,res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw failure(400,'Invalid call.');
    const client=z.object({clientId:z.string().uuid()}).strict().safeParse(req.body);
    if (!client.success) throw failure(400,'Invalid call client.');
    const id=identity(req); await expire(id);
    const call=await Call.findOne({_id:req.params.id,...participant(id),state:'active'}).lean();
    if (!call) throw failure(409,'This call has ended or has not been accepted.');
    if ((call.callerId===id?call.callerClient:call.calleeClient)!==client.data.clientId) throw failure(409,'This call is open in another tab.');
    const other=await User.findById(call.callerId===id?call.calleeId:call.callerId).lean();
    if (!other || other.isBlocked || !isAdminUser(other)) { await finish({_id:call._id}); throw failure(403,'The other administrator is no longer available.'); }
    const {apiKey,apiSecret,wsUrl}=getConfig();
    const token=new AccessToken(apiKey,apiSecret,{identity:id,name:name(actor(req)),ttl:'90s'});
    token.addGrant({room:roomName(call),roomJoin:true,canSubscribe:true,canPublish:true,canPublishSources:[TrackSource.MICROPHONE],canPublishData:false});
    res.json({url:wsUrl,token:await token.toJwt(),call:view(call)});
  }));
}
module.exports={registerEchoProjectChatCalls,Call,Lock};
