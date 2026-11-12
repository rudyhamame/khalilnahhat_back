const permanentDeletion=require('./permanent-deletion');
const accountSessions = require('./account-sessions');
const {uploadAsset}=require('./cloudinary-assets');
const {findPasswordAccount}=require('./password-account');
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const { notifyLiveTransition } = require('./live-start-emails');
const { sessionKey: liveBroadcastSession, externalBroadcastId } = require('./live-interactions');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { AccessToken, RoomServiceClient, WebhookReceiver, IngressClient } = require('livekit-server-sdk');
const { z } = require('zod');
const { connectToDatabase, MONGODB_DB_NAME } = require('./db');
const { ADMIN_USERNAME, ADMIN_USERNAMES, ADMIN_GOOGLE_EMAILS, defaultLiveStreamConfig } = require('./default-data');
const {isAdminUser}=require('./admin-role');
const {
  ArchiveItem,
  Booking,
  LiveRequest,
  LiveSession,
  LiveStreamConfig,
  ServiceRequest,
  ServicePrice,
  User,
} = require('./models');
const {
  LIVE_PLAY_STATES,
  analyzeLiveRequest,
  buildReorderedQueue,
} = require('./live-request-agent');
const { registerServiceRequestSubmission } = require('./service-request-submission');
const vouchers = require('./vouchers');
const eventOrder = require('./event-order');
const { Equipment } = require('./equipment');
const { registerEquipmentRoutes } = require('./equipment');
const { registerPayments } = require('./payments');
const { registerPlanning } = require('./planning');
const { registerMeetings, Meeting: MeetingModel } = require('./meetings');
const { registerMeetingRoom } = require('./meeting-room');
const { registerAccount, sendVerification } = require('./account');
const { registerContent } = require('./content');
const { DAY_MS, quoteTotals, registerQuoteLifecycle } = require('./quote-lifecycle');
const { createSessionToken, hashPassword, verifyPassword } = require('./security');
const { convertYoutubeToWav, normalizeYoutubeUrl } = require('./youtube-audio');
const { createYoutubeSessionStore, registerYoutubeSessionRoutes } = require('./youtube-session');
const {
  sendServiceQuoteNotification,
  sendServiceRequestNotification,
} = require('./brevo');

const app = express();
// Trust only the configured origin proxy; never trust arbitrary forwarding headers.
require('./security-controls').configureSecurity(app);
const PORT = process.env.PORT || 4000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 12, fieldSize: 64 * 1024 } });
const liveRequestPriceCents = 0;
const liveRequestCurrency = 'cad';

function getFrontendUrl() {
  return (process.env.FRONTEND_URL || process.env.PUBLIC_APP_URL || 'https://djkhalilnahhat.ca').replace(/\/+$/, '');
}

function serializeServicePrice(price, equipment = []) {
  return {
    ...require('./equipment-stock').priceStockView(price, equipment),
    id: price.serviceId,
    name: price.name,
    category: price.category,
    amountCents: price.amountCents,
    currency: price.currency,
    isActive: price.isActive,
  };
}

const bookingSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required.'),
  email: z.string().trim().email('A valid email is required.'),
  phone: z.string().trim().optional().default(''),
  organization: z.string().trim().optional().default(''),
  eventType: z.string().trim().min(1, 'Event type is required.'),
  eventDate: z.string().trim().min(1, 'Event date is required.'),
  city: z.string().trim().min(1, 'City is required.'),
  country: z.string().trim().min(1, 'Country is required.'),
  venueName: z.string().trim().optional().default(''),
  attendance: z.string().trim().optional().default(''),
  setDuration: z.string().trim().optional().default(''),
  musicDirection: z.string().trim().optional().default(''),
  budgetRange: z.string().trim().min(1, 'Budget range is required.'),
  notes: z.string().trim().optional().default(''),
  consent: z.literal(true),
});

const signupSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required.'),
  lastName: z.string().trim().min(1, 'Last name is required.'),
  username: z.string().trim().min(1).optional(),
  password: z.string().min(12, 'Choose a password of at least 12 characters.').max(128),
  email: z.string().trim().email('A valid email is required.'),
  phoneNumber: z.string().trim().min(1, 'Phone number is required.'),
});

const loginSchema = z.object({
  email: z.string().trim().email('A valid email address is required.').optional(),
  username: z.string().trim().min(1).optional(),
  password: z.string().min(1, 'Password is required.').max(200),
}).refine(value=>value.email||value.username,{message:'Email address is required.'});

const youtubeSearchSchema = z.object({
  query: z.string().trim().min(2, 'Enter at least two characters to search YouTube.'),
});

const liveSessionSchema = z.object({
  track: z.string().trim().min(1, 'Song / music is required.'),
  artist: z.string().trim().optional().default(''),
  duration: z.string().trim().default(''),
  trackClass: z.string().trim().optional().default(''),
  genre: z.string().trim().default(''),
  genres: z.string().trim().optional().default(''),
  subgenres: z.string().trim().optional().default(''),
  language: z.string().trim().default(''),
  musicMoods: z.string().trim().optional().default(''),
  instruments: z.string().trim().optional().default(''),
  bpm: z.string().trim().optional().default(''),
  musicalKey: z.string().trim().optional().default(''),
  vocals: z.string().trim().optional().default(''),
  energy: z.string().trim().optional().default(''),
  beat: z.string().trim().optional().default(''),
  themes: z.string().trim().optional().default(''),
  explicit: z.string().trim().optional().default(''),
  playState: z.enum(LIVE_PLAY_STATES).default('queued'),
  sortOrder: z.coerce.number().optional(),
  sourcePlatform: z.string().trim().optional().default('manual'),
  sourceUrl: z.string().trim().optional().default(''),
  audioUrl: z.string().trim().optional().default(''),
  audioPublicId: z.string().trim().optional().default(''),
  audioOriginalName: z.string().trim().optional().default(''),
  coverImage: z.string().trim().optional().default(''),
  coverPublicId: z.string().trim().optional().default(''),
  coverOriginalName: z.string().trim().optional().default(''),
  coverZoom: z.coerce.number().min(1).max(2.5).optional().default(1),
  coverPositionX: z.coerce.number().min(0).max(100).optional().default(50),
  coverPositionY: z.coerce.number().min(0).max(100).optional().default(50),
});

const liveRequestAnalysisSchema = z.object({
  requesterName: z.string().trim().optional().default('Audience'),
  message: z.string().trim().min(1, 'A song name or music link is required.'),
});

const liveRequestCreateSchema = z.object({
  requesterName: z.string().trim().optional().default('Audience'),
  message: z.string().trim().min(1, 'A song name or music link is required.'),
  metadata: z.object({
    track: z.string().trim().min(1, 'A recognized track title is required.'),
    artist: z.string().trim().optional().default(''),
    duration: z.string().trim().optional().default(''),
    genre: z.string().trim().optional().default(''),
    genres: z.string().trim().optional().default(''),
    subgenres: z.string().trim().optional().default(''),
    language: z.string().trim().optional().default(''),
    mood: z.string().trim().optional().default(''),
    musicMoods: z.string().trim().optional().default(''),
    instruments: z.string().trim().optional().default(''),
    bpm: z.string().trim().optional().default(''),
    musicalKey: z.string().trim().optional().default(''),
    vocals: z.string().trim().optional().default(''),
    energy: z.string().trim().optional().default(''),
    beat: z.string().trim().optional().default(''),
    themes: z.string().trim().optional().default(''),
    explicit: z.string().trim().optional().default(''),
    sourcePlatform: z.string().trim().optional().default('manual'),
    sourceUrl: z.string().trim().optional().default(''),
    thumbnailUrl: z.string().trim().optional().default(''),
    analysisSources: z.array(z.string().trim()).optional().default([]),
  }).optional(),
});

