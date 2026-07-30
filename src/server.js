require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { z } = require('zod');
const { connectToDatabase, MONGODB_DB_NAME, MONGODB_URI } = require('./db');
const { ADMIN_USERNAME, defaultLiveStreamConfig } = require('./default-data');
const {
  ArchiveItem,
  Booking,
  LiveRequest,
  LiveSession,
  LiveStreamConfig,
  User,
} = require('./models');
const {
  LIVE_PLAY_STATES,
  analyzeLiveRequest,
  buildReorderedQueue,
} = require('./live-request-agent');
const { analyzeAudioWithCyanite } = require('./cyanite');
const { createSessionToken, hashPassword, verifyPassword } = require('./security');

const app = express();
const PORT = process.env.PORT || 4000;
const upload = multer({ storage: multer.memoryStorage() });

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

const liveSessionSchema = z.object({
  track: z.string().trim().min(1, 'Song / music is required.'),
  artist: z.string().trim().optional().default(''),
  duration: z.string().trim().default(''),
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
  }),
});

const liveRequestReviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  adminNote: z.string().trim().optional().default(''),
});

const archiveItemSchema = z.object({
  title: z.string().trim().min(1, 'Title is required.'),
  category: z.string().trim().min(1, 'Category is required.'),
  location: z.string().trim().default(''),
  date: z.string().trim().default(''),
  mediaType: z.string().trim().default(''),
  image: z.string().trim().default(''),
  alt: z.string().trim().default(''),
});

const liveStreamConfigSchema = z.object({
  isLive: z.boolean().default(false),
  title: z.string().trim().default(''),
  streamUrl: z.string().trim().default(''),
  posterImage: z.string().trim().default(''),
  statusLabel: z.string().trim().default(''),
  activeSessionId: z.string().trim().default(''),
});

const liveSessionAnalysisSchema = z.object({
  track: z.string().trim().optional().default(''),
  artist: z.string().trim().optional().default(''),
  duration: z.string().trim().optional().default(''),
  genre: z.string().trim().optional().default(''),
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
  sourceUrl: z.string().trim().optional().default(''),
  audioUrl: z.string().trim().optional().default(''),
  audioOriginalName: z.string().trim().optional().default(''),
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

function serializeLiveSession(session) {
  return {
    id: session.externalId || session.id,
    track: session.track,
    artist: session.artist || '',
    duration: session.duration,
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
    category: item.category,
    location: item.location,
    date: item.date,
    mediaType: item.mediaType,
    image: item.image,
    alt: item.alt,
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
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const configuredCorsOrigins = parseCorsOrigins(process.env.CORS_ORIGIN);

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

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || configuredCorsOrigins.length === 0 || configuredCorsOrigins.includes('*')) {
        return callback(null, true);
      }

      if (configuredCorsOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`Origin ${origin} is not allowed by CORS.`));
    },
  }),
);
app.use(express.json());

