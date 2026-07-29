const LIVE_PLAY_STATES = ['played', 'live', 'queued', 'requested'];
const LIVE_REQUEST_STATUSES = ['pending_admin', 'approved', 'rejected', 'duplicate'];

const PLATFORM_RULES = [
  { key: 'youtube', test: (hostname) => hostname.includes('youtube.com') || hostname.includes('youtu.be') },
  { key: 'anghami', test: (hostname) => hostname.includes('anghami.com') },
  { key: 'spotify', test: (hostname) => hostname.includes('spotify.com') },
  { key: 'instagram', test: (hostname) => hostname.includes('instagram.com') },
  { key: 'facebook', test: (hostname) => hostname.includes('facebook.com') || hostname.includes('fb.watch') },
  { key: 'tiktok', test: (hostname) => hostname.includes('tiktok.com') },
];

function normalizeTrackText(value) {
  return (value || '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/official|video|audio|lyrics|lyric|hd|4k|visualizer|music/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractUrlsFromText(text) {
  return Array.from((text || '').matchAll(/https?:\/\/[^\s]+/g), (match) => match[0]);
}

function detectPlatformFromUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return PLATFORM_RULES.find((rule) => rule.test(hostname))?.key || 'link';
  } catch {
    return 'manual';
  }
}

function stripUrls(text) {
  return (text || '').replace(/https?:\/\/[^\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanTrackText(value) {
  return (value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[-|/]\s*(official|video|audio|lyrics).*$/i, '')
    .trim();
}

function cleanOptionalText(value) {
  return cleanTrackText(value || '');
}

function normalizeListText(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cleanTrackText(entry || '')).filter(Boolean).join(', ');
  }

  return cleanTrackText(value || '');
}

function inferTrackArtistFromTitle(rawTitle) {
  const cleanedTitle = cleanTrackText(rawTitle);

  if (!cleanedTitle) {
    return { track: '', artist: '' };
  }

  const dashParts = cleanedTitle.split(/\s[-–]\s/);

  if (dashParts.length >= 2) {
    return {
      artist: dashParts[0].trim(),
      track: dashParts.slice(1).join(' - ').trim(),
    };
  }

  return {
    track: cleanedTitle,
    artist: '',
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
      'User-Agent': 'KhalilNahhatLiveRequestAgent/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Metadata request failed with status ${response.status}.`);
  }

  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'KhalilNahhatLiveRequestAgent/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`HTML request failed with status ${response.status}.`);
  }

  return response.text();
}

async function fetchOEmbedMetadata(url, platform) {
  const encodedUrl = encodeURIComponent(url);

  if (platform === 'youtube') {
    return fetchJson(`https://www.youtube.com/oembed?url=${encodedUrl}&format=json`);
  }

  if (platform === 'spotify') {
    return fetchJson(`https://open.spotify.com/oembed?url=${encodedUrl}`);
  }

  if (platform === 'tiktok') {
    return fetchJson(`https://www.tiktok.com/oembed?url=${encodedUrl}`);
  }

  return null;
}

function extractTitleFromHtml(html) {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return cleanTrackText(titleMatch?.[1] || '');
}

async function fetchLinkMetadata(url) {
  const sourcePlatform = detectPlatformFromUrl(url);
  let title = '';
  let artist = '';
  let thumbnailUrl = '';

  try {
    const oEmbed = await fetchOEmbedMetadata(url, sourcePlatform);
    if (oEmbed) {
      title = cleanTrackText(oEmbed.title || '');
      artist = cleanTrackText(oEmbed.author_name || '');
      thumbnailUrl = oEmbed.thumbnail_url || '';
    }
  } catch {
    // Ignore metadata failures and fall back to HTML title parsing below.
  }

  if (!title) {
    try {
      const html = await fetchText(url);
      title = extractTitleFromHtml(html);
    } catch {
      // Fall back to user-provided text when the remote page cannot be read.
    }
  }

  const inferred = inferTrackArtistFromTitle(title);

  return {
    sourcePlatform,
    sourceUrl: url,
    title,
    artist: artist || inferred.artist,
    track: inferred.track || title,
    thumbnailUrl,
  };
}

function getSonoTellerConfig() {
  const apiUrl = process.env.SONOTELLER_API_URL || '';
  const apiKey = process.env.SONOTELLER_API_KEY || '';
  const apiHost = process.env.SONOTELLER_API_HOST || '';
  const apiMethod = (process.env.SONOTELLER_HTTP_METHOD || 'POST').toUpperCase();

  return {
    apiUrl,
    apiKey,
    apiHost,
    apiMethod,
    enabled: Boolean(apiUrl && apiKey),
  };
}