const liveRequestCheckoutSchema = z.object({
  requesterName: z.string().trim().optional().default('Audience'),
  requesterEmail: z.string().trim().email('A valid email is required for the receipt.'),
  requests: z.array(
    z.object({
      message: z.string().trim().min(1, 'Each song request must include a song or link.'),
    }),
  ).min(1, 'Add at least one song request.').max(12, 'You can request up to 12 songs at once.'),
});

function createCode(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

const liveRequestReviewSchema = z.object({
  session: z.string().min(1).max(300),
  decision: z.enum(['approved', 'rejected']),
  adminNote: z.string().trim().optional().default(''),
});

function buildDirectRequestMetadata(message) {
  const urls = Array.from(String(message || '').matchAll(/https?:\/\/[^\s]+/g), (match) => match[0]);
  const sourceUrl = urls[0] || '';
  const sourcePlatform = sourceUrl
    ? (() => {
        try {
          const hostname = new URL(sourceUrl).hostname.toLowerCase();
          if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) return 'youtube';
          if (hostname.includes('spotify.com')) return 'spotify';
          if (hostname.includes('anghami.com')) return 'anghami';
          if (hostname.includes('instagram.com')) return 'instagram';
          if (hostname.includes('facebook.com') || hostname.includes('fb.watch')) return 'facebook';
          if (hostname.includes('tiktok.com')) return 'tiktok';
        } catch {
          return 'link';
        }
        return 'link';
      })()
    : 'manual';
  const track = String(message || '').replace(/https?:\/\/[^\s]+/g, '').replace(/\s+/g, ' ').trim();

  return {
    track: track || 'Song request',
    artist: '',
    duration: '',
    genre: '',
    genres: '',
    subgenres: '',
    language: '',
    mood: '',
    musicMoods: '',
    instruments: '',
    bpm: '',
    musicalKey: '',
    vocals: '',
    energy: '',
    beat: '',
    themes: '',
    explicit: '',
    sourcePlatform,
    sourceUrl,
    thumbnailUrl: '',
    analysisSources: [],
  };
}

const archiveItemSchema = z.object({
  title: z.string().trim().min(1, 'Title is required.'),
  artist: z.string().trim().optional().default(''),
  category: z.string().trim().min(1, 'Category is required.'),
  genre: z.string().trim().optional().default(''),
  duration: z.string().trim().optional().default(''),
  location: z.string().trim().default(''),
  date: z.string().trim().default(''),
  mediaType: z.string().trim().default(''),
  description: z.string().trim().optional().default(''),
  image: z.string().trim().default(''),
  alt: z.string().trim().default(''),
  audioUrl: z.string().trim().optional().default(''),
  audioPublicId: z.string().trim().optional().default(''),
  audioOriginalName: z.string().trim().optional().default(''),
  trackClass: z.string().trim().optional().default(''),
  genres: z.string().trim().optional().default(''),
  subgenres: z.string().trim().optional().default(''),
  language: z.string().trim().optional().default(''),
  musicMoods: z.string().trim().optional().default(''),
  instruments: z.string().trim().optional().default(''),
  bpm: z.string().trim().optional().default(''),
  musicalKey: z.string().trim().optional().default(''),
  vocals: z.string().trim().optional().default(''),
  energy: z.string().trim().optional().default(''),
  beat: z.string().trim().optional().default(''),
  themes: z.string().trim().optional().default(''),
  explicit: z.string().trim().optional().default(''),
  coverImage: z.string().trim().optional().default(''),
  coverPublicId: z.string().trim().optional().default(''),
  coverOriginalName: z.string().trim().optional().default(''),
  coverZoom: z.coerce.number().min(1).max(2.5).optional().default(1),
  coverPositionX: z.coerce.number().min(0).max(100).optional().default(50),
  coverPositionY: z.coerce.number().min(0).max(100).optional().default(50),
});

const liveStreamConfigSchema = z.object({
  isLive: z.boolean().default(false),
  title: z.string().trim().default(''),
  streamUrl: z.string().trim().default(''),
  posterImage: z.string().trim().default(''),
  statusLabel: z.string().trim().default(''),
  activeSessionId: z.string().trim().default(''),
});


const serviceRequestQuoteSchema = z.object({
  items: z.array(z.object({
    serviceId: z.string().trim().min(1),
    unitPrice: z.coerce.number().min(0),
  })).min(1),
  adminNote: z.string().trim().optional().default(''),
  validDays: z.coerce.number().int().min(1).max(60).optional(),
  taxPercent: z.coerce.number().min(0).max(30).optional(),
  depositAmount: z.coerce.number().min(0).optional(),
  discountType: z.enum(['amount','percent']).optional(),
  discountValue: z.coerce.number().min(0).optional(),
  paymentInstructions: z.string().trim().max(1000).optional(),
});

const anamPersonaConfig = {
  name: process.env.ANAM_PERSONA_NAME || 'Cara',
  avatarId: process.env.ANAM_AVATAR_ID || '30fa96d0-26c4-4e55-94a0-517025942e18',
  avatarModel: process.env.ANAM_AVATAR_MODEL || 'cara-4',
  voiceId: process.env.ANAM_VOICE_ID || '6bfbe25a-979d-40f3-a92b-5394170af54b',
  llmId: process.env.ANAM_LLM_ID || 'a7cf662c-2ace-4de1-a21e-ef0fbf144bb7',
  systemPrompt: process.env.ANAM_SYSTEM_PROMPT || 'You are a helpful assistant.',
};

