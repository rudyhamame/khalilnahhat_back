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
    duration: { type: String, default: '', trim: true },
    genre: { type: String, default: '', trim: true },
    language: { type: String, default: '', trim: true },
  },
  { timestamps: true },
);

const archiveItemSchema = new mongoose.Schema(
  {
    externalId: { type: String, required: true, unique: true, trim: true },
    title: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    location: { type: String, default: '', trim: true },
    date: { type: String, default: '', trim: true },
    mediaType: { type: String, default: '', trim: true },
    image: { type: String, default: '', trim: true },
    alt: { type: String, default: '', trim: true },
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
    muxLiveStreamId: { type: String, default: '', trim: true },
    muxPlaybackId: { type: String, default: '', trim: true },
    muxStreamKey: { type: String, default: '', trim: true },
    muxRtmpUrl: { type: String, default: '', trim: true },
  },
  { timestamps: true },
);

const User = mongoose.model('User', userSchema);
const LiveSession = mongoose.model('LiveSession', liveSessionSchema);
const ArchiveItem = mongoose.model('ArchiveItem', archiveItemSchema);
const Booking = mongoose.model('Booking', bookingSchema);
const LiveStreamConfig = mongoose.model('LiveStreamConfig', liveStreamConfigSchema);

module.exports = {
  ArchiveItem,
  Booking,
  LiveSession,
  LiveStreamConfig,
  User,
};