function readNestedValue(payload, candidatePaths) {
  for (const candidatePath of candidatePaths) {
    const value = candidatePath.split('.').reduce((currentValue, segment) => {
      if (currentValue && typeof currentValue === 'object' && segment in currentValue) {
        return currentValue[segment];
      }

      return undefined;
    }, payload);

    if (value !== undefined && value !== null && `${value}`.trim() !== '') {
      return value;
    }
  }

  return '';
}

function normalizeSonoTellerResponse(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const track = cleanOptionalText(
    readNestedValue(payload, [
      'track',
      'song',
      'title',
      'data.track',
      'data.song',
      'data.title',
      'result.track',
      'result.song',
      'result.title',
    ]),
  );
  const artist = cleanOptionalText(
    readNestedValue(payload, [
      'artist',
      'artist_name',
      'author',
      'data.artist',
      'data.artist_name',
      'result.artist',
      'result.artist_name',
    ]),
  );
  const genre = cleanOptionalText(
    readNestedValue(payload, [
      'genre',
      'primary_genre',
      'genres',
      'data.genre',
      'data.genres',
      'data.primary_genre',
      'result.genre',
      'result.genres',
      'result.primary_genre',
    ]),
  );
  const genres = normalizeListText(
    readNestedValue(payload, [
      'genres',
      'genre',
      'primary_genre',
      'music.genres',
      'music.genre',
      'data.genres',
      'data.genre',
      'result.genres',
      'result.genre',
    ]),
  );
  const subgenres = normalizeListText(
    readNestedValue(payload, [
      'subgenres',
      'sub_genres',
      'subgenre',
      'music.subgenres',
      'data.subgenres',
      'data.sub_genres',
      'result.subgenres',
      'result.sub_genres',
    ]),
  );
  const language = cleanOptionalText(
    readNestedValue(payload, [
      'language',
      'lyrics_language',
      'data.language',
      'data.lyrics_language',
      'result.language',
      'result.lyrics_language',
    ]),
  );
  const duration = cleanOptionalText(
    readNestedValue(payload, [
      'duration',
      'duration_formatted',
      'data.duration',
      'data.duration_formatted',
      'result.duration',
      'result.duration_formatted',
    ]),
  );
  const mood = cleanOptionalText(
    readNestedValue(payload, [
      'mood',
      'moods',
      'music_moods',
      'data.mood',
      'data.moods',
      'data.music_moods',
      'result.mood',
      'result.moods',
      'result.music_moods',
    ]),
  );
  const musicMoods = normalizeListText(
    readNestedValue(payload, [
      'music_moods',
      'moods',
      'mood',
      'music.moods',
      'data.music_moods',
      'data.moods',
      'result.music_moods',
      'result.moods',
    ]),
  );
  const instruments = normalizeListText(
    readNestedValue(payload, [
      'instruments',
      'instrumentation',
      'music.instruments',
      'data.instruments',
      'data.instrumentation',
      'result.instruments',
      'result.instrumentation',
    ]),
  );
  const energy = cleanOptionalText(
    readNestedValue(payload, [
      'energy',
      'energy_level',
      'data.energy',
      'data.energy_level',
      'result.energy',
      'result.energy_level',
    ]),
  );
  const beat = cleanOptionalText(
    readNestedValue(payload, [
      'beat',
      'bpm',
      'tempo',
      'data.beat',
      'data.bpm',
      'data.tempo',
      'result.beat',
      'result.bpm',
      'result.tempo',
    ]),
  );
  const bpm = cleanOptionalText(
    readNestedValue(payload, [
      'bpm',
      'tempo',
      'beat',
      'music.bpm',
      'music.tempo',
      'data.bpm',
      'data.tempo',
      'result.bpm',
      'result.tempo',
    ]),
  );
  const musicalKey = cleanOptionalText(
    readNestedValue(payload, [
      'key',
      'musical_key',
      'music.key',
      'data.key',
      'data.musical_key',
      'result.key',
      'result.musical_key',
    ]),
  );
  const vocals = normalizeListText(
    readNestedValue(payload, [
      'vocals',
      'vocal_type',
      'vocal_presence',
      'music.vocals',
      'data.vocals',
      'data.vocal_type',
      'result.vocals',
      'result.vocal_type',
    ]),
  );
  const lyricsSummary = cleanOptionalText(
    readNestedValue(payload, [
      'lyrics_summary',
      'summary',
      'lyrics.summary',
      'data.lyrics_summary',
      'data.summary',
      'result.lyrics_summary',
      'result.summary',
    ]),
  );
  const lyricsMoods = normalizeListText(
    readNestedValue(payload, [
      'lyrics_moods',
      'lyric_moods',
      'lyrics.moods',
      'data.lyrics_moods',
      'result.lyrics_moods',
    ]),
  );
  const lyricsEnergy = cleanOptionalText(
    readNestedValue(payload, [
      'lyrics_energy',
      'lyric_energy',
      'emotion_intensity',
      'sentiment_intensity',
      'lyrics.energy',
      'data.lyrics_energy',
      'data.lyric_energy',
      'result.lyrics_energy',
      'result.lyric_energy',
    ]),
  );
  const themes = readNestedValue(payload, [
    'themes',
    'tags',
    'keywords',
    'data.themes',
    'data.tags',
    'result.themes',
    'result.tags',
  ]);
  const lyricsLanguage = cleanOptionalText(
    readNestedValue(payload, [
      'lyrics_language',
      'language',
      'lyrics.language',
      'data.lyrics_language',
      'result.lyrics_language',
    ]),
  );
  const explicit = cleanOptionalText(
    readNestedValue(payload, [
      'explicit',
      'explicit_content',
      'lyrics.explicit',
      'data.explicit',
      'data.explicit_content',
      'result.explicit',
      'result.explicit_content',
    ]),
  );

  return {
    track,
    artist,
    genre: genre || genres.split(',')[0]?.trim() || '',
    genres: genres || genre,
    subgenres,
    language: language || lyricsLanguage,
    musicMoods: musicMoods || mood,
    instruments,
    bpm: bpm || beat,
    musicalKey,
    vocals,
    duration,
    mood: Array.isArray(mood) ? mood.join(', ') : cleanOptionalText(mood),
    energy,
    beat: beat || bpm,
    lyricsSummary,
    lyricsMoods,
    lyricsEnergy,
    lyricsLanguage: lyricsLanguage || language,
    explicit,
    themes: Array.isArray(themes) ? themes.join(', ') : cleanOptionalText(themes),
    raw: payload,
  };
}

