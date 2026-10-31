const test = require('node:test'), assert = require('node:assert');
const http = require('node:http'), path = require('node:path');
const R = require('../server/rules');
const { openDb, loadLights } = require('../server/db');
const { createApp } = require('../server/app');
const { createSms, createHttpController, createSignals } = require('../server/adapters');
const { createBench } = require('../scripts/bench-controller');

const seed = path.join(__dirname, '..', 'seed');
const listen = server => new Promise(ok => server.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${server.address().port}`)));

test('SMS is sent in the format SMS Gateway expects', async t => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; });
    req.on('end', () => { seen.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.writeHead(202); res.end('{}'); });
  });
  const url = await listen(server); t.after(() => server.close());
  const sms = createSms({ SMSGATE_USERNAME: 'u', SMSGATE_PASSWORD: 'p', SMSGATE_URL: url });
  assert.deepStrictEqual(await sms.send('+213555000000', 'test'), { status: 'sent' });
  assert.strictEqual(seen[0].auth, 'Basic ' + Buffer.from('u:p').toString('base64'));
  assert.deepStrictEqual(seen[0].body, { phoneNumbers: ['+213555000000'], textMessage: { text: 'test' } });
});

test('a failed SMS is reported, not hidden', async () => {
  const sms = createSms({ SMSGATE_USERNAME: 'u', SMSGATE_PASSWORD: 'p', SMSGATE_URL: 'http://127.0.0.1:9' });
  assert.strictEqual((await sms.send('+213555000000', 'x')).status, 'failed_network');
  assert.strictEqual((await createSms({}).send('+213555000000', 'x')).status, 'not_configured');
});

test('the controller stays simulated unless configured, and refuses plain http on the internet', () => {
  assert.strictEqual(createSignals({}).live, false);
  assert.throws(() => createHttpController({ SIGNAL_URL: 'http://example.com/x', SIGNAL_SECRET: 's' }), /https/);
  assert.throws(() => createHttpController({ SIGNAL_URL: 'https://example.com/x' }), /SIGNAL_SECRET/);
});

test('commands are signed, and only equipped lights are asked', async t => {
  const bench = createBench('right');
  const url = await listen(bench.server); t.after(() => bench.server.close());
  const signals = createHttpController({ SIGNAL_URL: url, SIGNAL_SECRET: 'right', SIGNAL_LIGHT_IDS: '7' });
  assert.deepStrictEqual(await signals.request({ id: 7 }, 1), { accepted: true });
  assert.strictEqual((await signals.request({ id: 8 }, 1)).accepted, false);
  assert.strictEqual(bench.commands.length, 1);
  const forged = createHttpController({ SIGNAL_URL: url, SIGNAL_SECRET: 'wrong', SIGNAL_LIGHT_IDS: '7' });
  assert.deepStrictEqual(await forged.request({ id: 7 }, 1), { accepted: false, reason: 'refused_401' });
  assert.strictEqual(bench.commands.length, 1);
});

test('a light is shown only while its controller accepts', async () => {
  let clock = 1_800_000_000_000, accept = false;
  const calls = [];
  const db = openDb(':memory:', seed);
  const light = loadLights(seed)[0];
  const app = createApp({
    db, lights: loadLights(seed), publicUrl: () => 'https://test', now: () => clock,
    sms: { configured: false, send: async () => ({ status: 'not_configured' }) },
    routes: { route: async (a, b) => ({ coords: [[a.lon, a.lat], [b.lon, b.lat]], distanceM: R.distanceM(a, b), etaS: 300, source: 'osrm' }) },
    signals: { live: true, request: async l => { calls.push(['request', l.id]); return { accepted: accept }; }, release: async l => { calls.push(['release', l.id]); return { accepted: true }; } },
  });
  const { id } = await app.createIncident({}, 'operator');
  app.setIncidentLocation(id, { lat: light.lat + 0.003, lon: light.lon }, 'operator', 'manual');
  const unit = db.prepare('SELECT id FROM units LIMIT 1').get(), hosp = db.prepare('SELECT id FROM hospitals LIMIT 1').get();
  db.prepare('INSERT INTO unit_positions (unit_id, lat, lon, updated_at) VALUES (?, ?, ?, ?)').run(unit.id, light.lat - 0.003, light.lon, clock);
  const { missionId } = await app.dispatch(id, { unitId: unit.id, hospitalId: hosp.id }, 'operator');
  await app.crewAction(missionId, 'accept', 'crew');
  const open = () => db.prepare("SELECT status FROM priority_requests WHERE mission_id = ? AND light_id = ? AND status != 'released'").all(missionId, light.id).map(r => r.status);
  await app.tick();
  assert.deepStrictEqual(open(), [], 'refused: nothing is shown');
  accept = true;
  app.setPosition(missionId, { lat: light.lat - 0.003, lon: light.lon });
  await app.tick();
  assert.deepStrictEqual(open(), ['requested']);
  const before = calls.filter(c => c[1] === light.id).length;
  clock += R.CONFIG.yellowAndAllRedMs;
  app.setPosition(missionId, { lat: light.lat - 0.003, lon: light.lon });
  await app.tick();
  assert.deepStrictEqual(open(), ['active']);
  assert.ok(calls.filter(c => c[1] === light.id).length > before, 'the command is renewed');
  accept = false;
  await app.tick();
  assert.deepStrictEqual(open(), [], 'refused later: it stops being shown');
});

test('a faster route is only suggested, and changes only when the crew accepts', async () => {
  let eta = 600, line = [[3.06, 36.75], [3.07, 36.76]];
  const db = openDb(':memory:', seed);
  const app = createApp({
    db, lights: loadLights(seed), publicUrl: () => 'https://test', now: () => 1_800_000_000_000,
    sms: { configured: false, send: async () => ({ status: 'not_configured' }) },
    routes: { route: async () => ({ coords: line, distanceM: 5000, etaS: eta, source: 'osrm' }) },
    signals: { request: async () => ({ accepted: true }), release: async () => ({ accepted: true }) },
  });
  const { id } = await app.createIncident({}, 'operator');
  app.setIncidentLocation(id, { lat: 36.76, lon: 3.07 }, 'operator', 'manual');
  const unit = db.prepare('SELECT id FROM units LIMIT 1').get(), hosp = db.prepare('SELECT id FROM hospitals LIMIT 1').get();
  db.prepare('INSERT INTO unit_positions (unit_id, lat, lon, updated_at) VALUES (?, ?, ?, ?)').run(unit.id, 36.75, 3.06, 1_800_000_000_000);
  const { missionId } = await app.dispatch(id, { unitId: unit.id, hospitalId: hosp.id }, 'operator');
  const usual = db.prepare('SELECT route_json FROM missions WHERE id = ?').get(missionId).route_json;

  eta = 300; line = [[3.06, 36.75], [3.065, 36.7], [3.07, 36.76]];
  await app.refreshRoute(missionId, false);
  let m = db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId);
  assert.strictEqual(m.route_json, usual, 'the route did not change by itself');
  assert.ok(m.suggested_route_json, 'a faster route is offered');
  assert.strictEqual(m.route_changes, 0);

  await app.answerRoute(missionId, false, 'crew');
  m = db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId);
  assert.strictEqual(m.route_json, usual, 'dismissed: the crew keeps its route');
  assert.strictEqual(m.suggested_route_json, null);

  await app.refreshRoute(missionId, false);
  await app.answerRoute(missionId, true, 'crew');
  m = db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId);
  assert.notStrictEqual(m.route_json, usual, 'accepted: the route changes');
  assert.strictEqual(m.route_changes, 1);
  assert.throws(() => app.answerRoute(missionId, true, 'crew'), /proposé/);
});
