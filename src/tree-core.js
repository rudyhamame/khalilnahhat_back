// The pure part of the server-side Eden of Eide (no database): the special ids, which booking steps exist, and how equipment links to a
// service. The booking page (lib/treeCore.js in the frontend) follows the same rules; the AI and the /api/tree snapshot use this file.
const DJ_ID = 'dj', MC_ID = 'mc';

// Which parts of the booking exist, from the service ids in the catalogue.
function stepsOf(catalog = []) {
  const services = catalog.filter((row) => row?.kind === 'service' && row.isActive !== false);
  const dj = services.find((row) => row.id === DJ_ID);
  return {
    dj: Boolean(dj),
    rental: services.some((row) => row.id !== DJ_ID && row.id !== MC_ID && !row.selectionField),
    djName: dj?.name || '', djNameAr: dj?.nameAr || '',
  };
}

// Equipment belongs to the service it points at (serviceId). Items saved before serviceId existed are matched once here.
function withServiceIds(catalog = [], equipment = []) {
  const services = catalog.filter((row) => row?.kind === 'service');
  return equipment.map((row) => (row.serviceId ? row : {
    ...row, serviceId: services.find((service) => service.category === row.category || (service.equipmentIds || []).includes(row.id))?.id || '',
  }));
}

module.exports = { DJ_ID, MC_ID, stepsOf, withServiceIds };