async function fetchSonoTellerAnalysis({
  message,
  sourceUrl,
  sourcePlatform,
  track,
  artist,
}) {
  const config = getSonoTellerConfig();

  if (!config.enabled) {
    return null;
  }

  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  if (config.apiHost) {
    headers['x-rapidapi-key'] = config.apiKey;
    headers['x-rapidapi-host'] = config.apiHost;
  } else {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const payload = {
    url: sourceUrl || '',
    sourceUrl: sourceUrl || '',
    platform: sourcePlatform || 'manual',
    message,
    track: track || '',
    artist: artist || '',
    title: [artist, track].filter(Boolean).join(' - '),
  };

  const requestOptions =
    config.apiMethod === 'GET'
      ? {
          method: 'GET',
          headers,
        }
      : {
          method: config.apiMethod,
          headers,
          body: JSON.stringify(payload),
        };

  const targetUrl =
    config.apiMethod === 'GET'
      ? `${config.apiUrl}?${new URLSearchParams(payload).toString()}`
      : config.apiUrl;

  const response = await fetch(targetUrl, requestOptions);
  const responsePayload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      responsePayload?.message || responsePayload?.error || `SonoTeller analysis failed with status ${response.status}.`,
    );
    error.payload = responsePayload;
    throw error;
  }

  return normalizeSonoTellerResponse(responsePayload);
}

