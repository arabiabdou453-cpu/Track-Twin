// HTTP layer: pages, sessions, permissions and live updates. The behaviour itself lives in app.js.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { openDb, loadLights } = require('./db');
const { createApp } = require('./app');
const { createSms, createRouteProvider, createSignals } = require('./adapters');
const { CONFIG } = require('./rules');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public'), DATA = path.join(ROOT, 'data'), PHOTOS = path.join(DATA, 'photos');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const PAGES = { '/': 'index.html', '/login': 'login.html', '/dispatch': 'dispatch.html', '/metrics': 'metrics.html', '/app': 'app.html', '/twin': 'twin.html' };

// Settings come from .env. On the first run, private values are generated there and never leave this computer.
function loadEnv() {
  const file = path.join(ROOT, '.env'), env = { ...process.env };
  const generated = { SESSION_SECRET: crypto.randomBytes(32).toString('hex'), OPERATOR_PIN: pin(), CREW_PIN: pin(), HOSPITAL_PIN: pin() };
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, Object.entries(generated).map(([k, v]) => `${k}=${v}`).join('\n') + '\nPUBLIC_URL=\nSMSGATE_USERNAME=\nSMSGATE_PASSWORD=\nPORT=8080\n');
    console.log('Created .env with new private values. Open it to read the login codes.');
  }
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && env[m[1]] === undefined) env[m[1]] = m[2];
  }
  return env;
}
function pin() { return String(crypto.randomInt(100000, 999999)); }

