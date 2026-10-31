const { randomUUID } = require('crypto');

// A song, title, goal, or status edit must not change the audience's room.
function sessionKey(stream) {
  if (!stream?.isLive) return null;
  return String(stream.webrtcRoomName || stream.broadcastSessionId || '') || null;
}

function externalBroadcastId(current, next) {
  if (!next.isLive) return '';
  return current?.isLive && current.broadcastMode === 'youtube' && current.streamUrl === next.streamUrl && current.broadcastSessionId
    ? current.broadcastSessionId : randomUUID();
}

function requestScope(session) {
  return { $or: [
    { broadcastSessionId: session },
    { broadcastSessionId: { $in: ['', null] }, broadcastRoomName: session },
  ] };
}

function memberName(user) {
  return ([user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || 'Member').slice(0, 60);
}

module.exports = { sessionKey, externalBroadcastId, requestScope, memberName };
