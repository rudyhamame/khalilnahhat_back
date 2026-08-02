const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phoneNumber: { type: String, required: true, trim: true },
    isAdmin: { type: Boolean, default: false },
    sessionToken: { type: String, default: '' },
  },
  { timestamps: true },
);

const liveSessionSchema = new mongoose.Schema(
  {
    externalId: { type: String, required: true, unique: true, trim: true },
    track: { type: String, required: true, trim: true },
    artist: { type: String, default: '', trim: true },
    duration: { type: String, default: '', trim: true },
    trackClass: { type: String, default: '', trim: true },
    genre: { type: String, default: '', trim: true },
    genres: { type: String, default: '', trim: true },
    subgenres: { type: String, default: '', trim: true },
    language: { type: String, default: '', trim: true },
    musicMoods: { type: String, default: '', trim: true },
    instruments: { type: String, default: '', trim: true },
    bpm: { type: String, default: '', trim: true },
    musicalKey: { type: String, default: '', trim: true },
    vocals: { type: String, default: '', trim: true },
    energy: { type: String, default: '', trim: true },
    beat: { type: String, default: '', trim: true },
    lyricsSummary: { type: String, default: '', trim: true },
    lyricsMoods: { type: String, default: '', trim: true },
    lyricsEnergy: { type: String, default: '', trim: true },
    themes: { type: String, default: '', trim: true },
    lyricsLanguage: { type: String, default: '', trim: true },
    explicit: { type: String, default: '', trim: true },
    playState: {
      type: String,
      enum: ['played', 'live', 'queued', 'requested'],
      default: 'queued',
      trim: true,
    },
    sortOrder: { type: Number, default: 0 },
    sourcePlatform: { type: String, default: 'manual', trim: true },
    sourceUrl: { type: String, default: '', trim: true },
    audioUrl: { type: String, default: '', trim: true },
    audioPublicId: { type: String, default: '', trim: true },
    audioOriginalName: { type: String, default: '', trim: true },
    requestExternalId: { type: String, default: '', trim: true },
  },
  { timestamps: true },
);

const liveRequestSchema = new mongoose.Schema(
  {
    externalId: { type: String, required: true, unique: true, trim: true },
    requesterName: { type: String, default: 'Audience', trim: true },
    message: { type: String, required: true, trim: true },
    track: { type: String, required: true, trim: true },
    artist: { type: String, default: '', trim: true },
    duration: { type: String, default: '', trim: true },
    genre: { type: String, default: '', trim: true },
    genres: { type: String, default: '', trim: true },
    subgenres: { type: String, default: '', trim: true },
    language: { type: String, default: '', trim: true },
    mood: { type: String, default: '', trim: true },
    musicMoods: { type: String, default: '', trim: true },
    instruments: { type: String, default: '', trim: true },
    bpm: { type: String, default: '', trim: true },
    musicalKey: { type: String, default: '', trim: true },
    vocals: { type: String, default: '', trim: true },
    energy: { type: String, default: '', trim: true },
    beat: { type: String, default: '', trim: true },
    lyricsSummary: { type: String, default: '', trim: true },
    lyricsMoods: { type: String, default: '', trim: true },
    lyricsEnergy: { type: String, default: '', trim: true },
    themes: { type: String, default: '', trim: true },
    lyricsLanguage: { type: String, default: '', trim: true },
    explicit: { type: String, default: '', trim: true },
    sourcePlatform: { type: String, default: 'manual', trim: true },
    sourceUrl: { type: String, default: '', trim: true },
    thumbnailUrl: { type: String, default: '', trim: true },
    audioUrl: { type: String, default: '', trim: true },
    audioPublicId: { type: String, default: '', trim: true },
    audioOriginalName: { type: String, default: '', trim: true },
    paymentStatus: {
      type: String,
      enum: ['unpaid', 'paid', 'failed', 'refunded'],
      default: 'paid',
      trim: true,
    },
    stripeCheckoutSessionId: { type: String, default: '', trim: true },
    stripePaymentIntentId: { type: String, default: '', trim: true },
    analysisSources: [{ type: String, trim: true }],
    requestStatus: {
      type: String,
      enum: ['pending_admin', 'approved', 'rejected', 'duplicate'],
      default: 'pending_admin',
      trim: true,
    },
    duplicateSessionExternalId: { type: String, default: '', trim: true },
    suggestedInsertAfterId: { type: String, default: '', trim: true },
    suggestedInsertBeforeId: { type: String, default: '', trim: true },
    suggestedInsertLabel: { type: String, default: '', trim: true },
    aiSummary: { type: String, default: '', trim: true },
    adminNote: { type: String, default: '', trim: true },
    createdSessionExternalId: { type: String, default: '', trim: true },
  },
  { timestamps: true },
);

