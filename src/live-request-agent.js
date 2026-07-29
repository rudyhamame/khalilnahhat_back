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

function mergeAnalysisMetadata({
  overrideMetadata,
  linkMetadata,
  inferredFromMessage,
  primaryUrl,
}) {
  const mergedTrack =
    cleanOptionalText(overrideMetadata.track) ||
    cleanOptionalText(linkMetadata?.track) ||
    cleanOptionalText(inferredFromMessage.track);
  const mergedArtist =
    cleanOptionalText(overrideMetadata.artist) ||
    cleanOptionalText(linkMetadata?.artist) ||
    cleanOptionalText(inferredFromMessage.artist);
  const mergedGenre =
    cleanOptionalText(overrideMetadata.genre) ||
    cleanOptionalText(overrideMetadata.genres);
  const mergedLanguage =
    cleanOptionalText(overrideMetadata.language) ||
    cleanOptionalText(overrideMetadata.lyricsLanguage);
  const mergedDuration =
    cleanOptionalText(overrideMetadata.duration);

  const sourceNotes = [];

  if (Array.isArray(overrideMetadata.analysisSources)) {
    sourceNotes.push(
      ...overrideMetadata.analysisSources
        .map((entry) => cleanOptionalText(entry))
        .filter(Boolean),
    );
  }

  if (linkMetadata?.track || linkMetadata?.artist) {
    sourceNotes.push('link metadata');
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
    genres: cleanOptionalText(overrideMetadata.genres) || mergedGenre,
    subgenres: cleanOptionalText(overrideMetadata.subgenres) || '',
    language: mergedLanguage,
    musicMoods: cleanOptionalText(overrideMetadata.musicMoods) || '',
    instruments: cleanOptionalText(overrideMetadata.instruments) || '',
    bpm: cleanOptionalText(overrideMetadata.bpm) || '',
    musicalKey: cleanOptionalText(overrideMetadata.musicalKey) || '',
    vocals: cleanOptionalText(overrideMetadata.vocals) || '',
    mood: '',
    energy: cleanOptionalText(overrideMetadata.energy) || '',
    beat:
      cleanOptionalText(overrideMetadata.beat) ||
      cleanOptionalText(overrideMetadata.bpm),
    lyricsSummary: cleanOptionalText(overrideMetadata.lyricsSummary) || '',
    lyricsMoods: cleanOptionalText(overrideMetadata.lyricsMoods) || '',
    lyricsEnergy: cleanOptionalText(overrideMetadata.lyricsEnergy) || '',
    themes: '',
    lyricsLanguage:
      cleanOptionalText(overrideMetadata.lyricsLanguage) ||
      mergedLanguage,
    explicit: cleanOptionalText(overrideMetadata.explicit) || '',
    sourcePlatform:
      overrideMetadata.sourcePlatform ||
      linkMetadata?.sourcePlatform ||
      (primaryUrl ? detectPlatformFromUrl(primaryUrl) : 'manual'),
    sourceUrl: primaryUrl,
    thumbnailUrl: overrideMetadata.thumbnailUrl || linkMetadata?.thumbnailUrl || '',
    analysisSources: [...new Set(sourceNotes)],
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

  const metadata = mergeAnalysisMetadata({
    overrideMetadata,
    linkMetadata,
    inferredFromMessage,
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
