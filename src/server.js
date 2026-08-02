require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const Stripe = require('stripe');
const { z } = require('zod');
const { connectToDatabase, MONGODB_DB_NAME } = require('./db');
const { ADMIN_USERNAME, defaultLiveStreamConfig } = require('./default-data');
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
const { createSessionToken, hashPassword, verifyPassword } = require('./security');
const { convertYoutubeToWav } = require('./youtube-audio');
const {
  sendServiceQuoteNotification,
  sendServiceRequestNotification,
  sendLiveRequestReceipt,
} = require('./brevo');

const app = express();
const PORT = process.env.PORT || 4000;
const upload = multer({ storage: multer.memoryStorage() });
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const liveRequestPriceCents = Number.parseInt(process.env.STRIPE_LIVE_REQUEST_PRICE_CENTS || '500', 10);
const liveRequestCurrency = (process.env.STRIPE_LIVE_REQUEST_CURRENCY || 'cad').toLowerCase();

const DEFAULT_SERVICE_PRICES = [
  ['professional-dj-service', 'Professional DJ Service', 'DJ'],
  ['qsc-k12-2-speaker', 'QSC K12.2 Speaker', 'Sound'],
  ['elite-15-speaker', 'Elite 15-inch Speaker', 'Sound'],
  ['es18p-subwoofer', 'ES18P 18-inch Subwoofer', 'Sound'],
  ['shure-microphone', 'Shure Microphone', 'Sound'],
  ['soundcraft-soundboard', 'Soundcraft Soundboard', 'Sound'],
  ['jbl-concert-system', 'JBL Concert-Level System', 'Sound'],
  ['intelligent-moving-head', 'Intelligent Moving Head', 'Lighting'],
  ['baseplate-trussing', 'Baseplate / Trussing', 'Lighting'],
  ['uplight', 'Uplight', 'Lighting'],
  ['smoke-machine', 'Smoke Machine', 'Special Effects'],
  ['sparkler-machine', 'Sparkler Machine', 'Special Effects'],
  ['dry-ice-machine', 'Dry Ice Machine', 'Special Effects'],
  ['co2-gun', 'CO2 Gun with Tank', 'Special Effects'],
  ['six-panel-led-screen', 'Six-Panel LED Screen', 'Video'],
  ['projector', 'Projector', 'Video'],
  ['song-request-live', 'Song Request During Live Events', 'Live Events'],
].map(([serviceId, name, category]) => ({ serviceId, name, category }));

function getFrontendUrl() {
  return (process.env.FRONTEND_URL || process.env.PUBLIC_APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
}

async function ensureServicePrices() {
  const fallbackAmount = Number.isInteger(liveRequestPriceCents) && liveRequestPriceCents >= 0
    ? liveRequestPriceCents
    : 500;

  await Promise.all(
    DEFAULT_SERVICE_PRICES.map((price) =>
      ServicePrice.updateOne(
        { serviceId: price.serviceId },
        {
          $setOnInsert: {
            ...price,
            amountCents: price.serviceId === 'song-request-live' ? fallbackAmount : 0,
            currency: price.serviceId === 'song-request-live' ? liveRequestCurrency.toUpperCase() : 'CAD',
            isActive: true,
          },
        },
        { upsert: true },
      ),
    ),
  );
}

function serializeServicePrice(price) {
  return {
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
  username: z.string().trim().min(1, 'Username is required.'),
  password: z.string().trim().min(1, 'Password is required.'),
  email: z.string().trim().email('A valid email is required.'),
  phoneNumber: z.string().trim().min(1, 'Phone number is required.'),
});

const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username is required.'),
  password: z.string().trim().min(1, 'Password is required.'),
});

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
  lyricsSummary: z.string().trim().optional().default(''),
  lyricsMoods: z.string().trim().optional().default(''),
  lyricsEnergy: z.string().trim().optional().default(''),
  themes: z.string().trim().optional().default(''),
  lyricsLanguage: z.string().trim().optional().default(''),
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
    lyricsSummary: z.string().trim().optional().default(''),
    lyricsMoods: z.string().trim().optional().default(''),
    lyricsEnergy: z.string().trim().optional().default(''),
    themes: z.string().trim().optional().default(''),
    lyricsLanguage: z.string().trim().optional().default(''),
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
    lyricsSummary: '',
    lyricsMoods: '',
    lyricsEnergy: '',
    themes: '',
    lyricsLanguage: '',
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
  lyricsSummary: z.string().trim().optional().default(''),
  lyricsMoods: z.string().trim().optional().default(''),
  lyricsEnergy: z.string().trim().optional().default(''),
  themes: z.string().trim().optional().default(''),
  lyricsLanguage: z.string().trim().optional().default(''),
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

