// Pure decision rules, kept apart from the server so they can be tested and reviewed with Civil Protection.
const crypto = require('node:crypto');

const CONFIG = {
  // Points table: to be validated with Civil Protection.
  severityPoints: { trapped: 3, fire: 3, unconscious: 3, bus: 2, manyVictims: 2, manyVehicles: 1 },
  severityLevels: [{ upTo: 2, level: 'low' }, { upTo: 4, level: 'medium' }, { upTo: 6, level: 'high' }, { upTo: Infinity, level: 'critical' }],
  linkTtlMs: 60 * 60 * 1000,
  mergeRadiusM: 200,
  mergeWindowMs: 10 * 60 * 1000,
  routeRefreshMs: 15 * 1000,
  routeMinGain: 0.08,
  corridorRangeM: 800,
  priorityExpiryMs: 120 * 1000,
  yellowAndAllRedMs: 5 * 1000,
  ackTimeoutMs: 60 * 1000,
  staleAfterMs: 30 * 1000,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
};

function severity(a) {
  const p = CONFIG.severityPoints;
  let score = 0;
  if (a.trapped) score += p.trapped;
  if (a.fire) score += p.fire;
  if (a.conscious === false) score += p.unconscious;
  if (a.bus) score += p.bus;
  if ((a.victims || 0) >= 3) score += p.manyVictims;
  if ((a.vehicles || 0) >= 3) score += p.manyVehicles;
  return { score, level: CONFIG.severityLevels.find(l => score <= l.upTo).level };
}

function distanceM(a, b) {
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(h));
}

// A new route replaces the current one only for a clear gain, so the crew is not sent around for noise.
function shouldSwitchRoute(currentEtaS, newEtaS, minGain = CONFIG.routeMinGain) {
  if (!(newEtaS > 0)) return false;
  if (!(currentEtaS > 0)) return true;
  return newEtaS <= currentEtaS * (1 - minGain);
}

function isNearDuplicate(report, incident, now = Date.now()) {
  if (incident.lat == null || report.lat == null) return false;
  return now - incident.created_at <= CONFIG.mergeWindowMs && distanceM(report, incident) <= CONFIG.mergeRadiusM;
}

function linkIsValid(link, now = Date.now()) {
  return Boolean(link) && now < link.expires_at;
}

const newToken = () => crypto.randomBytes(16).toString('base64url');
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');

function maskPhone(phone) {
  if (!phone) return '';
  return phone.length <= 4 ? '****' : '*'.repeat(phone.length - 4) + phone.slice(-4);
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/[^\d+]/g, '');
  if (/^0[5-7]\d{8}$/.test(digits)) return '+213' + digits.slice(1);
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  return null;
}

// Where a point lies along a route, in metres from its start.
function along(routeCoords, point) {
  let best = { d: Infinity, s: 0 }, s = 0;
  for (let i = 1; i < routeCoords.length; i++) {
    const a = { lat: routeCoords[i - 1][1], lon: routeCoords[i - 1][0] }, b = { lat: routeCoords[i][1], lon: routeCoords[i][0] };
    const len = distanceM(a, b);
    const kx = Math.cos(a.lat * Math.PI / 180), ax = (point.lon - a.lon) * kx, ay = point.lat - a.lat, bx = (b.lon - a.lon) * kx, by = b.lat - a.lat;
    const t = Math.max(0, Math.min(1, (ax * bx + ay * by) / ((bx * bx + by * by) || 1e-12)));
    const d = distanceM(point, { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
    if (d < best.d) best = { d, s: s + len * t };
    s += len;
  }
  return { offsetM: best.d, sM: best.s, totalM: s };
}

function lightsAhead(routeCoords, position, lights, rangeM = CONFIG.corridorRangeM, maxOffsetM = 35) {
  if (!routeCoords || routeCoords.length < 2) return [];
  const here = along(routeCoords, position).sM, out = [];
  for (const l of lights) {
    const a = along(routeCoords, l), ahead = a.sM - here;
    if (a.offsetM <= maxOffsetM && ahead > 0 && ahead <= rangeM) out.push({ light: l, aheadM: ahead });
  }
  return out.sort((x, y) => x.aheadM - y.aheadM);
}

module.exports = { CONFIG, severity, distanceM, shouldSwitchRoute, isNearDuplicate, linkIsValid, newToken, hashToken, maskPhone, normalizePhone, along, lightsAhead };
