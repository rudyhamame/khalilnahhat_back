const CYANITE_API_URL = process.env.CYANITE_API_URL || 'https://api.cyanite.ai/graphql';

function hasCyaniteToken() {
  return Boolean(process.env.CYANITE_API_TOKEN);
}

async function cyaniteGraphQLRequest(query, variables = {}) {
  if (!hasCyaniteToken()) {
    throw new Error('CYANITE_API_TOKEN is missing from the server environment.');
  }

  const response = await fetch(CYANITE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.CYANITE_API_TOKEN}`,
    },
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload?.errors?.[0]?.message || `Cyanite request failed with status ${response.status}.`);
  }

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(payload.errors[0]?.message || 'Cyanite GraphQL returned an error.');
  }

  return payload.data || {};
}

async function requestCyaniteFileUpload() {
  const query = `
    mutation FileUploadRequestMutation {
      fileUploadRequest {
        id
        uploadUrl
      }
    }
  `;

  const data = await cyaniteGraphQLRequest(query);
  return data.fileUploadRequest || null;
}

async function uploadBufferToCyanite(uploadUrl, buffer) {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'audio/mpeg',
    },
    body: buffer,
  });

  if (!response.ok) {
    throw new Error(`Cyanite upload failed with status ${response.status}.`);
  }
}

async function createCyaniteLibraryTrack({ uploadId, title, externalId }) {
  const query = `
    mutation LibraryTrackCreateMutation($input: LibraryTrackCreateInput!) {
      libraryTrackCreate(input: $input) {
        __typename
        ... on LibraryTrackCreateSuccess {
          createdLibraryTrack {
            id
            title
          }
          enqueueResult {
            __typename
            ... on LibraryTrackEnqueueError {
              code
              message
            }
          }
        }
        ... on LibraryTrackCreateError {
          code
          message
        }
      }
    }
  `;

  const data = await cyaniteGraphQLRequest(query, {
    input: {
      uploadId,
      title,
      externalId,
    },
  });

  const result = data.libraryTrackCreate;

  if (!result) {
    throw new Error('Cyanite did not return a library track create result.');
  }

  if (result.__typename === 'LibraryTrackCreateError') {
    throw new Error(result.message || result.code || 'Cyanite could not create the library track.');
  }

  const enqueueError =
    result.enqueueResult?.__typename === 'LibraryTrackEnqueueError'
      ? result.enqueueResult
      : null;

  return {
    id: result.createdLibraryTrack?.id || '',
    title: result.createdLibraryTrack?.title || title || '',
    enqueueError,
  };
}

async function fetchCyaniteLibraryTrack(trackId) {
  const query = `
    query LibraryTrackAnalysisQuery($id: ID!) {
      libraryTrack(id: $id) {
        __typename
        ... on LibraryTrackNotFoundError {
          message
        }
        ... on LibraryTrack {
          id
          title
          audioAnalysisV7 {
            __typename
            ... on AudioAnalysisV7Finished {
              result {
                genreTags
                advancedGenreTags
                subgenreTags
                advancedSubgenreTags
                moodTags
                moodAdvancedTags
                instrumentTags
                advancedInstrumentTags
                bpmRangeAdjusted
                keyPrediction {
                  value
                  confidence
                }
                timeSignature
                energyLevel
                voicePresenceProfile
                voiceTags
                movementTags
                characterTags
                transformerCaption
                freeGenreTags
              }
            }
            ... on AudioAnalysisV7Failed {
              error {
                message
              }
            }
          }
        }
      }
    }
  `;

  const data = await cyaniteGraphQLRequest(query, { id: trackId });
  return data.libraryTrack || null;
}

function sleep(durationMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function pollCyaniteAnalysis(trackId, { timeoutMs = 25000, intervalMs = 2500 } = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const libraryTrack = await fetchCyaniteLibraryTrack(trackId);

    if (!libraryTrack) {
      throw new Error('Cyanite analysis track could not be loaded.');
    }

    if (libraryTrack.__typename === 'LibraryTrackNotFoundError') {
      throw new Error(libraryTrack.message || 'Cyanite could not find the uploaded analysis track.');
    }

    const analysis = libraryTrack.audioAnalysisV7;

    if (analysis?.__typename === 'AudioAnalysisV7Finished') {
      return {
        status: 'finished',
        track: libraryTrack,
        result: analysis.result || null,
      };
    }

    if (analysis?.__typename === 'AudioAnalysisV7Failed') {
      throw new Error(analysis.error?.message || 'Cyanite analysis failed.');
    }

    await sleep(intervalMs);
  }

  return {
    status: 'processing',
    track: await fetchCyaniteLibraryTrack(trackId),
    result: null,
  };
}

function normalizeJoinedList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean).join(', ');
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  return '';
}

function toTitleText(track, artist, fallbackName) {
  return [artist, track].filter(Boolean).join(' - ') || fallbackName || 'Uploaded track';
}

function mapCyaniteResultToSession(result, fallback = {}) {
  if (!result) {
    return null;
  }

  const genres =
    normalizeJoinedList(result.advancedGenreTags) ||
    normalizeJoinedList(result.genreTags) ||
    fallback.genres ||
    fallback.genre ||
    '';
  const subgenres =
    normalizeJoinedList(result.advancedSubgenreTags) ||
    normalizeJoinedList(result.subgenreTags) ||
    fallback.subgenres ||
    '';
  const musicMoods =
    normalizeJoinedList(result.moodAdvancedTags) ||
    normalizeJoinedList(result.moodTags) ||
    fallback.musicMoods ||
    '';
  const instruments =
    normalizeJoinedList(result.advancedInstrumentTags) ||
    normalizeJoinedList(result.instrumentTags) ||
    fallback.instruments ||
    '';
  const bpmValue = Number.isFinite(result.bpmRangeAdjusted)
    ? String(Math.round(result.bpmRangeAdjusted))
    : '';
  const movement = normalizeJoinedList(result.movementTags);
  const character = normalizeJoinedList(result.characterTags);
  const freeGenreTags = normalizeJoinedList(result.freeGenreTags);
  const vocals = [
    normalizeJoinedList(result.voiceTags),
    result.voicePresenceProfile ? String(result.voicePresenceProfile).trim() : '',
  ]
    .filter(Boolean)
    .join(', ');

  return {
    track: fallback.track || '',
    artist: fallback.artist || '',
    genre: genres.split(',')[0]?.trim() || fallback.genre || '',
    genres,
    subgenres,
    musicMoods,
    instruments,
    bpm: bpmValue || fallback.bpm || '',
    musicalKey: result.keyPrediction?.value ? String(result.keyPrediction.value).trim() : fallback.musicalKey || '',
    vocals: vocals || fallback.vocals || '',
    energy: result.energyLevel ? String(result.energyLevel).trim() : fallback.energy || '',
    beat: bpmValue || fallback.beat || '',
    themes: [movement, character, freeGenreTags].filter(Boolean).join(' | '),
    lyricsSummary: result.transformerCaption ? String(result.transformerCaption).trim() : fallback.lyricsSummary || '',
    analysisSources: ['Cyanite'],
    summary: result.transformerCaption
      ? `Cyanite analysis completed: ${String(result.transformerCaption).trim()}`
      : 'Cyanite analysis completed and filled the available music metadata.',
  };
}

async function analyzeAudioWithCyanite({
  audioUrl,
  track,
  artist,
  audioOriginalName,
}) {
  if (!audioUrl) {
    return null;
  }

  if (!hasCyaniteToken()) {
    return null;
  }

  const audioResponse = await fetch(audioUrl);

  if (!audioResponse.ok) {
    throw new Error(`Could not download the uploaded audio for Cyanite analysis (${audioResponse.status}).`);
  }

  const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
  const uploadRequest = await requestCyaniteFileUpload();

  if (!uploadRequest?.id || !uploadRequest?.uploadUrl) {
    throw new Error('Cyanite did not return a valid upload target.');
  }

  await uploadBufferToCyanite(uploadRequest.uploadUrl, audioBuffer);

  const externalId = `khalil-live-${Date.now()}`;
  const libraryTrack = await createCyaniteLibraryTrack({
    uploadId: uploadRequest.id,
    title: toTitleText(track, artist, audioOriginalName),
    externalId,
  });

  if (!libraryTrack.id) {
    throw new Error('Cyanite created the track without a usable id.');
  }

  if (libraryTrack.enqueueError?.message) {
    throw new Error(libraryTrack.enqueueError.message);
  }

  const analysis = await pollCyaniteAnalysis(libraryTrack.id);

  if (analysis.status !== 'finished') {
    return {
      status: analysis.status,
      metadata: {
        track: track || '',
        artist: artist || '',
        analysisSources: ['Cyanite'],
      },
      summary: 'Cyanite accepted the song and started analysis, but it is still processing. Try again in a few moments.',
    };
  }

  return {
    status: 'finished',
    metadata: mapCyaniteResultToSession(analysis.result, {
      track,
      artist,
    }),
  };
}

module.exports = {
  analyzeAudioWithCyanite,
  hasCyaniteToken,
};