const serviceRequestCreateSchema = z.object({
  items: z.array(z.object({
    serviceId: z.string().trim().min(1),
    name: z.string().trim().min(1),
    category: z.string().trim().min(1),
    quantity: z.coerce.number().int().min(1),
  })).min(1, 'Select at least one service.'),
});

const serviceRequestQuoteSchema = z.object({
  items: z.array(z.object({
    serviceId: z.string().trim().min(1),
    unitPrice: z.coerce.number().min(0),
  })).min(1),
  adminNote: z.string().trim().optional().default(''),
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

function isAdminUser(user) {
  return Boolean(user) && user.username?.toLowerCase() === ADMIN_USERNAME;
}

function serializeUser(user) {
  return {
    id: user.id,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phoneNumber: user.phoneNumber,
    isAdmin: isAdminUser(user),
  };
}

function serializeServiceRequest(serviceRequest, includeQuote = true) {
  const isQuoted = serviceRequest.status === 'quoted';
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
    lyricsSummary: session.lyricsSummary || '',
    lyricsMoods: session.lyricsMoods || '',
    lyricsEnergy: session.lyricsEnergy || '',
    themes: session.themes || '',
    lyricsLanguage: session.lyricsLanguage || '',
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

function uploadAudioBufferToCloudinary(file) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'khalil/live-sessions',
        resource_type: 'video',
        use_filename: true,
        unique_filename: true,
        overwrite: false,
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(result);
      },
    );

    uploadStream.end(file.buffer);
  });
}

function uploadPosterBufferToCloudinary(file) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'khalil/live-posters',
        resource_type: 'image',
        use_filename: true,
        unique_filename: true,
        overwrite: false,
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(result);
      },
    );
    uploadStream.end(file.buffer);
  });
}

function uploadCoverBufferToCloudinary(file) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'khalil/song-covers',
        resource_type: 'image',
        use_filename: true,
        unique_filename: true,
        overwrite: false,
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      },
    );
    uploadStream.end(file.buffer);
  });
}

async function deleteCloudinaryAudio(publicId) {
  if (!publicId) {
    return;
  }

  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'video' });
  } catch (error) {
    console.error('Failed to delete Cloudinary audio asset:', error);
  }
}

function serializeLiveRequest(request) {
  return {
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
    lyricsSummary: request.lyricsSummary || '',
    lyricsMoods: request.lyricsMoods || '',
    lyricsEnergy: request.lyricsEnergy || '',
    themes: request.themes || '',
    lyricsLanguage: request.lyricsLanguage || '',
    explicit: request.explicit || '',
    sourcePlatform: request.sourcePlatform || 'manual',
    sourceUrl: request.sourceUrl || '',
    thumbnailUrl: request.thumbnailUrl || '',
    audioUrl: request.audioUrl || '',
    audioOriginalName: request.audioOriginalName || '',
    paymentStatus: request.paymentStatus || 'paid',
    stripeCheckoutSessionId: request.stripeCheckoutSessionId || '',
    receiptSentAt: request.receiptSentAt || null,
    analysisSources: Array.isArray(request.analysisSources) ? request.analysisSources : [],
    requestStatus: request.requestStatus || 'pending_admin',
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
    audioUrl: item.audioUrl || '',
    audioOriginalName: item.audioOriginalName || '',
    coverImage: item.coverImage || '',
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
    lyricsSummary: item.lyricsSummary || '',
    lyricsMoods: item.lyricsMoods || '',
    lyricsEnergy: item.lyricsEnergy || '',
    themes: item.themes || '',
    lyricsLanguage: item.lyricsLanguage || '',
    explicit: item.explicit || '',
  };
}

function serializeLiveStreamConfig(config) {
  return {
    isLive: Boolean(config?.isLive),
    title: config?.title || '',
    streamUrl: config?.streamUrl || '',
    posterImage: config?.posterImage || '',
    statusLabel: config?.statusLabel || defaultLiveStreamConfig.statusLabel,
    activeSessionId: config?.activeSessionId || '',
  };
}

