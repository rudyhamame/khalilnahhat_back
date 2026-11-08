// Explicit isolated recovery only. Never connects to the app's production URI.
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const readline = require('node:readline');
(async () => {
  const uri = process.env.KHALIL_RESTORE_URI, name = process.env.KHALIL_RESTORE_DB;
  if (!uri || !/^khalil_restore_[a-z0-9_]+$/.test(name || '')) throw new Error('An explicit isolated restore URI and khalil_restore_* database are required');
  await mongoose.connect(uri, { dbName: name, serverSelectionTimeoutMS: 10000 });
  const db = mongoose.connection.db;
  if ((await db.listCollections().toArray()).length) throw new Error('Restore target must be empty');
  let header = false, current, batch = [], count = 0;
  const flush = async () => { if (batch.length) { await db.collection(current).insertMany(batch, { ordered: true }); count += batch.length; batch = []; } };
  const indexes = new Map();
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const value = EJSON.parse(line, { relaxed: false });
    if (!header) { if (value.format !== 'khalil-ejson-v1') throw new Error('Unexpected backup format'); header = true; continue; }
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(value.collection || '')) throw new Error('Invalid collection name');
    if (current !== value.collection) { await flush(); current = value.collection; }
    if (value.indexes) indexes.set(current, value.indexes);
    else if (value.document) { batch.push(value.document); if (batch.length >= 100) await flush(); }
    else throw new Error('Invalid backup record');
  }
  if (!header) throw new Error('Backup is empty');
  await flush();
  for (const [collection, definitions] of indexes) {
    await db.createCollection(collection).catch(error => { if (error.code !== 48) throw error; });
    const specs = definitions.filter(item => item.name !== '_id_').map(({ v, ns, background, ...item }) => item);
    if (specs.length) await db.collection(collection).createIndexes(specs);
  }
  console.log(JSON.stringify({ database: name, restoredDocuments: count, collections: indexes.size }));
  await mongoose.disconnect();
})().catch(error => { console.error('Isolated restore failed:', error.name); process.exitCode = 1; });
