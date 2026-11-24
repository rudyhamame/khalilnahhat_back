// What Echo AI may know about the signed-in client's OWN booking requests: the same facts their dashboard shows
// (it reads the dashboard's serializer, so nothing is re-derived here), with nothing personal (no name, email or phone).
const LIMIT = 10;

function summarize(item) {
  const order = item.order?.event || {};
  const legacy = item.event || {};
  const journey = item.journey || {};
  return {
    id: item.id,
    requestNumber: item.requestNumber || null,
    status: item.status,
    journey: {
      label: journey.label, clientStatus:journey.clientStatus, canDiscussAvailability:journey.canDiscussAvailability, step: journey.step, clientNext: journey.clientNext, adminNext: journey.adminNext,
      awaitingClient: journey.awaitingClient, canRecordDeposit: journey.canRecordDeposit, isBooked: journey.isBooked, expires: journey.expires,
    },
    availability: item.availability ? {status:item.availability.status,reason:item.availability.reason||''} : null,
    event: {
      type: order.type ?? legacy.eventType ?? null,
      date: order.date ?? legacy.eventDate ?? null,
      startTime: order.startTime ?? legacy.startTime ?? null,
      endTime: order.endTime ?? legacy.endTime ?? null,
      guestCount: order.guestCount ?? null,
    },
    services: (item.items || []).map(line => ({ name: line.name, quantity: line.quantity })),
    // Prices only once the client may see them, exactly like the dashboard.
    quote: journey.showsPrices ? { currency: item.currency, total: item.total, deposit: item.deposit, balance: item.balance, validUntil: item.expiresAt || null } : null,
    depositPaidCents: item.depositPaidCents || 0,
    changeRequest: item.changeRequest || null,
    planningStarted: Boolean(item.planning && Object.keys(item.planning).length),
  };
}

// Owner-scoped by construction: the query can only ever ask for this one user's requests.
function createJourneyLoader({ Model, serialize }) {
  return async owner => {
    if (!owner) return [];
    const rows = await Model.find({ userId: owner }).sort({ createdAt: -1 }).limit(LIMIT);
    return rows.map(row => summarize(serialize(row, false)));
  };
}

module.exports = { createJourneyLoader, summarize };
