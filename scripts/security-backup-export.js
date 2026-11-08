// Read-only, typed streaming export. Run only through the private backup service.
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const { once } = require('node:events');
async function write(value) {
  if (!process.stdout.write(EJSON.stringify(value, { relaxed: false }) + '\n')) await once(process.stdout, 'drain');
}
(async () => {
  if (!process.env.MONGODB_URI?.startsWith('mongodb+srv://') || process.env.MONGODB_DB_NAME !== 'khalil') throw new Error('Unexpected production database target');
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB_NAME, serverSelectionTimeoutMS: 10000 });
  const db = mongoose.connection.db;
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  await write({ format: 'khalil-ejson-v1', database: db.databaseName, createdAt: new Date() });
  for (const item of collections) {
    if (item.name.startsWith('system.')) continue;
    const collection = db.collection(item.name);
    await write({ collection: item.name, indexes: await collection.indexes() });
    for await (const document of collection.find({}).batchSize(100)) await write({ collection: item.name, document });
  }
  await mongoose.disconnect();
})().catch(() => { console.error('Private database export failed.'); process.exitCode = 1; });
