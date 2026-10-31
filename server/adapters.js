// Connections to the outside world. Each one can be replaced without touching the rest of the server.
const crypto = require('node:crypto');
const { distanceM, CONFIG } = require('./rules');

// SMS through SMS Gateway for Android. Without credentials, the operator's screen shows the link and a QR code.
function createSms(env) {
  const { SMSGATE_USERNAME: user, SMSGATE_PASSWORD: pass, SMSGATE_URL: url = 'https://api.sms-gate.app/3rdparty/v1/messages' } = env;
  return {
    configured: Boolean(user && pass),
    async send(phone, text) {
      if (!user || !pass) return { status: 'not_configured' };
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') },
          body: JSON.stringify({ phoneNumbers: [phone], textMessage: { text } }),
          signal: AbortSignal.timeout(10000),
        });
        return { status: res.ok ? 'sent' : `failed_${res.status}` };
      } catch (e) {
        return { status: 'failed_network' };
      }
    },
  };
}

// Routes. OSRM's public demo server allows one request per second with no guarantee, so this suits demos only.
function createRouteProvider(env) {
  const base = env.OSRM_URL || 'https://router.project-osrm.org';
  const cache = new Map();
  let chain = Promise.resolve(), last = 0;
  const throttled = fn => {
    const run = chain.then(async () => {
      const wait = 1100 - (Date.now() - last);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  };
  const straight = (from, to) => {
    const m = distanceM(from, to);
    return { coords: [[from.lon, from.lat], [to.lon, to.lat]], distanceM: m, etaS: m / 8.3, source: 'straight' };
  };
  return {
    async route(from, to) {
      const key = [from.lat, from.lon, to.lat, to.lon].map(v => v.toFixed(4)).join(',');
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < 60000) return hit.value;
      if (env.OSRM_DISABLED === '1') return straight(from, to);
      try {
        const value = await throttled(async () => {
          const res = await fetch(`${base}/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`, { signal: AbortSignal.timeout(8000) });
          const j = await res.json();
          if (!j.routes || !j.routes[0]) throw new Error('no route');
          const r = j.routes[0];
          return { coords: r.geometry.coordinates, distanceM: r.distance, etaS: r.duration, source: 'osrm' };
        });
        cache.set(key, { at: Date.now(), value });
        if (cache.size > 500) cache.delete(cache.keys().next().value);
        return value;
      } catch (e) {
        return straight(from, to);
      }
    },
  };
}

// Traffic lights. The default reaches no light at all.
function createSimulatedController() {
  return {
    name: 'simulated',
    live: false,
    async request() { return { accepted: true }; },
    async release() { return { accepted: true }; },
  };
}

// A real controller over HTTP, used only when SIGNAL_URL is set. Every command is signed and short-lived,
// and only the lights listed in SIGNAL_LIGHT_IDS are ever asked. See docs/signal-controller.md.
function createHttpController(env) {
  const url = new URL(env.SIGNAL_URL);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('SIGNAL_URL must use https');
  if (!env.SIGNAL_SECRET) throw new Error('SIGNAL_URL needs SIGNAL_SECRET');
  const equipped = new Set(String(env.SIGNAL_LIGHT_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
  const send = async (action, light, missionId) => {
    if (!light || !equipped.has(String(light.id))) return { accepted: false, reason: 'not_equipped' };
    const body = JSON.stringify({ action, lightId: light.id, missionId, ttlS: CONFIG.priorityExpiryMs / 1000, at: Date.now() });
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Signature': crypto.createHmac('sha256', env.SIGNAL_SECRET).update(body).digest('hex') },
        body, signal: AbortSignal.timeout(3000),
      });
      const reply = await res.json().catch(() => ({}));
      return res.ok && reply.accepted === true ? { accepted: true } : { accepted: false, reason: `refused_${res.status}` };
    } catch (e) {
      return { accepted: false, reason: 'unreachable' };
    }
  };
  return {
    name: 'http',
    live: true,
    request: (light, missionId) => send('request', light, missionId),
    release: (light, missionId) => send('release', light, missionId),
  };
}

const createSignals = env => (env.SIGNAL_URL ? createHttpController(env) : createSimulatedController());

module.exports = { createSms, createRouteProvider, createSimulatedController, createHttpController, createSignals };
