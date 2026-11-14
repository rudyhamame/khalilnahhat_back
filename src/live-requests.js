const permanentDeletion=require('./permanent-deletion');
const {audioFields}=require('./live-request-audio');
const {sessionKey:liveBroadcastSession,requestScope,memberName}=require('./live-interactions');
// Manual dashboard and Echo AI Administrator dispatch through these same handlers.
function registerLiveRequestRoutes(app,{
 requireAuth,requireAdmin,getLiveStreamConfig,LiveRequest,LiveSession,
 liveRequestAnalysisSchema,liveRequestCheckoutSchema,liveRequestReviewSchema,
 getOrderedLiveSessions,analyzeLiveRequest,buildDirectRequestMetadata,createCode,
 buildReorderedQueue,serializeLiveRequest,serializeLiveSession,
}) {
app.post('/api/live-requests/analyze', requireAuth, async (request, response) => {
  const parsed = liveRequestAnalysisSchema.safeParse(request.body);

  if (!parsed.success) {
    return response.status(400).json({
      message: 'Live request analysis payload failed validation.',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const liveSessions = await getOrderedLiveSessions();
  const analysis = await analyzeLiveRequest(parsed.data.message, liveSessions, {
    requesterName: parsed.data.requesterName,
  });

  if (!analysis.metadata.track) {
    return response.status(400).json({
      message: 'The request agent could not recognize a song title yet.',
    });
  }

  return response.json({
    analysis: {
      metadata: analysis.metadata,
      duplicateSessionId: analysis.duplicateSession?.externalId || '',
      duplicateTrack: analysis.duplicateSession?.track || '',
      suggestedInsertAfterId: analysis.insertion.insertAfterId,
      suggestedInsertBeforeId: analysis.insertion.insertBeforeId,
      suggestedInsertLabel: analysis.insertion.label,
      aiSummary: analysis.summary,
    },
  });
});

// Song requests are free; every request waits for Khalil's review before it is used.
async function createLiveRequest(request, response) {
  const session = liveBroadcastSession(await getLiveStreamConfig());
  if (!session || request.body?.session !== session) return response.status(409).json({ message: 'Refresh to request a song for the current live broadcast.' });
  const parsed = liveRequestCheckoutSchema.safeParse(request.body);

  if (!parsed.success) {
    return response.status(400).json({
      message: 'Live request payload failed validation.',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  if (!require('./live-rate-limit').consumeLiveQuota(request.authUser._id,parsed.data.requests.length)) return response.status(429).set('Retry-After','60').json({message:'Please wait a minute before sending more song requests.'});
  const requestGroupId = createCode('GROUP');
  await LiveRequest.insertMany(parsed.data.requests.map((item) => ({
    externalId: `live-request-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    requesterName: memberName(request.authUser),
    requesterEmail: request.authUser.email,
    requesterUserId: String(request.authUser._id),
    broadcastSessionId: session,
    requestGroupId,
    confirmationCode: createCode('REQ'),
    message: item.message,
    ...buildDirectRequestMetadata(item.message),
    requestStatus: 'pending_admin',
    paymentStatus: 'none',
    aiSummary: 'Awaiting Khalil review.',
  })));

  return response.status(201).json({ message: 'Request sent. Khalil will review it.' });
}

app.post('/api/live-requests/checkout', requireAuth, createLiveRequest);
app.post('/api/live-requests', requireAuth, createLiveRequest);

app.get('/api/live-requests/admin', requireAdmin, async (request, response) => {
  const session = request.query.broadcast === 'current' ? liveBroadcastSession(await getLiveStreamConfig()) : undefined;
  if (session === null) return response.json({ session: null, items: [] });
  const requests = await LiveRequest.find({ paymentStatus: { $in: ['paid', 'none'] }, ...(session ? requestScope(session) : {}) }).sort({ createdAt: -1 }).limit(200);
  response.set('Cache-Control', 'no-store');

  return response.json({
    session, items: requests.map(serializeLiveRequest),
  });
});

app.delete('/api/live-requests/:id', requireAdmin, async (request, response) => {
  const deleted = await permanentDeletion.remove(LiveRequest,{externalId:request.params.id});

  if (!deleted) {
    return response.status(404).json({
      message: 'Live request not found.',
    });
  }

  return response.json({
    id: deleted.externalId,
    message: 'Audience request deleted.',
  });
});

app.post('/api/live-requests/:id/recover', requireAdmin, async(request,response)=>{
 const session=liveBroadcastSession(await getLiveStreamConfig());
 if(!session||request.body?.session!==session)return response.status(409).json({message:'The live stream changed. Refresh its requests.'});
 const item=await LiveRequest.findOne({externalId:request.params.id,...requestScope(session)});
 if(!item)return response.status(404).json({message:'Request not found in this broadcast.'});
 if(item.requestStatus!=='reviewing'||Date.now()-new Date(item.updatedAt).getTime()<120000)return response.status(409).json({message:'This review is still running. Wait two minutes before recovering it.'});
 const existing=await LiveSession.findOne({requestExternalId:item.externalId});
 const recovered=await LiveRequest.findOneAndUpdate({_id:item._id,requestStatus:'reviewing',updatedAt:item.updatedAt},{$set:{requestStatus:existing?'approved':'pending_admin',createdSessionExternalId:existing?.externalId||''}},{new:true});
 if(!recovered)return response.status(409).json({message:'The review changed. Refresh its status.'});
 return response.json({item:serializeLiveRequest(recovered)});
});

app.patch('/api/live-requests/:id/review', requireAdmin, async (request, response) => {
  const parsed = liveRequestReviewSchema.safeParse(request.body);

  if (!parsed.success) {
    return response.status(400).json({
      message: 'Live request review payload failed validation.',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const liveRequest = await LiveRequest.findOne({ externalId: request.params.id });

  if (!liveRequest) {
    return response.status(404).json({
      message: 'Live request not found.',
    });
  }

  const session = liveBroadcastSession(await getLiveStreamConfig());
  if (!session || parsed.data.session !== session || (liveRequest.broadcastSessionId || liveRequest.broadcastRoomName) !== session) return response.status(409).json({message:'The live stream changed. Refresh before reviewing requests.'});
  if (liveRequest.requestStatus !== 'pending_admin') return response.status(409).json({message:'This request has already been reviewed.',item:serializeLiveRequest(liveRequest)});
  if (parsed.data.decision === 'rejected') {
    const rejected = await LiveRequest.findOneAndUpdate({_id:liveRequest._id,requestStatus:'pending_admin'},{$set:{requestStatus:'rejected',adminNote:parsed.data.adminNote}},{new:true});
    if (!rejected) return response.status(409).json({message:'This request was already reviewed.'});
    liveRequest.requestStatus = rejected.requestStatus;
    liveRequest.adminNote = rejected.adminNote;

    return response.json({
      item: serializeLiveRequest(liveRequest),
    });
  }

  const existing = await LiveSession.findOne({requestExternalId:liveRequest.externalId});
  if (existing) {
    const recovered=await LiveRequest.findOneAndUpdate({_id:liveRequest._id,requestStatus:'pending_admin'},{$set:{requestStatus:'approved',createdSessionExternalId:existing.externalId,adminNote:parsed.data.adminNote}},{new:true});
    if(!recovered)return response.status(409).json({message:'This request is already being reviewed.'});
    return response.json({item:serializeLiveRequest(recovered),liveSessions:(await getOrderedLiveSessions()).map(serializeLiveSession)});
  }
  const claimed = await LiveRequest.updateOne({_id:liveRequest._id, requestStatus:'pending_admin'}, {$set:{requestStatus:'reviewing'}});
  if (!claimed.modifiedCount) return response.status(409).json({message:'This request is being reviewed. Refresh its status.'});
  try {
  const liveSessions = await getOrderedLiveSessions();
  const analysis = await analyzeLiveRequest(liveRequest.message, liveSessions, {
    requesterName: liveRequest.requesterName,
    track: liveRequest.track,
    artist: liveRequest.artist,
    duration: liveRequest.duration,
    genre: liveRequest.genre,
    genres: liveRequest.genres,
    subgenres: liveRequest.subgenres,
    language: liveRequest.language,
    mood: liveRequest.mood,
    musicMoods: liveRequest.musicMoods,
    instruments: liveRequest.instruments,
    bpm: liveRequest.bpm,
    musicalKey: liveRequest.musicalKey,
    vocals: liveRequest.vocals,
    energy: liveRequest.energy,
    beat: liveRequest.beat,
    themes: liveRequest.themes,
    explicit: liveRequest.explicit,
    sourcePlatform: liveRequest.sourcePlatform,
    sourceUrl: liveRequest.sourceUrl,
    thumbnailUrl: liveRequest.thumbnailUrl,
  });

  const duplicate = analysis.duplicateSession;
  if (duplicate) {
    liveRequest.requestStatus = 'duplicate';
    liveRequest.duplicateSessionExternalId = duplicate.externalId;
    liveRequest.adminNote =
      parsed.data.adminNote || `Duplicate found: ${duplicate.track} is already in the live session list.`;
    await liveRequest.save();

    return response.json({
      message: 'This song is already in the set list.',
      item: serializeLiveRequest(liveRequest),
    });
  }

  if (session !== liveBroadcastSession(await getLiveStreamConfig())) throw Object.assign(new Error('The broadcast ended during review. Refresh its status.'),{status:409});
  const createdSession = await LiveSession.findOneAndUpdate({requestExternalId:liveRequest.externalId}, {$setOnInsert:{
    externalId: `live-session-request-${liveRequest.externalId}`,
    track: liveRequest.track,
    artist: liveRequest.artist,
    duration: liveRequest.duration,
    genre: liveRequest.genre,
    genres: liveRequest.genres,
    subgenres: liveRequest.subgenres,
    language: liveRequest.language,
    musicMoods: liveRequest.musicMoods,
    instruments: liveRequest.instruments,
    bpm: liveRequest.bpm,
    musicalKey: liveRequest.musicalKey,
    vocals: liveRequest.vocals,
    energy: liveRequest.energy,
    beat: liveRequest.beat,
    themes: liveRequest.themes,
    explicit: liveRequest.explicit,
    ...audioFields(liveRequest),
    playState: 'requested',
    sortOrder: 0,
    sourcePlatform: liveRequest.sourcePlatform,
    sourceUrl: liveRequest.sourceUrl,
    requestExternalId: liveRequest.externalId,
  }}, {upsert:true,new:true});

  // A conversion may finish while approval is building the queue. Re-read ready
  // audio after insertion so that approving an already-converted request keeps it.
  const readyAudio=await LiveRequest.findOne({_id:liveRequest._id});
  if(readyAudio?.audioUrl)await LiveSession.updateOne({_id:createdSession._id},{$set:audioFields(readyAudio)});
  const reorderedQueue = buildReorderedQueue(liveSessions, createdSession, analysis.insertion.insertIndex);
  await Promise.all(
    reorderedQueue.map(({ session, sortOrder }) =>
      LiveSession.updateOne(
        { _id: session._id },
        { sortOrder },
      ),
    ),
  );

  liveRequest.requestStatus = 'approved';
  liveRequest.adminNote = parsed.data.adminNote;
  liveRequest.createdSessionExternalId = createdSession.externalId;
  liveRequest.suggestedInsertAfterId = analysis.insertion.insertAfterId;
  liveRequest.suggestedInsertBeforeId = analysis.insertion.insertBeforeId;
  liveRequest.suggestedInsertLabel = analysis.insertion.label;
  await liveRequest.save();

  const refreshedLiveSessions = await getOrderedLiveSessions();

  return response.json({
    item: serializeLiveRequest(liveRequest),
    liveSessions: refreshedLiveSessions.map(serializeLiveSession),
  });
  } catch (error) {
    await LiveRequest.updateOne({_id:liveRequest._id,requestStatus:'reviewing'},{$set:{requestStatus:'pending_admin'}});
    throw error;
  }
});

}
module.exports={registerLiveRequestRoutes};
