const mongoose = require('mongoose');
const {
  defaultArchiveItems,
  defaultLiveStreamConfig,
  defaultLiveSessions,
} = require('./default-data');
const { ArchiveItem, LiveSession, LiveStreamConfig } = require('./models');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'khalil';

async function seedDefaults() {
  if (defaultLiveSessions.length && (await LiveSession.countDocuments()) === 0) {
    await LiveSession.insertMany(defaultLiveSessions);
  }

  if (defaultArchiveItems.length && (await ArchiveItem.countDocuments()) === 0) {
    await ArchiveItem.insertMany(defaultArchiveItems);
  }

  if ((await LiveStreamConfig.countDocuments()) === 0) {
    await LiveStreamConfig.create(defaultLiveStreamConfig);
  }
}

async function connectToDatabase() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  await mongoose.connect(MONGODB_URI, {
    dbName: MONGODB_DB_NAME,
  });
  await seedDefaults();
  return mongoose.connection;
}

module.exports = {
  MONGODB_DB_NAME,
  MONGODB_URI,
  connectToDatabase,
};
