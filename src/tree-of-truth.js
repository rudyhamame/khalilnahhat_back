// The Eden of Eide on the server: the buffer between the catalogue tables (services and equipments) and everything that books
// (the Booking page and the Echo AI). Both read this snapshot and never the tables directly.
//   GET /api/tree        public: live services and equipment, the steps that exist
//   GET /api/admin/tree  admin: also inactive items and the ids that were removed (they keep their id, nothing else)
const setup = require('./setup-catalog');
const { Equipment, EquipmentTombstone, publicView } = require('./equipment');
const { stepsOf, withEquipmentCategoryIds } = require('./tree-core');

async function snapshot({ admin = false } = {}) {
  const catalog = await setup.list(admin);
  const rows = await Equipment.find(admin ? {} : { isActive: true }).sort({ sortOrder: 1 });
  const equipment = withEquipmentCategoryIds(catalog, rows.map(publicView));
  const tree = { catalog, equipment, steps: stepsOf(catalog), atomEidos: await require('./eden-eidos').bookingAtomBindings() };
  if (admin) {
    const markers = await setup.removedServices();
    const tombstones = await EquipmentTombstone.find().sort({ slug: 1 }).lean();
    tree.removed = { items: markers, equipment: tombstones.map((row) => ({ id: row.slug, equipmentCategoryId: row.equipmentCategoryId || row.serviceId || '', serviceId: row.equipmentCategoryId || row.serviceId || '' })) };
  }
  return tree;
}

function registerTree(app, { requireAdmin }) {
  const wrap = (admin) => async (_req, res) => {
    try { res.set('Cache-Control', 'no-store').json(await snapshot({ admin })); }
    catch { res.status(503).json({ message: 'The booking catalogue is temporarily unavailable. Please retry.' }); }
  };
  app.get('/api/tree', wrap(false));
  app.get('/api/admin/tree', requireAdmin, wrap(true));
}

module.exports = { snapshot, registerTree };
