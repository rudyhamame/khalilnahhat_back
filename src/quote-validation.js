const { z } = require('zod');
const SERVICES = new Set(['dj', 'sound', 'lighting', 'led', 'fx', 'rental', 'corporate']);
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const text = (max) => z.string().trim().max(max).default('');
const eventSchema = z.object({
  eventType: z.enum(['wedding', 'engagement', 'birthday', 'corporate', 'party', 'graduation', 'other']),
  eventDate: z.string().refine(validDate, 'Enter a valid event date.').refine((s) => s >= new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }), 'Event date cannot be in the past.'),
  startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^$/).default(''),
  endTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^$/).default(''),
  phone: z.string().trim().min(5).max(30), contactMethod: z.enum(['email', 'phone', 'whatsapp']).default('email'),
  company: text(120), venueName: text(160), venueAddress: text(240), city: text(80), postalCode: text(12),
  inGta: z.boolean().default(true), indoor: z.boolean().default(true), guests: z.coerce.number().int().min(0).max(100000).default(0),
  services: z.array(z.enum([...SERVICES])).max(7).default([]), musicStyle: z.enum(['arabic', 'english', 'mixed', 'other']).default('mixed'),
  notes: text(3000), setupRequirements: text(2000), otherMusic: text(2000), djMc: text(2000), entrance: text(2000), customMix: text(2000), announcements: text(2000),
});

// Catalog rules are authoritative; never trust localStorage names or minimum quantities.
function normalizeQuoteItems(items, catalog) {
  const seen = new Set();
  return items.map((i) => {
    if (seen.has(i.serviceId)) throw new Error('Each equipment or service can appear only once.');
    seen.add(i.serviceId);
    if (i.serviceId.startsWith('svc-')) {
      if (!SERVICES.has(i.serviceId.slice(4)) && i.serviceId !== 'svc-general') throw new Error('Unknown service.');
      return { ...i, quantity: 1, category: 'service' };
    }
    const eq = catalog.find((e) => e.slug === i.serviceId && e.isActive);
    if (!eq) throw new Error('An equipment item is no longer available. Please refresh the catalog.');
    if (!Number.isInteger(i.quantity) || i.quantity < eq.minQuantity) throw new Error(`${eq.name} requires a minimum quantity of ${eq.minQuantity}.`);
    return { serviceId: eq.slug, name: eq.name, category: eq.category, quantity: i.quantity };
  });
}
module.exports = { eventSchema, normalizeQuoteItems, validDate };
