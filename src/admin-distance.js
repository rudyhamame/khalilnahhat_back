// Distance from an administrator's home to a booking's venue. Places are looked up on OpenStreetMap (Nominatim, at most one request per
// second, cached); the road distance comes from OSRM and falls back to the straight-line distance when the router is unavailable.
const EARTH_KM = 6371.0088;
const rad = (degrees) => (degrees * Math.PI) / 180;
const haversineKm = (a, b) => {
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
};
const HEADERS = { 'User-Agent': 'EchoEventPlanner/1.0 (https://echo-khalil.onrender.com)', 'Accept-Language': 'en' };

function createDistance({ fetchImpl = fetch, now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const cache = new Map();
  let last = 0;
  async function geocode(address) {
    const key = String(address).toLowerCase().replace(/\s+/g, ' ').trim();
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return hit.value;
    const gap = Math.max(0, last + 1100 - now());
    if (gap) await wait(gap);
    last = now();
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.search = new URLSearchParams({ q: address, format: 'jsonv2', limit: '1' }).toString();
    const response = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('The address lookup is unavailable right now. Please try again.');
    const rows = await response.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    const latitude = Number(row?.lat), longitude = Number(row?.lon);
    const value = row && Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude, label: String(row.display_name || '').slice(0, 300) } : null;
    if (cache.size >= 200) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: now() + 24 * 60 * 60 * 1000 });
    return value;
  }
  // Place suggestions for a search box: up to five matches, each with its map point.
  async function search(query) {
    const key = 'search:' + String(query).toLowerCase().replace(/\s+/g, ' ').trim();
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return hit.value;
    const gap = Math.max(0, last + 1100 - now());
    if (gap) await wait(gap);
    last = now();
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.search = new URLSearchParams({ q: query, format: 'jsonv2', limit: '5', addressdetails: '0' }).toString();
    const response = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('The map search is unavailable right now. Please try again.');
    const rows = await response.json();
    const value = (Array.isArray(rows) ? rows : []).map((row) => ({ label: String(row.display_name || '').slice(0, 300), latitude: Number(row.lat), longitude: Number(row.lon) }))
      .filter((row) => row.label && Number.isFinite(row.latitude) && Number.isFinite(row.longitude) && Math.abs(row.latitude) <= 90 && Math.abs(row.longitude) <= 180);
    if (cache.size >= 200) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: now() + 60 * 60 * 1000 });
    return value;
  }
  async function between(from, to) {
    const straightKm = haversineKm(from, to);
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=false`;
      const response = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
      const route = response.ok ? (await response.json()).routes?.[0] : null;
      if (route && Number.isFinite(route.distance)) return { km: route.distance / 1000, minutes: Math.round(route.duration / 60), driving: true, straightKm };
    } catch { /* the straight-line distance below is the fallback */ }
    return { km: straightKm, minutes: null, driving: false, straightKm };
  }
  // The venue's point: the map pin saved with the booking, otherwise the written address.
  async function venuePoint(order, legacy = {}) {
    const venue = order?.event?.venue || {};
    const latitude = Number(venue.latitude), longitude = Number(venue.longitude);
    if (venue.latitude != null && venue.longitude != null && Number.isFinite(latitude) && Number.isFinite(longitude)) return { latitude, longitude };
    const name = venue.name || legacy.venueName, address = venue.address || legacy.venueAddress, city = venue.city || legacy.city, postal = venue.postalCode || legacy.postalCode, country = venue.country;
    for (const query of [[address, city, postal, country], [name, city, country]].map((parts) => parts.filter(Boolean).join(', ')).filter(Boolean)) {
      const found = await geocode(query);
      if (found) return found;
    }
    return null;
  }
  return { geocode, search, between, venuePoint, haversineKm };
}
module.exports = { createDistance, haversineKm };
