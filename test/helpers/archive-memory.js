function memoryModel(seed = []) {
  const rows = seed.map(row => ({ ...row }));
  const match = (row, query) => Object.entries(query).every(([key, value]) => value?.$in ? value.$in.includes(row[key]) : row[key] === value);
  return { rows,
    find(query = {}) { const result = rows.filter(row => match(row, query)).map(row => ({ ...row })); return { then: (resolve, reject) => Promise.resolve(result).then(resolve, reject), sort: async () => result.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)) }; },
    countDocuments: async query => rows.filter(row => match(row, query)).length,
    exists: async query => rows.some(row => match(row, query)),
    findOne: async query => rows.find(row => match(row, query)) || null,
    create: async data => { rows.push({ ...data }); return data; },
    findOneAndUpdate: async (query, update) => { const row = rows.find(r => match(r, query)); if (row) Object.assign(row, update.$set); return row; },
    findOneAndDelete: async query => { const index = rows.findIndex(row => match(row, query)); return index < 0 ? null : rows.splice(index, 1)[0]; },
    bulkWrite: async operations => { for (const { updateOne } of operations) Object.assign(rows.find(row => match(row, updateOne.filter)), updateOne.update.$set); },
  };
}
module.exports = { memoryModel };