function buildMuxPlaybackUrl(playbackId) {
  return playbackId ? `https://stream.mux.com/${playbackId}.m3u8` : '';
}

function serializeAdminLiveStreamConfig(config) {
  return {
    ...serializeLiveStreamConfig(config),
    muxLiveStreamId: config?.muxLiveStreamId || '',
    muxPlaybackId: config?.muxPlaybackId || '',
    muxStreamKey: config?.muxStreamKey || '',
    muxRtmpUrl: config?.muxRtmpUrl || defaultLiveStreamConfig.muxRtmpUrl,
    muxPlaybackUrl: buildMuxPlaybackUrl(config?.muxPlaybackId || ''),
  };
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

const configuredCorsOrigins = new Set([
  'http://localhost:5173',
  'http://192.168.68.104:5173',
  'https://djkhalilnahhat.onrender.com',
  ...parseCorsOrigins(process.env.CORS_ORIGIN),
]);

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

  return User.findOne({ sessionToken: token });
}

async function requireAdmin(request, response, next) {
  const user = await authFromRequest(request);

  if (!isAdminUser(user)) {
    return response.status(401).json({
      message: 'Admin authentication is required.',
    });
  }

  if (!user.isAdmin) {
    user.isAdmin = true;
    await user.save();
  }

  request.user = user;
  return next();
}

async function requireAuth(request, response, next) {
  const user = await authFromRequest(request);

  if (!user) {
    return response.status(401).json({
      message: 'Sign in is required.',
    });
  }

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

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (request, response) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return response.status(503).json({ message: 'Stripe webhook is not configured.' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      request.body,
      request.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (error) {
    console.error('Stripe webhook signature verification failed:', error.message);
    return response.status(400).json({ message: 'Invalid Stripe webhook signature.' });
  }

  const session = event.data.object;
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    if (session.payment_status === 'paid' || event.type.endsWith('succeeded')) {
      await LiveRequest.findOneAndUpdate(
        { requestGroupId: session.metadata?.requestGroupId },
        {
          paymentStatus: 'paid',
          stripeCheckoutSessionId: session.id,
          stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : '',
          requestStatus: 'pending_admin',
          aiSummary: 'Payment received. Direct audience request awaiting Khalil review.',
        },
      );

      const receiptCandidate = await LiveRequest.findOne({
        requestGroupId: session.metadata?.requestGroupId,
        paymentStatus: 'paid',
        receiptSentAt: null,
      });
      if (receiptCandidate) {
        const groupRequests = await LiveRequest.find({
          requestGroupId: receiptCandidate.requestGroupId,
          paymentStatus: 'paid',
        }).sort({ createdAt: 1 });
        try {
          const receipt = await sendLiveRequestReceipt({
            email: receiptCandidate.requesterEmail,
            requesterName: receiptCandidate.requesterName,
            groupId: receiptCandidate.requestGroupId,
            confirmationRequests: groupRequests,
            amountTotal: session.amount_total,
            currency: session.currency,
          });
          if (receipt.sent) {
            await LiveRequest.updateMany(
              { requestGroupId: receiptCandidate.requestGroupId, paymentStatus: 'paid' },
              { receiptSentAt: new Date() },
            );
          }
        } catch (error) {
          console.error('Failed to send live request receipt:', error);
        }
      }
    }
  } else if (event.type === 'checkout.session.expired') {
    await LiveRequest.findOneAndUpdate(
      { externalId: session.metadata?.liveRequestId, stripeCheckoutSessionId: session.id },
      { paymentStatus: 'failed', aiSummary: 'Payment session expired before completion.' },
    );
  }

  return response.json({ received: true });
});
app.use(express.json());

app.get('/api/health', async (_request, response) => {
  response.json({
    ok: true,
    service: 'khalil app api',
    databaseName: MONGODB_DB_NAME,
    time: new Date().toISOString(),
  });
});

app.get('/api/bootstrap', async (_request, response) => {
  const [liveSessions, archiveItems, liveStreamConfig] = await Promise.all([
    getOrderedLiveSessions(),
    ArchiveItem.find().sort({ createdAt: 1 }),
    getLiveStreamConfig(),
  ]);

  response.json({
    liveSessions: liveSessions.map(serializeLiveSession),
    archiveItems: archiveItems.map(serializeArchiveItem),
    liveStream: serializeLiveStreamConfig(liveStreamConfig),
  });
});