function mergeAnalysisMetadata({
  overrideMetadata,
  linkMetadata,
  inferredFromMessage,
  sonotellerMetadata,
  primaryUrl,
}) {
  const mergedTrack =
    cleanOptionalText(overrideMetadata.track) ||
    cleanOptionalText(linkMetadata?.track) ||
    cleanOptionalText(sonotellerMetadata?.track) ||
    cleanOptionalText(inferredFromMessage.track);
  const mergedArtist =
    cleanOptionalText(overrideMetadata.artist) ||
    cleanOptionalText(linkMetadata?.artist) ||
    cleanOptionalText(sonotellerMetadata?.artist) ||
    cleanOptionalText(inferredFromMessage.artist);
  const mergedGenre =
    cleanOptionalText(overrideMetadata.genre) ||
    cleanOptionalText(overrideMetadata.genres) ||
    cleanOptionalText(sonotellerMetadata?.genre);
  const mergedLanguage =
    cleanOptionalText(overrideMetadata.language) ||
    cleanOptionalText(overrideMetadata.lyricsLanguage) ||
    cleanOptionalText(sonotellerMetadata?.language);
  const mergedDuration =
    cleanOptionalText(overrideMetadata.duration) ||
    cleanOptionalText(sonotellerMetadata?.duration);

  const sourceNotes = [];

  if (linkMetadata?.track || linkMetadata?.artist) {
    sourceNotes.push('link metadata');
  }

  if (sonotellerMetadata) {
    sourceNotes.push('SonoTeller');
  }

  if (!sourceNotes.length) {
    sourceNotes.push('message text');
  }

  return {
    requesterName: overrideMetadata.requesterName || 'Audience',
    track: mergedTrack,
    artist: mergedArtist,
    duration: mergedDuration,
    genre: mergedGenre,
    genres: cleanOptionalText(overrideMetadata.genres) || cleanOptionalText(sonotellerMetadata?.genres) || mergedGenre,
    subgenres: cleanOptionalText(overrideMetadata.subgenres) || cleanOptionalText(sonotellerMetadata?.subgenres) || '',
    language: mergedLanguage,
    musicMoods: cleanOptionalText(overrideMetadata.musicMoods) || cleanOptionalText(sonotellerMetadata?.musicMoods || ''),
    instruments: cleanOptionalText(overrideMetadata.instruments) || cleanOptionalText(sonotellerMetadata?.instruments || ''),
    bpm: cleanOptionalText(overrideMetadata.bpm) || cleanOptionalText(sonotellerMetadata?.bpm || ''),
    musicalKey: cleanOptionalText(overrideMetadata.musicalKey) || cleanOptionalText(sonotellerMetadata?.musicalKey || ''),
    vocals: cleanOptionalText(overrideMetadata.vocals) || cleanOptionalText(sonotellerMetadata?.vocals || ''),
    mood: cleanOptionalText(sonotellerMetadata?.mood || ''),
    energy: cleanOptionalText(sonotellerMetadata?.energy || ''),
    beat:
      cleanOptionalText(overrideMetadata.beat) ||
      cleanOptionalText(overrideMetadata.bpm) ||
      cleanOptionalText(sonotellerMetadata?.beat || '') ||
      cleanOptionalText(sonotellerMetadata?.bpm || ''),
    lyricsSummary: cleanOptionalText(overrideMetadata.lyricsSummary) || cleanOptionalText(sonotellerMetadata?.lyricsSummary || ''),
    lyricsMoods: cleanOptionalText(overrideMetadata.lyricsMoods) || cleanOptionalText(sonotellerMetadata?.lyricsMoods || ''),
    lyricsEnergy: cleanOptionalText(overrideMetadata.lyricsEnergy) || cleanOptionalText(sonotellerMetadata?.lyricsEnergy || ''),
    themes: cleanOptionalText(sonotellerMetadata?.themes || ''),
    lyricsLanguage:
      cleanOptionalText(overrideMetadata.lyricsLanguage) ||
      cleanOptionalText(sonotellerMetadata?.lyricsLanguage || '') ||
      mergedLanguage,
    explicit: cleanOptionalText(overrideMetadata.explicit) || cleanOptionalText(sonotellerMetadata?.explicit || ''),
    sourcePlatform:
      overrideMetadata.sourcePlatform ||
      linkMetadata?.sourcePlatform ||
      (primaryUrl ? detectPlatformFromUrl(primaryUrl) : 'manual'),
    sourceUrl: primaryUrl,
    thumbnailUrl: overrideMetadata.thumbnailUrl || linkMetadata?.thumbnailUrl || '',
    analysisSources: sourceNotes,
  };
}

function buildQueueWindow(sessions) {
  const ordered = [...sessions].sort((left, right) => {
    const orderDelta = (left.sortOrder || 0) - (right.sortOrder || 0);
    if (orderDelta !== 0) {
      return orderDelta;
    }

    return new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime();
  });

  const boundaryIndex = ordered.reduce(
    (currentIndex, session, sessionIndex) =>
      session.playState === 'played' || session.playState === 'live' ? sessionIndex : currentIndex,
    -1,
  );

  return {
    ordered,
    futureSessions: ordered.slice(boundaryIndex + 1),
    boundaryIndex,
  };
}

function findDuplicateSession(sessions, track) {
  const normalizedTrack = normalizeTrackText(track);

  if (!normalizedTrack) {
    return null;
  }

  return (
    sessions.find((session) => normalizeTrackText(session.track) === normalizedTrack) || null
  );
}