app.get('/api/health', async (_request, response) => {
  response.json({
    ok: true,
    service: 'khalil app api',
    database: MONGODB_URI,
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

app.post('/api/live-sessions/analyze', requireAdmin, async (request, response) => {
  const parsed = liveSessionAnalysisSchema.safeParse(request.body);

  if (!parsed.success) {
    return response.status(400).json({
      message: 'Live session analysis payload failed validation.',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const input = parsed.data;
  const sourceUrl = input.sourceUrl || input.audioUrl || '';
  const message = [input.artist, input.track, sourceUrl].filter(Boolean).join(' - ') || input.audioOriginalName || '';

  try {
    const cyaniteAnalysis = await analyzeAudioWithCyanite({
      audioUrl: input.audioUrl,
      track: input.track,
      artist: input.artist,
      audioOriginalName: input.audioOriginalName,
    });
    const cyaniteMetadata = cyaniteAnalysis?.metadata || {};
    const analysis = await analyzeLiveRequest(message, [], {
      track: cyaniteMetadata.track || input.track,
      artist: cyaniteMetadata.artist || input.artist,
      duration: input.duration,
      genre: cyaniteMetadata.genre || input.genre,
      genres: cyaniteMetadata.genres || input.genres,
      subgenres: cyaniteMetadata.subgenres || input.subgenres,
      language: input.language,
      musicMoods: cyaniteMetadata.musicMoods || input.musicMoods,
      instruments: cyaniteMetadata.instruments || input.instruments,
      bpm: cyaniteMetadata.bpm || input.bpm,
      musicalKey: cyaniteMetadata.musicalKey || input.musicalKey,
      vocals: cyaniteMetadata.vocals || input.vocals,
      energy: cyaniteMetadata.energy || input.energy,
      beat: cyaniteMetadata.beat || input.beat,
      lyricsSummary: cyaniteMetadata.lyricsSummary || input.lyricsSummary,
      lyricsMoods: input.lyricsMoods,
      lyricsEnergy: input.lyricsEnergy,
      themes: cyaniteMetadata.themes || input.themes,
      lyricsLanguage: input.lyricsLanguage,
      explicit: input.explicit,
      sourceUrl,
      sourcePlatform: sourceUrl ? 'link' : 'manual',
      analysisSources: Array.isArray(cyaniteMetadata.analysisSources)
        ? cyaniteMetadata.analysisSources
        : [],
    });

    return response.json({
      item: {
        analysisStatus: cyaniteAnalysis?.status || 'finished',
        track: analysis.metadata.track || input.track,
        artist: analysis.metadata.artist || input.artist,
        duration: analysis.metadata.duration || input.duration,
        genre: analysis.metadata.genre || input.genre,
        genres: analysis.metadata.genres || input.genres,
        subgenres: analysis.metadata.subgenres || input.subgenres,
        language: analysis.metadata.language || input.language,
        musicMoods: analysis.metadata.musicMoods || input.musicMoods,
        instruments: analysis.metadata.instruments || input.instruments,
        bpm: analysis.metadata.bpm || input.bpm,
        musicalKey: analysis.metadata.musicalKey || input.musicalKey,
        vocals: analysis.metadata.vocals || input.vocals,
        energy: analysis.metadata.energy || input.energy,
        beat: analysis.metadata.beat || input.beat,
        lyricsSummary: analysis.metadata.lyricsSummary || input.lyricsSummary,
        lyricsMoods: analysis.metadata.lyricsMoods || input.lyricsMoods,
        lyricsEnergy: analysis.metadata.lyricsEnergy || input.lyricsEnergy,
        themes: analysis.metadata.themes || input.themes,
        lyricsLanguage: analysis.metadata.lyricsLanguage || input.lyricsLanguage,
        explicit: analysis.metadata.explicit || input.explicit,
        analysisSources: Array.isArray(analysis.metadata.analysisSources)
          ? analysis.metadata.analysisSources
          : [],
        summary: cyaniteAnalysis?.summary || analysis.summary,
      },
    });
  } catch (error) {
    console.error('Live session analysis failed:', error);
    return response.status(500).json({
      message: error?.message || 'Live session analysis failed.',
    });
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

app.post('/api/live-requests', async (request, response) => {
  const parsed = liveRequestCreateSchema.safeParse(request.body);

  if (!parsed.success) {
    return response.status(400).json({
      message: 'Live request payload failed validation.',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const liveSessions = await getOrderedLiveSessions();
  const analysis = await analyzeLiveRequest(parsed.data.message, liveSessions, {
    requesterName: parsed.data.requesterName,
    ...parsed.data.metadata,
  });

  const requestStatus = analysis.duplicateSession ? 'duplicate' : 'pending_admin';
  const liveRequest = await LiveRequest.create({
    externalId: `live-request-${Date.now()}`,
    requesterName: parsed.data.requesterName,
    message: parsed.data.message,
    track: analysis.metadata.track,
    artist: analysis.metadata.artist,
    duration: analysis.metadata.duration,
    genre: analysis.metadata.genre,
    genres: analysis.metadata.genres,
    subgenres: analysis.metadata.subgenres,
    language: analysis.metadata.language,
    mood: analysis.metadata.mood,
    musicMoods: analysis.metadata.musicMoods,
    instruments: analysis.metadata.instruments,
    bpm: analysis.metadata.bpm,
    musicalKey: analysis.metadata.musicalKey,
    vocals: analysis.metadata.vocals,
    energy: analysis.metadata.energy,
    beat: analysis.metadata.beat,
    lyricsSummary: analysis.metadata.lyricsSummary,
    lyricsMoods: analysis.metadata.lyricsMoods,
    lyricsEnergy: analysis.metadata.lyricsEnergy,
    themes: analysis.metadata.themes,
    lyricsLanguage: analysis.metadata.lyricsLanguage,
    explicit: analysis.metadata.explicit,
    sourcePlatform: analysis.metadata.sourcePlatform,
    sourceUrl: analysis.metadata.sourceUrl,
    thumbnailUrl: analysis.metadata.thumbnailUrl,
    analysisSources: analysis.metadata.analysisSources,
    requestStatus,
    duplicateSessionExternalId: analysis.duplicateSession?.externalId || '',
    suggestedInsertAfterId: analysis.insertion.insertAfterId,
    suggestedInsertBeforeId: analysis.insertion.insertBeforeId,
    suggestedInsertLabel: analysis.insertion.label,
    aiSummary: analysis.summary,
  });

  return response.status(201).json({
    item: serializeLiveRequest(liveRequest),
    message:
      requestStatus === 'duplicate'
        ? 'This track already exists in the live session list, so the request was flagged as a duplicate.'
        : 'Request transmitted to Khalil for review.',
  });
});

app.get('/api/live-requests/admin', requireAdmin, async (_request, response) => {
  const requests = await LiveRequest.find().sort({ createdAt: -1 });

  return response.json({
    items: requests.map(serializeLiveRequest),
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
  response.status(500).json({
    message: 'Unexpected server error.',
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