function isFutureDate(dateString) {
  const parsedDate = new Date(dateString);

  if (Number.isNaN(parsedDate.getTime())) {
    return false;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  parsedDate.setHours(0, 0, 0, 0);

  return parsedDate >= today;
}

function createReference(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function serializeUser(user) {
  return {
    id: user.id,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phoneNumber: user.phoneNumber,
    emailVerified: Boolean(user.emailVerified),
    isAdmin: isAdminUser(user),
  };
}

function serializeServiceRequest(serviceRequest, includeQuote = true) {
  const isQuoted = ['quoted', 'accepted', 'expired', 'confirmed'].includes(serviceRequest.status);
  const items = serviceRequest.items.map((item) => {
    const serializedItem = {
      serviceId: item.serviceId,
      name: item.name,
      category: item.category,
      quantity: item.quantity,
    };

    if (includeQuote || isQuoted) {
      serializedItem.unitPrice = item.unitPrice;
      serializedItem.lineTotal = Number(item.unitPrice || 0) * item.quantity;
    }

    return serializedItem;
  });

  return {
    requestNumber: serviceRequest.requestNumber || '',
    voucher: serviceRequest.voucher || null,
    event: serviceRequest.event || null,
    order: serviceRequest.order || null,
    conversation: serviceRequest.conversation || null,
    id: serviceRequest.externalId || serviceRequest.id,
    customerName: serviceRequest.customerName,
    customerUsername: serviceRequest.customerUsername,
    customerEmail: serviceRequest.customerEmail,
    items,
    status: serviceRequest.status,
    currency: serviceRequest.currency || 'CAD',
    adminNote: isQuoted || includeQuote ? serviceRequest.adminNote || '' : '',
    total: isQuoted || includeQuote
      ? items.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0)
      : null,
    createdAt: serviceRequest.createdAt,
    quotedAt: serviceRequest.quotedAt,
    ...(isQuoted || includeQuote ? quoteTotals(serviceRequest) : {}),
    expiresAt: serviceRequest.expiresAt,
    validDays: serviceRequest.validDays,
    changeRequest: serviceRequest.changeRequest || '',
    depositPaidCents: (serviceRequest.payments || []).filter((p) => !p.voided).reduce((sum, p) => sum + (p.amountCents || 0), 0),
    paymentInstructions: serviceRequest.paymentInstructions || '',
    payments: (serviceRequest.payments || []).map((p) => ({ id: String(p._id), kind: p.kind, amountCents: p.amountCents, method: p.method, reference: p.reference, paidAt: p.paidAt, voided: Boolean(p.voided) })),
    planning: serviceRequest.planning || null,
  };
}

function serializeLiveSession(session) {
  return {
    id: session.externalId || session.id,
    track: session.track,
    artist: session.artist || '',
    duration: session.duration,
    trackClass: session.trackClass || '',
    genre: session.genre,
    genres: session.genres || '',
    subgenres: session.subgenres || '',
    language: session.language,
    musicMoods: session.musicMoods || '',
    instruments: session.instruments || '',
    bpm: session.bpm || '',
    musicalKey: session.musicalKey || '',
    vocals: session.vocals || '',
    energy: session.energy || '',
    beat: session.beat || '',
    themes: session.themes || '',
    explicit: session.explicit || '',
    playState: session.playState || 'queued',
    sortOrder: Number(session.sortOrder || 0),
    sourcePlatform: session.sourcePlatform || 'manual',
    sourceUrl: session.sourceUrl || '',
    audioUrl: session.audioUrl || '',
    audioOriginalName: session.audioOriginalName || '',
    coverImage: session.coverImage || '',
    coverPublicId: session.coverPublicId || '',
    coverOriginalName: session.coverOriginalName || '',
    coverZoom: Number(session.coverZoom || 1),
    coverPositionX: Number(session.coverPositionX ?? 50),
    coverPositionY: Number(session.coverPositionY ?? 50),
  };
}

function uploadAudioBufferToCloudinary(file){return uploadAsset(file.buffer,{folder:'khalil/live-sessions',resource_type:'video'});}
function uploadPosterBufferToCloudinary(file){return uploadAsset(file.buffer,{folder:'khalil/live-posters',resource_type:'image'});}
function uploadCoverBufferToCloudinary(file){return uploadAsset(file.buffer,{folder:'khalil/song-covers',resource_type:'image'});}
function serializeLiveRequest(request) {
  return {
    broadcastSessionId: request.broadcastSessionId || request.broadcastRoomName || '',
    id: request.externalId || request.id,
    requesterName: request.requesterName || 'Audience',
    requesterEmail: request.requesterEmail || '',
    requestGroupId: request.requestGroupId || '',
    confirmationCode: request.confirmationCode || '',
    message: request.message,
    track: request.track,
    artist: request.artist || '',
    duration: request.duration || '',
    genre: request.genre || '',
    genres: request.genres || '',
    subgenres: request.subgenres || '',
    language: request.language || '',
    mood: request.mood || '',
    musicMoods: request.musicMoods || '',
    instruments: request.instruments || '',
    bpm: request.bpm || '',
    musicalKey: request.musicalKey || '',
    vocals: request.vocals || '',
    energy: request.energy || '',
    beat: request.beat || '',
    themes: request.themes || '',
    explicit: request.explicit || '',
    sourcePlatform: request.sourcePlatform || 'manual',
    sourceUrl: request.sourceUrl || '',
    thumbnailUrl: request.thumbnailUrl || '',
    audioUrl: request.audioUrl || '',
    audioOriginalName: request.audioOriginalName || '',
    paymentStatus: request.paymentStatus || 'paid',
    receiptSentAt: request.receiptSentAt || null,
    analysisSources: Array.isArray(request.analysisSources) ? request.analysisSources : [],
    requestStatus: request.requestStatus || 'pending_admin',
    broadcastRoomName: request.broadcastRoomName || '',
    duplicateSessionId: request.duplicateSessionExternalId || '',
    suggestedInsertAfterId: request.suggestedInsertAfterId || '',
    suggestedInsertBeforeId: request.suggestedInsertBeforeId || '',
    suggestedInsertLabel: request.suggestedInsertLabel || '',
    aiSummary: request.aiSummary || '',
    adminNote: request.adminNote || '',
    createdSessionId: request.createdSessionExternalId || '',
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

function serializeArchiveItem(item) {
  return {
    id: item.externalId || item.id,
    title: item.title,
    artist: item.artist || '',
    category: item.category,
    genre: item.genre || '',
    duration: item.duration || '',
    location: item.location,
    date: item.date,
    mediaType: item.mediaType,
    description: item.description || '',
    image: item.image,
    alt: item.alt,
    audioUrl: require('./music-archive').deliveryUrl(item.audioUrl),
    audioOriginalName: item.audioOriginalName || '',
    coverImage: require('./music-archive').deliveryUrl(item.coverImage),
    coverPublicId: item.coverPublicId || '',
    coverOriginalName: item.coverOriginalName || '',
    coverZoom: Number(item.coverZoom || 1),
    coverPositionX: Number(item.coverPositionX ?? 50),
    coverPositionY: Number(item.coverPositionY ?? 50),
    trackClass: item.trackClass || '',
    genres: item.genres || '',
    subgenres: item.subgenres || '',
    language: item.language || '',
    musicMoods: item.musicMoods || '',
    instruments: item.instruments || '',
    bpm: item.bpm || '',
    musicalKey: item.musicalKey || '',
    vocals: item.vocals || '',
    energy: item.energy || '',
    beat: item.beat || '',
    themes: item.themes || '',
    explicit: item.explicit || '',
  };
}

function serializeLiveStreamConfig(config) {
  return {
    broadcastSessionId: liveBroadcastSession(config),
    liveStartedAt: config?.liveStartedAt || null,
    isLive: Boolean(config?.isLive),
    title: config?.title || '',
    streamUrl: '',
    requiresSignIn: true,
    posterImage: config?.posterImage || '',
    statusLabel: config?.statusLabel || defaultLiveStreamConfig.statusLabel,
    activeSessionId: config?.activeSessionId || '',
    webrtcRoomName: config?.webrtcRoomName || '',
    broadcastMode: config?.broadcastMode || defaultLiveStreamConfig.broadcastMode,
    broadcastSource: config?.broadcastSource || '',
    goal: config?.goal || 'broadcast',
  };
}

function buildMuxPlaybackUrl(playbackId) {
  return playbackId ? `https://stream.mux.com/${playbackId}.m3u8` : '';
}

function serializeAdminLiveStreamConfig(config) {
  return {
    ...serializeLiveStreamConfig(config),
    streamUrl: config?.streamUrl || '',
    obs: { roomName: config?.obsRoomName || '', state: config?.obsState || '',
      saveRecording: config?.obsSaveRecording !== false,
      url: config?.obsUrl || '', streamKey: config?.obsStreamKey || '', expiresAt: config?.obsExpiresAt || null,
      transport: config?.broadcastMode === 'whep' || (!config?.obsRoomName && require('./obs-relay-client').configured()) ? 'ovh' : 'livekit', error: config?._obsRelayError || '' },
    muxLiveStreamId: config?.muxLiveStreamId || '',
    muxPlaybackId: config?.muxPlaybackId || '',
    muxStreamKey: config?.muxStreamKey || '',
    muxRtmpUrl: config?.muxRtmpUrl || defaultLiveStreamConfig.muxRtmpUrl,
    muxPlaybackUrl: buildMuxPlaybackUrl(config?.muxPlaybackId || ''),
    webrtcRoomName: config?.webrtcRoomName || '',
  };
}

function getLiveKitConfig() {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const wsUrl = process.env.LIVEKIT_URL;

  if (!apiKey || !apiSecret || !wsUrl || !/^wss:\/\/[^/]+/.test(wsUrl)) {
    const error = new Error('LiveKit credentials are not configured on the server.');
    error.status = 503;
    throw error;
  }

  return { apiKey, apiSecret, wsUrl };
}

async function createLiveKitToken({ roomName, identity, name, canPublish }) {
  const { apiKey, apiSecret } = getLiveKitConfig();
  const accessToken = new AccessToken(apiKey, apiSecret, { identity, name, ttl: '10m' });
  accessToken.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish,
    canSubscribe: true,
    canPublishData: canPublish,
  });

  return accessToken.toJwt();
}

function parseCorsOrigins(value) {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

const configuredCorsOrigins = new Set(
  parseCorsOrigins(process.env.CORS_ORIGIN || 'https://djkhalilnahhat.ca'),
);
if (process.env.NODE_ENV === 'production' && [...configuredCorsOrigins].some(origin => origin === '*' || !origin.startsWith('https://'))) {
  throw new Error('Production requires explicit HTTPS frontend origins.');
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function getLiveStreamConfig() {
  let config = await LiveStreamConfig.findOne({ key: defaultLiveStreamConfig.key });

  if (!config) {
    config = await LiveStreamConfig.create(defaultLiveStreamConfig);
  }

  if (config.isLive && !config.webrtcRoomName && !config.broadcastSessionId) {
    config = await LiveStreamConfig.findOneAndUpdate(
      { _id: config._id, isLive: true, updatedAt: config.updatedAt, broadcastSessionId: { $in: ['', null] } },
      { $set: { broadcastSessionId: crypto.randomUUID() } }, { new: true },
    ) || await LiveStreamConfig.findOne({ key: defaultLiveStreamConfig.key });
  }
  const session = liveBroadcastSession(config);
  if (session && config.liveStartedSession !== session) {
    config = await LiveStreamConfig.findOneAndUpdate(
      { _id: config._id, liveStartedSession: { $ne: session } },
      { $set: { liveStartedSession: session, liveStartedAt: new Date() } }, { new: true },
    ) || await LiveStreamConfig.findOne({ key: defaultLiveStreamConfig.key });
  }
  return config;
}

async function getOrderedLiveSessions() {
  return LiveSession.find().sort({ sortOrder: 1, createdAt: 1 });
}

async function getNextLiveSessionSortOrder() {
  const lastSession = await LiveSession.findOne().sort({ sortOrder: -1, createdAt: -1 });
  return lastSession ? Number(lastSession.sortOrder || 0) + 100 : 100;
}

async function createMuxLiveStream(title) {
  const muxTokenId = process.env.MUX_TOKEN_ID;
  const muxTokenSecret = process.env.MUX_TOKEN_SECRET;

  if (!muxTokenId || !muxTokenSecret) {
    const error = new Error('MUX credentials are not configured on the server.');
    error.status = 503;
    throw error;
  }

  const response = await fetch('https://api.mux.com/video/v1/live-streams', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${muxTokenId}:${muxTokenSecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      playback_policies: ['public'],
      new_asset_settings: {
        playback_policies: ['public'],
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload?.error?.messages?.[0] || payload?.message || 'Mux live stream creation failed.');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload.data || {};
}

async function authFromRequest(request) {
  const authorization = request.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';

  if (!token) {
    return null;
  }

  return accountSessions.authenticate(User, token);
}

async function requireAdmin(request, response, next) {
  const user = await authFromRequest(request);

  if (!isAdminUser(user) || user.isBlocked) {
    return response.status(401).json({
      message: 'Admin authentication is required.',
    });
  }

  if (!user.isAdmin) {
    user.isAdmin = true;
    await user.save();
  }

  request.user = accountSessions.sessionActor(user, request.headers.authorization.slice(7));
  return next();
}

async function requireAuth(request, response, next) {
  const user = await authFromRequest(request);

  if (!user) {
    return response.status(401).json({
      message: 'Sign in is required.',
    });
  }

  if (user.isBlocked) return response.status(403).json({ message: 'This account is blocked. Contact support.' });

  request.authUser = user;
  return next();
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || configuredCorsOrigins.has('*')) {
        return callback(null, true);
      }

      if (configuredCorsOrigins.has(origin.replace(/\/+$/, ''))) {
        return callback(null, true);
      }

      const corsError = new Error(`Origin ${origin} is not allowed by CORS.`);
      corsError.status = 403;
      return callback(corsError);
    },
  }),
);

require('./cloudflare-mail').registerMailIngress(app);
app.use(require('./security-controls').resourceAdmission);
app.use('/api/auth', express.json({ limit: '16kb' }), require('./security-controls').authRateLimit);
app.use(express.json({ limit: '8mb', type: ['application/json', 'application/webhook+json'], verify(request, _response, buffer) {
  if (request.path === '/api/live-stream/webrtc/webhook') request.rawBody = buffer.toString('utf8');
} }));

app.get('/api/health', async (_request, response) => {
  response.json({
    ok: true,
    service: 'khalil app api',
    databaseName: MONGODB_DB_NAME,
    time: new Date().toISOString(),
  });
});

app.get('/api/ready', async (_request, response) => {
  let timer;
  response.set('Cache-Control', 'no-store');
  try {
    const db = require('mongoose').connection;
    if (db.readyState !== 1 || !db.db) throw new Error('Database unavailable');
    await Promise.race([db.db.command({ ping: 1 }, { maxTimeMS: 1500 }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Readiness timeout')), 2000); })]);
    response.json({ ready: true });
  } catch { response.status(503).json({ ready: false }); }
  finally { clearTimeout(timer); }
});

app.get('/api/bootstrap', async (_request, response) => {
  const [liveSessions, archiveItems, liveStreamConfig] = await Promise.all([
    getOrderedLiveSessions(),
    require('./music-archive').publicSongs(),
    getLiveStreamConfig(),
  ]);

  response.json({
    liveSessions: liveSessions.map(serializeLiveSession),
    archiveItems: archiveItems.map(serializeArchiveItem),
    liveStream: serializeLiveStreamConfig(liveStreamConfig),
  });
});

app.post('/api/session-token', requireAuth, require('./security-controls').providerSessionLimit, async (_request, response) => {
  if (!process.env.ANAM_API_KEY) {
    return response.status(503).json({
      error: 'ANAM_API_KEY is not configured on the server.',
    });
  }

  try {
    const anamResponse = await fetch('https://api.anam.ai/v1/auth/session-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.ANAM_API_KEY}`,
      },
      body: JSON.stringify({
        personaConfig: anamPersonaConfig,
      }),
    });

    if (!anamResponse.ok) {
      const errorData = await anamResponse.json().catch(() => ({}));
      console.error('ANAM token creation failed:', errorData);

      return response.status(anamResponse.status).json({
        error: 'Token creation failed',
      });
    }

    const { sessionToken } = await anamResponse.json();

    return response.json({
      sessionToken,
    });
  } catch (error) {
    console.error('ANAM network error:', error);
    return response.status(500).json({
      error: 'Failed to create session',
    });
  }
});

app.get('/api/auth/me', async (request, response) => {
  const user = await authFromRequest(request);

  if (!user) {
    return response.status(401).json({
      message: 'No active session.',
    });
  }

  return response.json({
    user: serializeUser(user),
  });
});

require('./google-auth').registerGoogleAuth(app, {
  User, serializeUser, isAdminUser,
  adminGoogleEmail: ADMIN_GOOGLE_EMAILS.join(','),
  allowedOrigins: [...configuredCorsOrigins, getFrontendUrl()],
});

app.post('/api/auth/login', async (request, response) => {
  const parsed = loginSchema.safeParse(request.body);

  if (!parsed.success) {
    return response.status(400).json({
      message: 'Login payload failed validation.',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const user = await findPasswordAccount(User, parsed.data);

  if (!await verifyPassword(parsed.data.password, user?.passwordHash) || !user) {
    return response.status(401).json({
      message: 'Incorrect email address or password.',
    });
  }

  if (user.isBlocked) return response.status(403).json({ message: 'This account is blocked. Contact support.' });

  if (isAdminUser(user) && !user.isAdmin) {
    user.isAdmin = true;
  }

  const token = await accountSessions.issueSession(user, request, isAdminUser);

  return response.json({
    token,
    user: serializeUser(user),
  });
});

app.post('/api/auth/signup', async (request, response) => {
  const parsed = signupSchema.safeParse(request.body);

  if (!parsed.success) {
    return response.status(400).json({
      message: 'Sign up payload failed validation.',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const normalizedUsername = parsed.data.username?.toLowerCase() || `client-${crypto.randomUUID()}`;
  // Admin usernames are reserved at sign-up so nobody can claim one.
  if (ADMIN_USERNAMES.has(normalizedUsername)) return response.status(400).json({ message: 'That username is reserved. Please choose another.' });

  if (await User.findOne({ username: normalizedUsername })) {
    return response.status(409).json({
      message: 'That username is already registered.',
    });
  }

  const existingEmail = await User.exists({email:new RegExp(`^${parsed.data.email.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`,'i')});
  if(existingEmail)return response.status(409).json({message:'That email address is already registered. Sign in or reset your password.'});

  const user = await User.create({
    ...parsed.data,
    username: normalizedUsername,
    email: parsed.data.email.toLowerCase(),
    passwordHash: await hashPassword(parsed.data.password),
    isAdmin: normalizedUsername === ADMIN_USERNAME,
  });

  const token = await accountSessions.issueSession(user, request, isAdminUser);
  sendVerification(user, getFrontendUrl()).catch((error) => console.error('Verification email failed:', error));

  return response.status(201).json({
    token,
    user: serializeUser(user),
  });
});

app.post('/api/auth/logout', async (request, response) => {
  const user = await authFromRequest(request);

  if (user) {
    await accountSessions.revokeSession(User,user,request.headers.authorization.slice(7));
  }

  response.json({
    ok: true,
  });
});

app.get('/api/service-requests/order-contract', (_request,response) => response.json({schemaVersion:eventOrder.contract.version,canonicalOrder:true,idempotentSubmission:true,draftConversation:true}));
registerServiceRequestSubmission(app, { requireAuth, ServiceRequest, Equipment, vouchers, serializeServiceRequest, sendServiceRequestNotification });

app.get('/api/service-requests/mine', requireAuth, async (request, response) => {
  const requests = await ServiceRequest.find({ userId: request.authUser._id }).sort({ createdAt: -1 });

  return response.json({
    items: requests.map((item) => serializeServiceRequest(item, false)),
  });
});

app.get('/api/service-requests/admin', requireAdmin, async (_request, response) => {
  const [requests,equipment,prices]=await Promise.all([ServiceRequest.find().sort({createdAt:-1}),Equipment.find().select('slug priceCents'),ServicePrice.find({isActive:true}).select('serviceId amountCents')]);
  const defaults=new Map([...prices.map(item=>[item.serviceId,Number(item.amountCents)/100]),...equipment.map(item=>[item.slug,Number(item.priceCents)/100])]);
  const serviceAliases={'svc-mc':'service-mc','svc-dj':'service-dj','svc-sound':'service-sound','svc-lighting':'service-lighting','svc-led':'service-video','svc-fx':'service-effects','svc-corporate':'service-corporate'};
  for(const [bookingId,priceId] of Object.entries(serviceAliases)){if(defaults.has(priceId))defaults.set(bookingId,defaults.get(priceId));}
  return response.json({items:requests.map(item=>{const result=serializeServiceRequest(item,true);return {...result,items:result.items.map(line=>({...line,defaultUnitPrice:defaults.has(line.serviceId)?defaults.get(line.serviceId):null}))};})});
});

app.patch('/api/service-requests/:id/quote', requireAdmin, async (request, response) => {
  const parsed = serviceRequestQuoteSchema.safeParse(request.body);

  if (!parsed.success) {
    return response.status(400).json({
      message: 'Service quote payload failed validation.',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const serviceRequest = await ServiceRequest.findOne({ externalId: request.params.id });

  if (!serviceRequest) {
    return response.status(404).json({
      message: 'Service request not found.',
    });
  }

  if (['confirmed', 'cancelled'].includes(serviceRequest.status) || (serviceRequest.payments || []).some((p) => !p.voided)) {
    return response.status(409).json({ message: 'A cancelled or paid booking cannot be repriced through the quote editor.' });
  }

  const quoteByServiceId = new Map(parsed.data.items.map((item) => [item.serviceId, item.unitPrice]));
  const hasEveryItem = serviceRequest.items.every((item) => quoteByServiceId.has(item.serviceId));

  if (!hasEveryItem || quoteByServiceId.size !== serviceRequest.items.length) {
    return response.status(400).json({
      message: 'Enter an amount for every requested service before publishing.',
    });
  }

  const discountType=parsed.data.discountType||serviceRequest.discountType||'amount';
  const discountValue=parsed.data.discountValue??serviceRequest.discountValue??0;
  const subtotal=serviceRequest.items.reduce((sum,item)=>sum+Math.round(quoteByServiceId.get(item.serviceId)*100)*item.quantity,0)/100;
  if((discountType==='percent'&&discountValue>100)||(discountType==='amount'&&discountValue>subtotal))return response.status(400).json({message:'Discount cannot exceed 100% or the services subtotal.'});
  serviceRequest.discountType=discountType;serviceRequest.discountValue=discountValue;
  serviceRequest.items.forEach((item) => {
    item.unitPrice = quoteByServiceId.get(item.serviceId);
  });
  serviceRequest.adminNote = parsed.data.adminNote;
  serviceRequest.status = 'quoted';
  serviceRequest.quotedAt = new Date();
  if (parsed.data.validDays) serviceRequest.validDays = parsed.data.validDays;
  if (parsed.data.taxPercent !== undefined) serviceRequest.taxPercent = parsed.data.taxPercent;
  if (parsed.data.depositAmount !== undefined) serviceRequest.depositAmount = parsed.data.depositAmount;
  if (parsed.data.paymentInstructions !== undefined) serviceRequest.paymentInstructions = parsed.data.paymentInstructions;
  serviceRequest.expiresAt = new Date(Date.now() + serviceRequest.validDays * DAY_MS);
  serviceRequest.reminderSentAt = null;
  await serviceRequest.save();

  let notificationSent = false;

  try {
    const notification = await sendServiceQuoteNotification(serviceRequest);
    notificationSent = notification.sent;
  } catch (error) {
    console.error('Failed to send Brevo service quote notification:', error);
  }

  return response.json({
    item: serializeServiceRequest(serviceRequest, true),
    notificationSent,
  });
});

const servicePriceUpdateSchema = z.object({
  amountCents: z.coerce.number().int().min(0, 'Price cannot be negative.'),
  currency: z.string().trim().length(3).default('CAD'),
  isActive: z.boolean().default(true),
});

app.get('/api/prices', requireAdmin, async (_request, response) => {
  await require('./equipment').ensureSeed();
  const [prices, equipment] = await Promise.all([ServicePrice.find().sort({ category: 1, name: 1 }), Equipment.find()]);
  return response.json({ items: prices.map(price => serializeServicePrice(price, equipment)) });
});

app.patch('/api/prices/:id', requireAdmin, async (request, response) => {
  const parsed = servicePriceUpdateSchema.safeParse(request.body);

  if (!parsed.success) {
    return response.status(400).json({
      message: 'Price payload failed validation.',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const price = await ServicePrice.findOneAndUpdate(
    { serviceId: request.params.id },
    {
      amountCents: parsed.data.amountCents,
      currency: parsed.data.currency.toUpperCase(),
      isActive: parsed.data.isActive,
    },
    { new: true },
  );

  if (!price) {
    return response.status(404).json({ message: 'Price item not found.' });
  }

  const slug = require('./equipment-stock').PRICE_EQUIPMENT[price.serviceId];
  const equipment = slug ? await Equipment.find({ slug }) : [];
  return response.json({ item: serializeServicePrice(price, equipment) });
});

app.post('/api/live-sessions', requireAdmin, async (request, response) => {
  const parsed = liveSessionSchema.safeParse(request.body);

  if (!parsed.success) {
    return response.status(400).json({
      message: 'Live session payload failed validation.',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const nextSortOrder =
    typeof parsed.data.sortOrder === 'number' && Number.isFinite(parsed.data.sortOrder)
      ? parsed.data.sortOrder
      : await getNextLiveSessionSortOrder();
  const { sortOrder: _ignoredSortOrder, ...sessionPayload } = parsed.data;

  const session = await LiveSession.create({
    externalId: `live-session-${Date.now()}`,
    sortOrder: nextSortOrder,
    ...sessionPayload,
  });

  return response.status(201).json({
    item: serializeLiveSession(session),
  });
});

app.post('/api/live-sessions/upload-audio', requireAdmin, upload.single('audio'), async (request, response) => {
  if (!request.file) {
    return response.status(400).json({
      message: 'Audio file is required.',
    });
  }

  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    return response.status(500).json({
      message: 'Cloudinary credentials are missing from the server environment.',
    });
  }

  try {
    const result = await uploadAudioBufferToCloudinary(request.file);

    return response.status(201).json({
      item: {
        audioUrl: result.secure_url || '',
        audioPublicId: result.public_id || '',
        audioOriginalName: request.file.originalname || '',
      },
    });
  } catch (error) {
    console.error('Cloudinary audio upload failed:', error);
    return response.status(500).json({
      message: 'Audio upload failed.',
    });
  }
});

app.post('/api/live-stream/upload-poster', requireAdmin, upload.single('poster'), async (request, response) => {
  if (!request.file) {
    return response.status(400).json({ message: 'Poster image is required.' });
  }

  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    return response.status(500).json({ message: 'Cloudinary credentials are missing from the server environment.' });
  }

  try {
    const result = await uploadPosterBufferToCloudinary(request.file);
    return response.status(201).json({
      item: {
        posterImage: result.secure_url || result.url || '',
        posterPublicId: result.public_id || '',
        posterOriginalName: request.file.originalname || '',
      },
    });
  } catch (error) {
    console.error('Cloudinary poster upload failed:', error);
    return response.status(500).json({ message: 'Poster image upload failed.' });
  }
});

app.post('/api/live-sessions/upload-cover', requireAdmin, upload.single('cover'), async (request, response) => {
  if (!request.file) return response.status(400).json({ message: 'Cover image is required.' });
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    return response.status(500).json({ message: 'Cloudinary credentials are missing from the server environment.' });
  }

  try {
    const result = await uploadCoverBufferToCloudinary(request.file);
    return response.status(201).json({
      item: {
        coverImage: result.secure_url || result.url || '',
        coverPublicId: result.public_id || '',
        coverOriginalName: request.file.originalname || '',
      },
    });
  } catch (error) {
    console.error('Cloudinary cover upload failed:', error);
    return response.status(500).json({ message: 'Cover image upload failed.' });
  }
});

app.patch('/api/live-sessions/:id', requireAdmin, async (request, response) => {
  const parsed = liveSessionSchema.partial().safeParse(request.body);

  if (!parsed.success) {
    return response.status(400).json({
      message: 'Live session update failed validation.',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const session = await LiveSession.findOneAndUpdate(
    { externalId: request.params.id },
    parsed.data,
    { new: true },
  );

  if (!session) {
    return response.status(404).json({
      message: 'Live session not found.',
    });
  }

  return response.json({
    item: serializeLiveSession(session),
  });
});

app.delete('/api/live-sessions/:id', requireAdmin, async (request, response) => {
  const deleted = await permanentDeletion.remove(LiveSession,{externalId:request.params.id});

  if (!deleted) {
    return response.status(404).json({
      message: 'Live session not found.',
    });
  }

  // The asset worker removes audio only after its last reference is gone.

  return response.json({
    ok: true,
    cloudinaryCleanupPending:Boolean(deleted.cloudinaryCleanupPending),
  });
});

app.patch('/api/live-stream', requireAdmin, async (request, response) => {
  const parsed = liveStreamConfigSchema.safeParse(request.body);

  if (!parsed.success) {
    return response.status(400).json({
      message: 'Live stream update failed validation.',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  if (parsed.data.isLive) return response.status(409).json({message:'Members-only live broadcasts require OBS or browser broadcasting.'});
  const previous = await getLiveStreamConfig();
  if (previous.isLive || previous.webrtcRoomName || previous.obsRoomName) return response.status(409).json({message:'End the current broadcast before changing its source.'});
  const config = await LiveStreamConfig.findOneAndUpdate(
    { key: defaultLiveStreamConfig.key, isLive:{$ne:true}, webrtcRoomName:{$in:['',null]}, obsRoomName: { $in: ['', null] } },
    { ...parsed.data, broadcastMode: 'youtube', webrtcRoomName: '', broadcastSessionId: externalBroadcastId(previous, parsed.data) },
    { new: true },
  );
  if (!config) return response.status(409).json({ message: 'End the OBS session before changing its source.' });
  await notifyLiveTransition(previous,config);

  return response.json({
    item: serializeLiveStreamConfig(config),
  });
});

// The goal ECHO is on air for (Broadcast, DJing in an Event, DJing in Home Studio, Chilling-out Mix Time, Echo Radio Music). Independent of the stream source.
app.put('/api/live-stream/goal', requireAdmin, async (request, response) => {
  const goal = request.body?.goal;
  if (!['broadcast', 'event', 'home-studio', 'chill-mix', 'radio'].includes(goal)) {
    return response.status(400).json({ message: 'Choose a valid on-air goal.' });
  }
  await getLiveStreamConfig();
  const config = await LiveStreamConfig.findOneAndUpdate({ key: defaultLiveStreamConfig.key }, { $set: { goal } }, { new: true });
  return response.json({ item: serializeAdminLiveStreamConfig(config) });
});

app.patch('/api/live-stream/details', requireAdmin, async(request,response)=>{
 const parsed=z.object({title:z.string().trim().min(1).max(180),roomName:z.string().max(300)}).strict().safeParse(request.body);
 if(!parsed.success)return response.status(400).json({message:'Enter a broadcast title of 1–180 characters.'});
 const current=await getLiveStreamConfig(),roomName=current.obsRoomName||current.webrtcRoomName||'';
 if(roomName!==parsed.data.roomName)return response.status(409).json({message:'The connection changed. Refresh before editing the title.'});
 const item=await LiveStreamConfig.findOneAndUpdate({key:defaultLiveStreamConfig.key,obsRoomName:current.obsRoomName||{$in:['',null]},webrtcRoomName:current.webrtcRoomName||{$in:['',null]}},{$set:{title:parsed.data.title}},{new:true});
 if(!item)return response.status(409).json({message:'The connection changed. Refresh before editing.'});
 return response.json({item:serializeAdminLiveStreamConfig(item)});
});

app.get('/api/live-stream/admin', requireAdmin, async (_request, response) => {
  response.set('Cache-Control', 'no-store');
  const config = await getLiveStreamConfig();

  return response.json({
    item: {...serializeAdminLiveStreamConfig(config),recording:await require('./live-recordings').statusForRoom(config.obsRoomName||config.webrtcRoomName)},
  });
});

app.get('/api/youtube/search', requireAuth, async (request, response) => {
  const parsed = youtubeSearchSchema.safeParse({ query: request.query.q });

  if (!parsed.success) {
    return response.status(400).json({
      message: parsed.error.flatten().fieldErrors.query?.[0] || 'A YouTube search query is required.',
    });
  }

  if (!process.env.YOUTUBE_API_KEY) {
    return response.status(503).json({ message: 'YouTube search is not configured on the server.' });
  }

  try {
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.search = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      maxResults: '8',
      q: parsed.data.query,
      key: process.env.YOUTUBE_API_KEY,
    });
    const searchResponse = await fetch(searchUrl);
    const searchPayload = await searchResponse.json();

    if (!searchResponse.ok) {
      console.error('YouTube search failed:', searchPayload.error?.message || searchResponse.status);
      return response.status(502).json({ message: 'YouTube search is temporarily unavailable.' });
    }

    const ids = (searchPayload.items || []).map((item) => item.id?.videoId).filter(Boolean);
    if (!ids.length) {
      return response.json({ items: [] });
    }

    const detailsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    detailsUrl.search = new URLSearchParams({
      part: 'contentDetails',
      id: ids.join(','),
      key: process.env.YOUTUBE_API_KEY,
    });
    const detailsResponse = await fetch(detailsUrl);
    const detailsPayload = await detailsResponse.json();
    const durations = new Map((detailsPayload.items || []).map((item) => [item.id, item.contentDetails?.duration || '']));

    return response.json({
      items: (searchPayload.items || []).map((item) => {
        const videoId = item.id.videoId;
        return {
          id: videoId,
          title: item.snippet?.title || 'Untitled video',
          channelTitle: item.snippet?.channelTitle || '',
          description: item.snippet?.description || '',
          thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || '',
          duration: durations.get(videoId) || '',
          url: `https://www.youtube.com/watch?v=${videoId}`,
        };
      }),
    });
  } catch (error) {
    console.error('YouTube search network error:', error);
    return response.status(502).json({ message: 'YouTube search is temporarily unavailable.' });
  }
});

app.post('/api/live-requests/:id/to-wav', requireAdmin, async (request, response) => {
  const liveRequest = await LiveRequest.findOne({ externalId: request.params.id });

  if (!liveRequest) {
    return response.status(404).json({ message: 'Audience request not found.' });
  }

  if (liveRequest.sourcePlatform !== 'youtube' || !liveRequest.sourceUrl) {
    return response.status(400).json({ message: 'This request does not contain a YouTube source URL.' });
  }

  try {
    const result = await convertYoutubeToWav(liveRequest.sourceUrl);
    const uploadResult = await uploadAudioBufferToCloudinary({
      buffer: result.buffer,
      originalname: result.fileName,
      mimetype: 'audio/wav',
    });
    liveRequest.audioUrl = uploadResult.secure_url || uploadResult.url || '';
    liveRequest.audioPublicId = uploadResult.public_id || '';
    liveRequest.audioOriginalName = result.fileName;
    await liveRequest.save();

    return response.json({ item: serializeLiveRequest(liveRequest) });
  } catch (error) {
    console.error('Audience request WAV conversion failed:', error);
    return response.status(502).json({
      message: 'Could not convert this YouTube request to WAV. Confirm the backend tools are installed and the audio is permitted for use.',
    });
  }
});

require('./live-requests').registerLiveRequestRoutes(app,{
 requireAuth,requireAdmin,getLiveStreamConfig,LiveRequest,LiveSession,
 liveRequestAnalysisSchema,liveRequestCheckoutSchema,liveRequestReviewSchema,
 getOrderedLiveSessions,analyzeLiveRequest,buildDirectRequestMetadata,createCode,
 buildReorderedQueue,serializeLiveRequest,serializeLiveSession,
});

app.post('/api/live-stream/mux', requireAdmin, async (request, response) => {
  try {
    const currentConfig = await getLiveStreamConfig();
    if (currentConfig.isLive || currentConfig.webrtcRoomName || currentConfig.obsRoomName) return response.status(409).json({ message: 'End the current broadcast first.' });
    const muxLiveStream = await createMuxLiveStream(request.body?.title || currentConfig.title);
    const muxPlaybackId = muxLiveStream.playback_ids?.[0]?.id || '';
    const muxStreamKey = muxLiveStream.stream_key || '';
    const muxRtmpUrl = currentConfig.muxRtmpUrl || defaultLiveStreamConfig.muxRtmpUrl;
    const streamUrl = buildMuxPlaybackUrl(muxPlaybackId);

    const updatedConfig = await LiveStreamConfig.findOneAndUpdate(
      { key: defaultLiveStreamConfig.key, isLive:{$ne:true}, webrtcRoomName:{$in:['',null]}, obsRoomName: { $in: ['', null] } },
      {
        title: request.body?.title?.trim() || currentConfig.title || defaultLiveStreamConfig.title,
        streamUrl,
        isLive: false,
        statusLabel: currentConfig.statusLabel || defaultLiveStreamConfig.statusLabel,
        muxLiveStreamId: muxLiveStream.id || '',
        muxPlaybackId,
        muxStreamKey,
        muxRtmpUrl,
      },
      { new: true },
    );

    if (!updatedConfig) return response.status(409).json({ message: 'The broadcast changed. Refresh its status.' });
    return response.status(201).json({
      item: serializeAdminLiveStreamConfig(updatedConfig),
    });
  } catch (error) {
    console.error('MUX live stream creation failed:', error.payload || error);
    return response.status(error.status || 500).json({
      message: error.message || 'Failed to create Mux live stream.',
    });
  }
});

require('./live-broadcast').registerLiveBroadcastRoutes(app, {
  requireAdmin, getLiveStreamConfig, LiveStreamConfig, defaults: defaultLiveStreamConfig, notifyLiveTransition,
  createToken: createLiveKitToken, getConfig: getLiveKitConfig,
  serialize: serializeAdminLiveStreamConfig, serializePublic: serializeLiveStreamConfig,
  RoomServiceClient, IngressClient, randomUUID: crypto.randomUUID, prepareRecording: require('./live-recordings').prepareRecordingRoom, ensureRecording: require('./live-recordings').ensureRecording, recordingStatus: require('./live-recordings').statusForRoom,
  verifyWebhook: async (body, authorization) => {
    const { apiKey, apiSecret } = getLiveKitConfig();
    return new WebhookReceiver(apiKey, apiSecret).receive(body, authorization);
  },
});

require('./live-destinations').registerLiveDestinations(app,{requireAdmin,getLiveStreamConfig});

require('./live-access').registerLiveAccess(app, { requireAuth, getLiveStreamConfig, createToken: createLiveKitToken, getConfig: getLiveKitConfig });

const youtubeSessionStore = createYoutubeSessionStore(process.env.YT_DLP_COOKIES_FILE);
let youtubeConversionActive = false;
async function convertArchiveYoutube(sourceUrl) {
  if (youtubeConversionActive) throw Object.assign(new Error('Another conversion is running.'), { code: 'YOUTUBE_BUSY' });
  youtubeConversionActive = true;
  try {
    const result = await convertYoutubeToWav(sourceUrl);
    await youtubeSessionStore.recordPublicAccess('ready', 'Public video downloaded and converted without an account.').catch(() => {});
    return result;
  } catch (error) {
    await youtubeSessionStore.recordPublicAccess(error.code === 'YOUTUBE_PUBLIC_ACCESS_BLOCKED' ? 'blocked' : 'error', error.code === 'YOUTUBE_PUBLIC_ACCESS_BLOCKED'
      ? 'YouTube blocked public download access. Upload an audio file instead.'
      : error.code === 'YOUTUBE_WORKER_UNAVAILABLE' ? 'The local audio service is offline. Keep the admin computer online.' : 'This video could not be converted. Check availability, duration and file size.').catch(() => {});
    throw error;
  } finally { youtubeConversionActive = false; }
}
registerYoutubeSessionRoutes(app, {
  requireAdmin, usesLocalWorker: () => process.env.YOUTUBE_PROCESSING_MODE !== 'server' && Boolean(process.env.YOUTUBE_WORKER_SOCKET), store: youtubeSessionStore, convert: convertArchiveYoutube, normalizeUrl: normalizeYoutubeUrl, isBusy: () => youtubeConversionActive,
  upload: multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1, fields: 1 } }).single('sessionFile'),
});

app.post('/api/archive-items', requireAdmin, (_request, response) => response.status(409).json({message:'Create recordings through the Music Archive ontology editor.',code:'MUSIC_ONTOLOGY_REQUIRED'}));

app.patch('/api/archive-items/:id', requireAdmin, async (request, response) => {
  if (await ArchiveItem.exists({externalId:request.params.id,workId:{$exists:true,$ne:''}})) return response.status(409).json({message:'Edit this recording through the Music Archive ontology editor.'});
  const parsed = archiveItemSchema.partial().safeParse(request.body);

  if (!parsed.success) {
    return response.status(400).json({
      message: 'Archive update failed validation.',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const item = await ArchiveItem.findOneAndUpdate(
    { externalId: request.params.id },
    parsed.data,
    { new: true },
  );

  if (!item) {
    return response.status(404).json({
      message: 'Archive item not found.',
    });
  }

  return response.json({
    item: serializeArchiveItem(item),
  });
});

app.delete('/api/archive-items/:id', requireAdmin, async (request, response) => {
  if (await ArchiveItem.exists({externalId:request.params.id,workId:{$exists:true,$ne:''}})) return response.status(409).json({message:'Archive this recording through the Music Archive ontology editor.'});
  const deleted = await require('./music-archive').ontologyService().deleteLegacy(request.params.id);

  if (!deleted) {
    return response.status(404).json({
      message: 'Archive item not found.',
    });
  }

  return response.json({
    ok: true,
    cloudinaryCleanupPending:Boolean(deleted.cloudinaryCleanupPending),
  });
});

app.post('/api/bookings', async (request, response) => {
  const parsed = bookingSchema.safeParse(request.body);

  if (!parsed.success) {
    return response.status(400).json({
      message: 'Booking payload failed validation.',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  if (!isFutureDate(parsed.data.eventDate)) {
    return response.status(400).json({
      message: 'Event date must be today or later.',
      errors: {
        eventDate: ['Choose a valid future date.'],
      },
    });
  }

  const reference = createReference('KN');

  await Booking.create({
    reference,
    ...parsed.data,
  });

  return response.status(201).json({
    ok: true,
    message: 'Booking request transmitted.',
    reference,
    receivedAt: new Date().toISOString(),
  });
});


require('./mobile-admin').registerMobileAdmin(app, { requireAdmin, requireAuth, serializeRequest: serializeServiceRequest });
const {createAiConfiguration,registerAiConfiguration}=require('./ai-configuration');
const aiConfiguration=createAiConfiguration();
registerAiConfiguration(app,{
  requireAdmin: require('./ai-booking-auth').createAiBookingAuth({ localAuth: authFromRequest, adminCheck: isAdminUser }),
  service:aiConfiguration,
});
const {mongoBillingStore,createAiBilling,registerAiBilling}=require('./ai-billing');
registerAiBilling(app, {
  requireAdmin: require('./ai-booking-auth').createAiBookingAuth({ localAuth: authFromRequest, adminCheck: isAdminUser }),
  service: createAiBilling({store:mongoBillingStore(require('./ai-configuration').usageModel)}),
});
const aiBooking=require('./ai-booking'),aiBookingRoutes=aiBooking.registerAiBooking(app, {
  configService:aiConfiguration,
  requireAuth: require('./ai-booking-auth').createAiBookingAuth({ localAuth: authFromRequest }),
});
require('./venue-map/routes').registerVenueMap(app, { requireAuth });

require('./venue-intelligence/routes').registerVenueIntelligence(app, {
  requireAuth: require('./ai-booking-auth').createAiBookingAuth({ localAuth: authFromRequest }),
  service: require('./venue-intelligence/service').createVenueIntelligence({configService:aiConfiguration}),
});
require('./booking-conversations').registerBookingConversations(app, {
  requireAuth: require('./ai-booking-auth').createAiBookingAuth({ localAuth: authFromRequest }),
});
require('./event-drafts').registerEventDrafts(app, {
  requireAuth: require('./ai-booking-auth').createAiBookingAuth({ localAuth: authFromRequest }),
});
require('./archive-player').registerArchivePlayer(app, { requireAdmin });
app.use('/api/player/stems', require('./security-controls').stemStartLimit);
require('./stem-separation').registerStemSeparation(app, { requireAdmin });
require('./music-archive').registerMusicArchive(app, { requireAdmin });
require('./dj-service-builder').registerDjServiceBuilder(app, { requireAdmin });
require('./setup-catalog').registerSetupCatalog(app, { requireAdmin });
const projectChatRealtime=require('./echo-project-chat').registerEchoProjectChat(app, { requireAdmin,authenticate:authFromRequest,allowedOrigins:[...configuredCorsOrigins,getFrontendUrl()] });
require('./echo-project-chat-audio').registerEchoProjectChatAudio(app, { requireAdmin });
require('./echo-project-chat-calls').registerEchoProjectChatCalls(app, { requireAdmin, getConfig: getLiveKitConfig });
require('./availability').registerAvailability(app, { requireAdmin });
vouchers.registerVouchers(app, { requireAdmin, requireAuth });
require('./live-recordings').registerLiveRecordings(app, requireAdmin);
require('./direct-recording').registerDirectRecordingRoutes(app,requireAdmin);
require('./live-suggestions').registerLiveSuggestions(app, { getLiveStreamConfig, requireAuth });
require('./live-comments').registerLiveComments(app, { getLiveStreamConfig, requireAuth, requireAdmin });
require('./notification-emails').registerNotificationEmails(app, { requireAdmin });
require('./domain-mail').registerDomainMail(app, { requireAdmin });
require('./contact-form').registerContactForm(app);
registerEquipmentRoutes(app, requireAdmin);
require('./equipment-3d').registerEquipment3D(app,{requireAdmin});
registerPlanning(app, { requireAuth, serialize: serializeServiceRequest });
require('./simulation-drafts').registerSimulationDrafts(app,{requireAuth});
registerMeetings(app, { requireAuth, requireAdmin });
registerMeetingRoom(app, { requireAuth, Meeting: MeetingModel });
registerAccount(app, { requireAuth, getFrontendUrl });
registerContent(app, requireAdmin);
require('./seasonal-theme').registerSeasonalTheme(app, { requireAdmin });
registerPayments(app, { requireAuth, requireAdmin, serialize: serializeServiceRequest });
registerQuoteLifecycle(app, { requireAuth, requireAdmin, serialize: serializeServiceRequest });

const aiAdministrator=require('./ai-admin/routes').registerAiAdministrator(app,{
 requireAdmin,configService:aiConfiguration,
 authorize:async (owner,token,binding)=>{if(!require('mongoose').isValidObjectId(owner))return null;const user=await User.findById(owner).select('+sessionTokenEncrypted +androidSessionTokenEncrypted');const active=accountSessions.selectSession(user,token,binding);return isAdminUser(user)&&active?accountSessions.sessionActor(user,active):null;},
});

app.use(require('./security-controls').securityError);

app.use((_request, response) => {
  response.status(404).json({
    message: 'Route not found.',
  });
});

async function startServer(port = PORT) {
  await connectToDatabase();
  await require('./security-controls').initializeSecurity();
  await accountSessions.migrateLegacySessions(User);
  await require('./cloudinary-assets').Asset.init();
  const stopAssetCleanup=require('./cloudinary-assets').startCleanup();
  if(process.env.ECHO_ADMIN_WORKER_MODE!=='external')await aiAdministrator.start();

  const server=app.listen(port, '0.0.0.0', () => {
    console.log(`Khalil app API listening on http://localhost:${port}`);
  });
  server.requestTimeout = 300000;
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 1000;
  server.once('close',stopAssetCleanup);
  aiBooking.attachAlibabaVoiceSocket(server,aiBookingRoutes.voiceSocketHooks);
  projectChatRealtime.attach(server);
  return server;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to start Khalil app API.');
    console.error(error);
    process.exit(1);
  });
}

module.exports = { app, startServer };