const archiveItemSchema = new mongoose.Schema(
  {
    externalId: { type: String, required: true, unique: true, trim: true },
    title: { type: String, required: true, trim: true },
    artist: { type: String, default: '', trim: true },
    category: { type: String, required: true, trim: true },
    genre: { type: String, default: '', trim: true },
    duration: { type: String, default: '', trim: true },
    location: { type: String, default: '', trim: true },
    date: { type: String, default: '', trim: true },
    mediaType: { type: String, default: '', trim: true },
    description: { type: String, default: '', trim: true },
    image: { type: String, default: '', trim: true },
    alt: { type: String, default: '', trim: true },
    audioUrl: { type: String, default: '', trim: true },
    audioPublicId: { type: String, default: '', trim: true },
    audioOriginalName: { type: String, default: '', trim: true },
  },
  { timestamps: true },
);

const bookingSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true, trim: true },
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, default: '', trim: true },
    organization: { type: String, default: '', trim: true },
    eventType: { type: String, required: true, trim: true },
    eventDate: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    country: { type: String, required: true, trim: true },
    venueName: { type: String, default: '', trim: true },
    attendance: { type: String, default: '', trim: true },
    setDuration: { type: String, default: '', trim: true },
    musicDirection: { type: String, default: '', trim: true },
    budgetRange: { type: String, required: true, trim: true },
    notes: { type: String, default: '', trim: true },
    consent: { type: Boolean, required: true },
  },
  { timestamps: true },
);

const liveStreamConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    isLive: { type: Boolean, default: false },
    title: { type: String, default: '', trim: true },
    streamUrl: { type: String, default: '', trim: true },
    posterImage: { type: String, default: '', trim: true },
    statusLabel: { type: String, default: '', trim: true },
    activeSessionId: { type: String, default: '', trim: true },
    muxLiveStreamId: { type: String, default: '', trim: true },
    muxPlaybackId: { type: String, default: '', trim: true },
    muxStreamKey: { type: String, default: '', trim: true },
    muxRtmpUrl: { type: String, default: '', trim: true },
  },
  { timestamps: true },
);

const serviceRequestItemSchema = new mongoose.Schema(
  {
    serviceId: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, default: null, min: 0 },
  },
  { _id: false },
);

const serviceRequestSchema = new mongoose.Schema(
  {
    externalId: { type: String, required: true, unique: true, trim: true },
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User', index: true },
    customerName: { type: String, required: true, trim: true },
    customerUsername: { type: String, required: true, trim: true },
    customerEmail: { type: String, required: true, trim: true, lowercase: true },
    items: { type: [serviceRequestItemSchema], required: true },
    status: {
      type: String,
      enum: ['pending', 'quoted'],
      default: 'pending',
      trim: true,
    },
    currency: { type: String, default: 'CAD', trim: true },
    adminNote: { type: String, default: '', trim: true },
    quotedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

const User = mongoose.model('User', userSchema);
const LiveSession = mongoose.model('LiveSession', liveSessionSchema);
const LiveRequest = mongoose.model('LiveRequest', liveRequestSchema);
const ArchiveItem = mongoose.model('ArchiveItem', archiveItemSchema);
const Booking = mongoose.model('Booking', bookingSchema);
const LiveStreamConfig = mongoose.model('LiveStreamConfig', liveStreamConfigSchema);
const ServiceRequest = mongoose.model('ServiceRequest', serviceRequestSchema);

module.exports = {
  ArchiveItem,
  Booking,
  LiveRequest,
  LiveSession,
  LiveStreamConfig,
  ServiceRequest,
  User,
};