function suggestInsertionPoint(sessions, metadata) {
  const { ordered, futureSessions, boundaryIndex } = buildQueueWindow(sessions);

  if (!futureSessions.length) {
    const previous = ordered[ordered.length - 1] || null;
    return {
      insertIndex: ordered.length,
      insertAfterId: previous?.externalId || previous?.id || '',
      insertBeforeId: '',
      label: previous
        ? `After ${previous.track}`
        : 'First item in the live session queue',
    };
  }

  const normalizedGenre = normalizeTrackText(metadata.genre);
  const normalizedLanguage = normalizeTrackText(metadata.language);
  const matchIndex = futureSessions.findIndex((session) => {
    const sameGenre =
      normalizedGenre && normalizeTrackText(session.genre) === normalizedGenre;
    const sameLanguage =
      normalizedLanguage && normalizeTrackText(session.language) === normalizedLanguage;
    return sameGenre || sameLanguage;
  });

  const insertIndex = matchIndex >= 0 ? boundaryIndex + 1 + matchIndex : ordered.length;
  const previous = ordered[insertIndex - 1] || null;
  const next = ordered[insertIndex] || null;

  return {
    insertIndex,
    insertAfterId: previous?.externalId || previous?.id || '',
    insertBeforeId: next?.externalId || next?.id || '',
    label:
      previous && next
        ? `Between ${previous.track} and ${next.track}`
        : previous
          ? `After ${previous.track}`
          : next
            ? `Before ${next.track}`
            : 'First item in the live session queue',
  };
}

async function analyzeLiveRequest(message, sessions, overrideMetadata = {}) {
  const urls = extractUrlsFromText(message);
  const primaryUrl = overrideMetadata.sourceUrl || urls[0] || '';
  const linkMetadata = primaryUrl ? await fetchLinkMetadata(primaryUrl) : null;
  const plainText = stripUrls(message);
  const inferredFromMessage = inferTrackArtistFromTitle(plainText);
  let sonotellerMetadata = null;

  try {
    sonotellerMetadata = await fetchSonoTellerAnalysis({
      message,
      sourceUrl: primaryUrl,
      sourcePlatform: linkMetadata?.sourcePlatform || (primaryUrl ? detectPlatformFromUrl(primaryUrl) : 'manual'),
      track:
        cleanOptionalText(overrideMetadata.track) ||
        cleanOptionalText(linkMetadata?.track) ||
        cleanOptionalText(inferredFromMessage.track),
      artist:
        cleanOptionalText(overrideMetadata.artist) ||
        cleanOptionalText(linkMetadata?.artist) ||
        cleanOptionalText(inferredFromMessage.artist),
    });
  } catch {
    sonotellerMetadata = null;
  }

  const metadata = mergeAnalysisMetadata({
    overrideMetadata,
    linkMetadata,
    inferredFromMessage,
    sonotellerMetadata,
    primaryUrl,
  });

  const duplicateSession = findDuplicateSession(sessions, metadata.track);
  const insertion = suggestInsertionPoint(sessions, metadata);
  const analysisSourcesLabel = metadata.analysisSources.join(' + ');
  const fitDescriptors = [metadata.genres || metadata.genre, metadata.lyricsLanguage || metadata.language, metadata.musicMoods || metadata.mood, metadata.energy]
    .filter(Boolean)
    .join(' / ');

  return {
    metadata,
    duplicateSession,
    insertion,
    linkMetadata,
    sonotellerMetadata,
    summary: duplicateSession
      ? `Integrated analysis from ${analysisSourcesLabel}: this request matches "${duplicateSession.track}" already in the live session list.`
      : insertion.label
        ? `Integrated analysis from ${analysisSourcesLabel}: best fit in the queue is ${insertion.label}${fitDescriptors ? `, based on ${fitDescriptors}` : ''}.`
        : `Integrated analysis from ${analysisSourcesLabel}: ready for Khalil to review and place into the live queue.`,
  };
}

function buildReorderedQueue(existingSessions, insertedSession, insertIndex) {
  const ordered = [...existingSessions].sort((left, right) => {
    const orderDelta = (left.sortOrder || 0) - (right.sortOrder || 0);
    if (orderDelta !== 0) {
      return orderDelta;
    }

    return new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime();
  });

  const nextQueue = [...ordered];
  nextQueue.splice(insertIndex, 0, insertedSession);

  return nextQueue.map((session, index) => ({
    session,
    sortOrder: (index + 1) * 100,
  }));
}

module.exports = {
  LIVE_PLAY_STATES,
  LIVE_REQUEST_STATUSES,
  analyzeLiveRequest,
  buildReorderedQueue,
  normalizeTrackText,
  suggestInsertionPoint,
};