app.post('/api/session-token', async (_request, response) => {
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

app.post('/api/auth/login', async (request, response) => {
  const parsed = loginSchema.safeParse(request.body);

  if (!parsed.success) {
    return response.status(400).json({
      message: 'Login payload failed validation.',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const username = parsed.data.username.toLowerCase();
  const user = await User.findOne({ username });

  if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
    return response.status(401).json({
      message: 'Incorrect username or password.',
    });
  }

  if (isAdminUser(user) && !user.isAdmin) {
    user.isAdmin = true;
  }

  user.sessionToken = createSessionToken();
  await user.save();

  return response.json({
    token: user.sessionToken,
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

  const normalizedUsername = parsed.data.username.toLowerCase();

  if (await User.findOne({ username: normalizedUsername })) {
    return response.status(409).json({
      message: 'That username is already registered.',
    });
  }

  const user = await User.create({
    ...parsed.data,
    username: normalizedUsername,
    email: parsed.data.email.toLowerCase(),
    passwordHash: hashPassword(parsed.data.password),
    isAdmin: normalizedUsername === ADMIN_USERNAME,
    sessionToken: createSessionToken(),
  });

  return response.status(201).json({
    token: user.sessionToken,
    user: serializeUser(user),
  });
});

app.post('/api/auth/logout', async (request, response) => {
  const user = await authFromRequest(request);

  if (user) {
    user.sessionToken = '';
    await user.save();
  }

  response.json({
    ok: true,
  });
});

app.post('/api/service-requests', requireAuth, async (request, response) => {
  const parsed = serviceRequestCreateSchema.safeParse(request.body);

  if (!parsed.success) {
    return response.status(400).json({
      message: 'Service request payload failed validation.',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const user = request.authUser;
  const serviceRequest = await ServiceRequest.create({
    externalId: `service-request-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    userId: user._id,
    customerName: `${user.firstName} ${user.lastName}`.trim(),
    customerUsername: user.username,
    customerEmail: user.email,
    items: parsed.data.items,
    status: 'pending',
  });

  let notificationSent = false;

  try {
    const notification = await sendServiceRequestNotification(serviceRequest);
    notificationSent = notification.sent;
  } catch (error) {
    console.error('Failed to send Brevo service request notification:', error);
  }

  return response.status(201).json({
    item: serializeServiceRequest(serviceRequest, false),
    notificationSent,
  });
});

app.get('/api/service-requests/mine', requireAuth, async (request, response) => {
  const requests = await ServiceRequest.find({ userId: request.authUser._id }).sort({ createdAt: -1 });

  return response.json({
    items: requests.map((item) => serializeServiceRequest(item, false)),
  });
});

app.get('/api/service-requests/admin', requireAdmin, async (_request, response) => {
  const requests = await ServiceRequest.find().sort({ createdAt: -1 });

  return response.json({
    items: requests.map((item) => serializeServiceRequest(item, true)),
  });
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

  const quoteByServiceId = new Map(parsed.data.items.map((item) => [item.serviceId, item.unitPrice]));
  const hasEveryItem = serviceRequest.items.every((item) => quoteByServiceId.has(item.serviceId));

  if (!hasEveryItem || quoteByServiceId.size !== serviceRequest.items.length) {
    return response.status(400).json({
      message: 'Enter an amount for every requested service before publishing.',
    });
  }

  serviceRequest.items.forEach((item) => {
    item.unitPrice = quoteByServiceId.get(item.serviceId);
  });
  serviceRequest.adminNote = parsed.data.adminNote;
  serviceRequest.status = 'quoted';
  serviceRequest.quotedAt = new Date();
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
  await ensureServicePrices();
  const prices = await ServicePrice.find().sort({ category: 1, name: 1 });
  return response.json({ items: prices.map(serializeServicePrice) });
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

  return response.json({ item: serializeServicePrice(price) });
});

app.get('/api/transactions', requireAdmin, async (_request, response) => {
  if (!stripe) {
    return response.status(503).json({ message: 'Stripe transactions are not configured.' });
  }

  try {
    const checkoutSessions = await stripe.checkout.sessions.list({ limit: 100 });
    const groupIds = checkoutSessions.data
      .map((session) => session.metadata?.requestGroupId)
      .filter(Boolean);
    const requests = groupIds.length
      ? await LiveRequest.find({ requestGroupId: { $in: groupIds } }).sort({ createdAt: 1 })
      : [];
    const requestsByGroup = new Map();
    requests.forEach((request) => {
      const group = requestsByGroup.get(request.requestGroupId) || [];
      group.push(request);
      requestsByGroup.set(request.requestGroupId, group);
    });

    return response.json({
      items: checkoutSessions.data.map((session) => {
        const groupId = session.metadata?.requestGroupId || '';
        const groupRequests = requestsByGroup.get(groupId) || [];
        return {
          id: session.id,
          type: 'Stripe Checkout',
          status: session.status || 'unknown',
          paymentStatus: session.payment_status || 'unknown',
          amountTotal: session.amount_total || 0,
          currency: (session.currency || 'cad').toUpperCase(),
          customerEmail: session.customer_details?.email || groupRequests[0]?.requesterEmail || '',
          requestGroupId: groupId,
          serviceId: session.metadata?.serviceId || 'unknown',
          serviceName: session.metadata?.serviceName || 'Stripe payment',
          requestCount: groupRequests.length,
          requestTitles: groupRequests.map((request) => request.track || request.message),
          confirmationCodes: groupRequests.map((request) => request.confirmationCode).filter(Boolean),
          createdAt: session.created ? new Date(session.created * 1000).toISOString() : null,
          receiptSent: groupRequests.some((request) => Boolean(request.receiptSentAt)),
          paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : '',
        };
      }),
    });
  } catch (error) {
    console.error('Stripe transactions fetch failed:', error);
    return response.status(502).json({ message: 'Stripe transactions could not be loaded.' });
  }
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
  const deleted = await LiveSession.findOneAndDelete({ externalId: request.params.id });

  if (!deleted) {
    return response.status(404).json({
      message: 'Live session not found.',
    });
  }

  await deleteCloudinaryAudio(deleted.audioPublicId);

  return response.json({
    ok: true,
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

  const config = await LiveStreamConfig.findOneAndUpdate(
    { key: defaultLiveStreamConfig.key },
    parsed.data,
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return response.json({
    item: serializeLiveStreamConfig(config),
  });
});

app.get('/api/live-stream/admin', requireAdmin, async (_request, response) => {
  const config = await getLiveStreamConfig();

  return response.json({
    item: serializeAdminLiveStreamConfig(config),
  });
});

app.get('/api/youtube/search', async (request, response) => {
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

app.post('/api/live-requests/analyze', async (request, response) => {
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

async function createLiveRequestCheckout(request, response) {
  const parsed = liveRequestCheckoutSchema.safeParse(request.body);

  if (!parsed.success) {
    return response.status(400).json({
      message: 'Live request payload failed validation.',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  if (!stripe) {
    return response.status(503).json({ message: 'Song request payments are not configured.' });
  }

  await ensureServicePrices();
  const songRequestPrice = await ServicePrice.findOne({ serviceId: 'song-request-live', isActive: true });

  if (!songRequestPrice || !Number.isInteger(songRequestPrice.amountCents) || songRequestPrice.amountCents < 50) {
    return response.status(503).json({ message: 'The song request price is not configured correctly.' });
  }

  const requestGroupId = createCode('GROUP');
  const requestDrafts = parsed.data.requests.map((item) => ({
    externalId: `live-request-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    requesterName: parsed.data.requesterName,
    requesterEmail: parsed.data.requesterEmail,
    requestGroupId,
    confirmationCode: createCode('REQ'),
    message: item.message,
    ...buildDirectRequestMetadata(item.message),
    requestStatus: 'pending_admin',
    paymentStatus: 'unpaid',
    aiSummary: 'Payment pending before Khalil review.',
  }));
  const liveRequests = await LiveRequest.insertMany(requestDrafts);

  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: songRequestPrice.currency.toLowerCase(),
            product_data: {
              name: 'Khalil live song request',
              description: `${liveRequests.length} audience song request${liveRequests.length === 1 ? '' : 's'}`,
            },
            unit_amount: songRequestPrice.amountCents,
          },
          quantity: liveRequests.length,
        },
      ],
      metadata: {
        requestGroupId,
        serviceId: 'song-request-live',
        serviceName: 'Song Request During Live Events',
      },
      payment_intent_data: {
        metadata: {
          requestGroupId,
          serviceId: 'song-request-live',
          serviceName: 'Song Request During Live Events',
        },
      },
      success_url: `${getFrontendUrl()}/?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${getFrontendUrl()}/?stripe=cancelled`,
    });

    await LiveRequest.updateMany(
      { requestGroupId },
      { stripeCheckoutSessionId: checkoutSession.id },
    );

    return response.status(201).json({
      checkoutUrl: checkoutSession.url,
      message: 'Redirecting you to secure payment.',
    });
  } catch (error) {
    await LiveRequest.deleteMany({ requestGroupId });
    console.error('Stripe Checkout session creation failed:', error);
    return response.status(502).json({ message: 'Secure payment could not be started.' });
  }
}

app.post('/api/live-requests/checkout', createLiveRequestCheckout);
app.post('/api/live-requests', createLiveRequestCheckout);

app.get('/api/live-requests/admin', requireAdmin, async (_request, response) => {
  const requests = await LiveRequest.find({ paymentStatus: 'paid' }).sort({ createdAt: -1 });

  return response.json({
    items: requests.map(serializeLiveRequest),
  });
});

app.delete('/api/live-requests/:id', requireAdmin, async (request, response) => {
  const deleted = await LiveRequest.findOneAndDelete({ externalId: request.params.id });

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

  if (parsed.data.decision === 'rejected') {
    liveRequest.requestStatus = 'rejected';
    liveRequest.adminNote = parsed.data.adminNote;
    await liveRequest.save();

    return response.json({
      item: serializeLiveRequest(liveRequest),
    });
  }

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
    lyricsSummary: liveRequest.lyricsSummary,
    lyricsMoods: liveRequest.lyricsMoods,
    lyricsEnergy: liveRequest.lyricsEnergy,
    themes: liveRequest.themes,
    lyricsLanguage: liveRequest.lyricsLanguage,
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

    return response.status(409).json({
      message: 'This request matches an existing live session item.',
      item: serializeLiveRequest(liveRequest),
    });
  }

  const createdSession = await LiveSession.create({
    externalId: `live-session-${Date.now()}`,
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
    lyricsSummary: liveRequest.lyricsSummary,
    lyricsMoods: liveRequest.lyricsMoods,
    lyricsEnergy: liveRequest.lyricsEnergy,
    themes: liveRequest.themes,
    lyricsLanguage: liveRequest.lyricsLanguage,
    explicit: liveRequest.explicit,
    playState: 'requested',
    sortOrder: 0,
    sourcePlatform: liveRequest.sourcePlatform,
    sourceUrl: liveRequest.sourceUrl,
    requestExternalId: liveRequest.externalId,
  });

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
});

app.post('/api/live-stream/mux', requireAdmin, async (request, response) => {
  try {
    const currentConfig = await getLiveStreamConfig();
    const muxLiveStream = await createMuxLiveStream(request.body?.title || currentConfig.title);
    const muxPlaybackId = muxLiveStream.playback_ids?.[0]?.id || '';
    const muxStreamKey = muxLiveStream.stream_key || '';
    const muxRtmpUrl = currentConfig.muxRtmpUrl || defaultLiveStreamConfig.muxRtmpUrl;
    const streamUrl = buildMuxPlaybackUrl(muxPlaybackId);

    const updatedConfig = await LiveStreamConfig.findOneAndUpdate(
      { key: defaultLiveStreamConfig.key },
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
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

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

app.post('/api/archive-items', requireAdmin, async (request, response) => {
  const parsed = archiveItemSchema.safeParse(request.body);

  if (!parsed.success) {
    return response.status(400).json({
      message: 'Archive payload failed validation.',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const item = await ArchiveItem.create({
    externalId: `archive-${Date.now()}`,
    ...parsed.data,
  });

  return response.status(201).json({
    item: serializeArchiveItem(item),
  });
});

app.patch('/api/archive-items/:id', requireAdmin, async (request, response) => {
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
  const deleted = await ArchiveItem.findOneAndDelete({ externalId: request.params.id });

  if (!deleted) {
    return response.status(404).json({
      message: 'Archive item not found.',
    });
  }

  return response.json({
    ok: true,
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

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(error.status || 500).json({
    message: error.status === 403 ? error.message : 'Unexpected server error.',
  });
});

app.use((_request, response) => {
  response.status(404).json({
    message: 'Route not found.',
  });
});

async function startServer(port = PORT) {
  await connectToDatabase();

  return app.listen(port, () => {
    console.log(`Khalil app API listening on http://localhost:${port}`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to start Khalil app API.');
    console.error(error);
    process.exit(1);
  });
}

module.exports = { app, startServer };
