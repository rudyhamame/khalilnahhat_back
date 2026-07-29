const ADMIN_USERNAME = 'khalilnahhat';

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
};

module.exports = {
  ADMIN_USERNAME,
  defaultArchiveItems,
  defaultLiveSessions,
  defaultLiveStreamConfig,
};
