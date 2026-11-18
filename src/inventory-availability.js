// Pure availability: can the requested resources be provided in a time window, given other reservations?
// Times are minutes on an absolute axis (days since epoch × 1440 + minutes), so overnight events and buffers just work.
const DAY = 1440;
const dayNumber = (date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
const mins = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

// Booked window including preparation before and dismantling after. Missing/invalid times conservatively block the whole day.
function reservationWindow(event = {}, { prepMinutes = 0, dismantleMinutes = 0 } = {}) {
  const date = event.date || event.eventDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || Number.isNaN(dayNumber(date))) return null;
  const base = dayNumber(date) * DAY, s = mins(event.startTime), e = mins(event.endTime);
  if (s == null || e == null || s === e) return { start: base - prepMinutes, end: base + DAY + dismantleMinutes, wholeDay: true };
  return { start: base + s - prepMinutes, end: base + (e > s ? e : e + DAY) + dismantleMinutes, wholeDay: false };
}
const overlaps = (a, b) => a.start < b.end && b.start < a.end;

// demand: Map offeringId → quantity. reservations: [{window, demand: Map}] for OTHER bookings (the booking being checked is excluded by the caller).
// offerings need { id, name, type, isActive, stock } where stock = owned quantity, or null for "on request" (external supplier / unknown).
function checkAvailability({ demand, offerings, reservations = [], window, unavailable = new Set() }) {
  const byId = new Map(offerings.map((o) => [o.id, o]));
  const clashing = window ? reservations.filter((r) => r.window && overlaps(r.window, window)) : reservations;
  const lines = [];
  for (const [id, requested] of demand) {
    const o = byId.get(id);
    if (!o) { lines.push({ offeringId: id, name: id, requested, available: 0, status: 'unavailable', shortBy: requested }); continue; }
    if (o.type === 'package') continue; // a package's availability is its components' availability
    if (o.isActive === false || unavailable.has(id)) { lines.push({ offeringId: id, name: o.name, requested, available: 0, status: 'unavailable', shortBy: requested }); continue; }
    if (o.stock == null) { lines.push({ offeringId: id, name: o.name, requested, available: null, status: 'on_request', shortBy: 0 }); continue; }
    const used = clashing.reduce((s, r) => s + (r.demand.get(id) || 0), 0), available = Math.max(0, o.stock - used);
    lines.push({ offeringId: id, name: o.name, requested, available, status: requested <= available ? 'available' : 'short', shortBy: Math.max(0, requested - available) });
  }
  const bad = lines.filter((l) => l.status === 'short' || l.status === 'unavailable');
  return { ok: bad.length === 0, needsConfirmation: lines.some((l) => l.status === 'on_request'), lines, problems: bad.map((l) => (l.status === 'unavailable' ? `${l.name} is unavailable.` : `${l.name}: ${l.requested} requested, ${l.available} available in that window.`)) };
}

module.exports = { reservationWindow, overlaps, checkAvailability };
