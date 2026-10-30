const ADMIN_USERNAME = 'khalilnahhat';
// More owners can be allowed without code changes: ADMIN_USERNAMES="name1,name2" (existing accounts) and ADMIN_GOOGLE_EMAILS for Google sign-in.
const list = value => String(value || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
const ADMIN_USERNAMES = new Set([ADMIN_USERNAME, ...list(process.env.ADMIN_USERNAMES)]);
const ADMIN_GOOGLE_EMAILS = ['khalilnahhatdj@gmail.com', ...list(process.env.ADMIN_GOOGLE_EMAILS)];

const defaultLiveSessions = [];

const defaultArchiveItems = [];

const defaultLiveStreamConfig = {
  key: 'primary',
  isLive: false,
  title: '',
  streamUrl: '',
  posterImage: '',
  statusLabel: 'Offline until Khalil starts the next OBS stream.',
  activeSessionId: '',
  muxLiveStreamId: '',
  muxPlaybackId: '',
  muxStreamKey: '',
  muxRtmpUrl: 'rtmps://global-live.mux.com:443/app',
  broadcastMode: 'youtube',
  webrtcRoomName: '',
};

module.exports = {
  ADMIN_USERNAME,
  ADMIN_USERNAMES,
  ADMIN_GOOGLE_EMAILS,
  defaultArchiveItems,
  defaultLiveSessions,
  defaultLiveStreamConfig,
};