function startServer(env = loadEnv()) {
  fs.mkdirSync(PHOTOS, { recursive: true });
  const seedDir = path.join(ROOT, 'seed');
  const db = openDb(env.DB_FILE || path.join(DATA, 'green-corridor.db'), seedDir);
  const clients = new Set();
  let pending = false, origin = `http://localhost:${env.PORT || 8080}`;
  const notify = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; for (const c of clients) c.write('data: changed\n\n'); }, 150);
  };
  const app = createApp({ db, lights: loadLights(seedDir), sms: createSms(env), routes: createRouteProvider(env), signals: createSignals(env), publicUrl: () => env.PUBLIC_URL || origin, notify });

  // ---- sessions: a signed cookie saying who is logged in
  const sign = v => crypto.createHmac('sha256', env.SESSION_SECRET).update(v).digest('base64url');
  const makeCookie = s => { const v = Buffer.from(JSON.stringify({ ...s, exp: Date.now() + 12 * 3600 * 1000 })).toString('base64url'); return `${v}.${sign(v)}`; };
  function readSession(req) {
    const m = /(?:^|;\s*)gc_session=([^;]+)/.exec(req.headers.cookie || '');
    if (!m) return null;
    const [v, sig] = m[1].split('.');
    if (!v || !sig) return null;
    const a = Buffer.from(sign(v)), b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const s = JSON.parse(Buffer.from(v, 'base64url').toString());
    return s.exp > Date.now() ? s : null;
  }
  const pinMatches = (given, expected) => {
    const a = crypto.createHash('sha256').update(String(given)).digest(), b = crypto.createHash('sha256').update(String(expected)).digest();
    return Boolean(expected) && crypto.timingSafeEqual(a, b);
  };

  // ---- rate limits for public endpoints and login
  const hits = new Map();
  function limited(key, max, windowMs) {
    const t = Date.now(), list = (hits.get(key) || []).filter(x => t - x < windowMs);
    list.push(t); hits.set(key, list);
    return list.length > max;
  }
  setInterval(() => { for (const [k, v] of hits) if (!v.some(x => Date.now() - x < 600000)) hits.delete(k); }, 300000).unref();

  const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
  const readBody = (req, max) => new Promise((resolve, reject) => {
    const parts = []; let size = 0;
    req.on('data', d => { size += d.length; if (size > max) { reject(new app.ApiError(413, 'Fichier trop volumineux')); req.destroy(); } else parts.push(d); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
  const readJson = async req => { const b = await readBody(req, 64 * 1024); try { return b.length ? JSON.parse(b.toString()) : {}; } catch (e) { throw new app.ApiError(400, 'Requête invalide'); } };

  function serveFile(res, file, cacheable) {
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Introuvable'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cacheable ? 'public, max-age=3600' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(data);
    });
  }

  const need = (s, ...roles) => { if (!s) throw new app.ApiError(401, "Connectez-vous d'abord"); if (!roles.includes(s.role)) throw new app.ApiError(403, 'Action non autorisée pour votre rôle'); };
  const actorOf = s => (s.role === 'operator' ? 'operator' : s.role === 'crew' ? `crew:${s.id}` : `hospital:${s.id}`);
  const crewOwns = (s, missionId) => { if (s.role === 'crew' && !app.missionOwnedByUnit(missionId, s.id)) throw new app.ApiError(403, "Cette mission n'est pas celle de votre unité"); };

  async function api(req, res, url, s) {
    const p = url.pathname, m = req.method;
    const ip = req.socket.remoteAddress;
    let a;
    if (p === '/api/login' && m === 'POST') {
      if (limited(`login:${ip}`, 10, 60000)) throw new app.ApiError(429, 'Trop de tentatives, attendez une minute');
      const b = await readJson(req);
      const expected = { operator: env.OPERATOR_PIN, crew: env.CREW_PIN, hospital: env.HOSPITAL_PIN }[b.role];
      if (!pinMatches(b.pin, expected)) throw new app.ApiError(401, 'Code incorrect');
      const session = { role: b.role, id: b.role === 'operator' ? 0 : Number(b.id) };
      if (b.role !== 'operator' && !session.id) throw new app.ApiError(400, "Choisissez l'unité ou l'hôpital");
      const secure = (env.PUBLIC_URL || '').startsWith('https') ? '; Secure' : '';
      return json(res, 200, { role: session.role, id: session.id }, { 'Set-Cookie': `gc_session=${makeCookie(session)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}` });
    }
    if (p === '/api/logout' && m === 'POST') return json(res, 200, { ok: true }, { 'Set-Cookie': 'gc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    if (p === '/api/login-options' && m === 'GET') return json(res, 200, app.loginOptions());
    if (p === '/api/me' && m === 'GET') return json(res, 200, s ? { role: s.role, id: s.id } : { role: null });
    if (p === '/api/lights' && m === 'GET') { need(s, 'operator', 'crew'); return json(res, 200, app.lightsForMap()); }

    // ---- public: only through a one-time token, and no incident data ever comes back
    if ((a = /^\/api\/link\/([\w-]+)$/.exec(p)) && m === 'GET') return json(res, 200, app.callerStatus(a[1]));
    if ((a = /^\/api\/link\/([\w-]+)\/location$/.exec(p)) && m === 'POST') {
      if (limited(`link:${a[1]}`, 60, 60000)) throw new app.ApiError(429, 'Trop de requêtes');
      return json(res, 200, app.callerLocation(a[1], await readJson(req)));
    }
    if ((a = /^\/api\/link\/([\w-]+)\/photo$/.exec(p)) && m === 'POST') {
      if (limited(`photo:${a[1]}`, 5, 600000)) throw new app.ApiError(429, 'Trop de requêtes');
      if (!app.callerStatus(a[1]).valid) throw new app.ApiError(410, 'Ce lien a expiré');
      const body = await readBody(req, 5 * 1024 * 1024);
      const png = body[0] === 0x89 && body[1] === 0x50, jpg = body[0] === 0xff && body[1] === 0xd8;
      if (!png && !jpg) throw new app.ApiError(415, 'Envoyez une image JPG ou PNG');
      const name = crypto.randomBytes(12).toString('hex') + (png ? '.png' : '.jpg');
      fs.writeFileSync(path.join(PHOTOS, name), body);
      return json(res, 200, app.callerPhoto(a[1], name));
    }
    if (p === '/api/app/report' && m === 'POST') {
      if (limited(`app:${ip}`, 5, 600000)) throw new app.ApiError(429, 'Trop de signalements. Appelez le 14');
      return json(res, 200, app.appReport(await readJson(req)));
    }

    // ---- logged in
    if (p === '/api/stream' && m === 'GET') {
      if (!s) throw new app.ApiError(401, "Connectez-vous d'abord");
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('data: changed\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/state' && m === 'GET') {
      if (!s) throw new app.ApiError(401, "Connectez-vous d'abord");
      return json(res, 200, s.role === 'operator' ? app.operatorState() : s.role === 'crew' ? app.crewState(s.id) : app.hospitalState(s.id));
    }
    if (p === '/api/metrics' && m === 'GET') { need(s, 'operator'); return json(res, 200, app.metrics()); }
    if ((a = /^\/api\/photos\/([a-f0-9]+\.(?:jpg|png))$/.exec(p)) && m === 'GET') {
      need(s, 'operator');
      if (!app.photoAllowed(a[1])) throw new app.ApiError(404, 'Introuvable');
      return serveFile(res, path.join(PHOTOS, a[1]));
    }
    if (m !== 'POST') throw new app.ApiError(404, 'Introuvable');
    const b = await readJson(req);

    if (p === '/api/incidents') { need(s, 'operator'); origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`; return json(res, 200, await app.createIncident(b, actorOf(s))); }
    if ((a = /^\/api\/incidents\/(\d+)\/(\w+)$/.exec(p))) {
      need(s, 'operator');
      const id = +a[1], actor = actorOf(s);
      origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
      switch (a[2]) {
        case 'link': { const i = app.q('SELECT phone FROM incidents WHERE id = ?').get(id); return json(res, 200, await app.sendLink(id, i && i.phone, actor)); }
        case 'location': return json(res, 200, (app.setIncidentLocation(id, { lat: Number(b.lat), lon: Number(b.lon), road_label: b.road_label ? String(b.road_label).slice(0, 200) : null }, actor, 'manual'), { ok: true }));
        case 'assess': return json(res, 200, app.assess(id, b, actor));
        case 'suggest': return json(res, 200, await app.suggest(id));
        case 'dispatch': return json(res, 200, await app.dispatch(id, b, actor));
        case 'merge': return json(res, 200, app.mergeIncident(id, b.intoId, actor));
        case 'close': return json(res, 200, app.closeIncident(id, actor, false));
        case 'cancel': return json(res, 200, app.closeIncident(id, actor, true));
      }
    }
    if ((a = /^\/api\/reports\/(\d+)\/(confirm|reject)$/.exec(p))) {
      need(s, 'operator');
      return json(res, 200, a[2] === 'confirm' ? app.confirmReport(+a[1], actorOf(s), b.intoId) : app.rejectReport(+a[1], actorOf(s)));
    }
    if ((a = /^\/api\/missions\/(\d+)\/(\w+)$/.exec(p))) {
      const id = +a[1];
      switch (a[2]) {
        // Only the operator changes where a mission goes.
        case 'hospital': need(s, 'operator'); return json(res, 200, app.changeHospital(id, b.hospitalId, actorOf(s)));
        case 'simulate': need(s, 'operator'); return json(res, 200, app.simulateDrive(id, actorOf(s)));
        case 'phone-ack': need(s, 'operator'); return json(res, 200, app.acknowledge(id, 'operator_by_phone'));
        case 'action': need(s, 'crew', 'operator'); crewOwns(s, id); return json(res, 200, await app.crewAction(id, b.action, actorOf(s)));
        case 'position': need(s, 'crew'); crewOwns(s, id); return json(res, 200, app.setPosition(id, b));
        case 'route': need(s, 'crew'); crewOwns(s, id); return json(res, 200, app.answerRoute(id, b.accept === true, actorOf(s)));
        case 'victims': need(s, 'crew'); crewOwns(s, id); return json(res, 200, app.updateVictims(id, b, actorOf(s)));
        case 'ack': case 'ready':
          need(s, 'hospital');
          if (!app.missionGoesTo(id, s.id)) throw new app.ApiError(403, "Cette mission n'est pas pour votre hôpital");
          return json(res, 200, a[2] === 'ack' ? app.acknowledge(id, actorOf(s)) : app.markReady(id, actorOf(s)));
      }
    }
    if (p === '/api/hospital/status') { need(s, 'hospital'); return json(res, 200, app.setHospitalAvailability(s.id, Boolean(b.available), actorOf(s))); }
    throw new app.ApiError(404, 'Introuvable');
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const s = readSession(req);
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url, s);
      if (/^\/l\/[\w-]+$/.test(url.pathname)) return serveFile(res, path.join(PUBLIC, 'link.html'));
      if (/^\/unit(\/\d+)?$/.test(url.pathname)) return serveFile(res, path.join(PUBLIC, 'unit.html'));
      if (/^\/er(\/\d+)?$/.test(url.pathname)) return serveFile(res, path.join(PUBLIC, 'er.html'));
      if (PAGES[url.pathname]) return serveFile(res, path.join(PUBLIC, PAGES[url.pathname]));
      const file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
      if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
      return serveFile(res, file, url.pathname.startsWith('/vendor/'));
    } catch (e) {
      if (e instanceof app.ApiError) return json(res, e.status, { error: e.message });
      console.error(e);
      return json(res, 500, { error: 'Erreur du serveur' });
    }
  });

  const timers = [
    setInterval(() => app.tick().catch(e => console.error('tick', e)), 3000),
    setInterval(() => { try { const removed = app.purgeOld(); for (const f of removed) fs.rmSync(path.join(PHOTOS, path.basename(f)), { force: true }); } catch (e) { console.error(e); } }, 3600000),
    setInterval(() => { try { app.advanceSimulated(1, +(env.DEMO_SPEED_MS || 30)); } catch (e) { console.error('simulate', e); } }, 1000),
  ];
  timers.forEach(t => t.unref());
  return new Promise(resolve => {
    server.listen(+(env.PORT || 8080), () => {
      console.log(`Track Twin is running on http://localhost:${server.address().port}`);
      resolve({ server, app, db, close: () => { timers.forEach(clearInterval); for (const c of clients) c.end(); server.close(); db.close(); } });
    });
  });
}

if (require.main === module) startServer();
module.exports = { startServer, CONFIG };
