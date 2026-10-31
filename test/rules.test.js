const test = require('node:test'), assert = require('node:assert');
const path = require('node:path');
const R = require('../server/rules');
const { openDb, loadLights } = require('../server/db');
const { createApp } = require('../server/app');

const seed = path.join(__dirname, '..', 'seed');

function makeApp(t0 = 1_800_000_000_000) {
  let clock = t0;
  const sent = [];
  const db = openDb(':memory:', seed);
  const app = createApp({
    db, lights: loadLights(seed), publicUrl: () => 'https://test',
    sms: { configured: true, send: async (phone, text) => { sent.push({ phone, text }); return { status: 'sent' }; } },
    routes: { route: async (a, b) => ({ coords: [[a.lon, a.lat], [b.lon, b.lat]], distanceM: R.distanceM(a, b), etaS: 300, source: 'osrm' }) },
    signals: { request: async () => ({}), release: async () => ({}) },
    now: () => clock,
  });
  return { app, db, sent, advance: ms => { clock += ms; }, tokenOf: s => /\/l\/([\w-]+)/.exec(s.at(-1).text)[1] };
}

test('severity follows the points table', () => {
  assert.deepStrictEqual(R.severity({ vehicles: 1, victims: 1, conscious: true }), { score: 0, level: 'low' });
  assert.strictEqual(R.severity({ vehicles: 3, victims: 3, conscious: true }).score, 3);
  assert.strictEqual(R.severity({ trapped: true, conscious: true }).level, 'medium');
  assert.strictEqual(R.severity({ trapped: true, fire: true, conscious: true }).level, 'high');
  assert.deepStrictEqual(R.severity({ trapped: true, fire: true, conscious: false, bus: true, victims: 3, vehicles: 3 }), { score: 14, level: 'critical' });
});

test('a route changes only for an 8% gain', () => {
  assert.strictEqual(R.shouldSwitchRoute(100, 93), false);
  assert.strictEqual(R.shouldSwitchRoute(100, 92), true);
  assert.strictEqual(R.shouldSwitchRoute(0, 50), true);
  assert.strictEqual(R.shouldSwitchRoute(100, 0), false);
});

test('duplicates need to be near in place and time', () => {
  const inc = { lat: 36.75, lon: 3.06, created_at: 0 };
  assert.ok(R.isNearDuplicate({ lat: 36.7505, lon: 3.06 }, inc, 60_000));
  assert.ok(!R.isNearDuplicate({ lat: 36.76, lon: 3.06 }, inc, 60_000));
  assert.ok(!R.isNearDuplicate({ lat: 36.7505, lon: 3.06 }, inc, 11 * 60_000));
});

test('phone numbers are normalised', () => {
  assert.strictEqual(R.normalizePhone('0555 12 34 56'), '+213555123456');
  assert.strictEqual(R.normalizePhone('abc'), null);
  assert.strictEqual(R.maskPhone('+213555123456'), '*********3456');
});

test('lights ahead are found on the route, and not behind or off it', () => {
  const route = [[3.06, 36.75], [3.06, 36.76]];
  const lights = [{ id: 'ahead', lat: 36.755, lon: 3.06 }, { id: 'behind', lat: 36.7505, lon: 3.06 }, { id: 'off', lat: 36.755, lon: 3.07 }, { id: 'far', lat: 36.7599, lon: 3.06 }];
  const found = R.lightsAhead(route, { lat: 36.752, lon: 3.06 }, lights, 800).map(x => x.light.id);
  assert.deepStrictEqual(found, ['ahead']);
});

test('a caller token expires and reaches only its own incident', async () => {
  const { app, db, sent, advance, tokenOf } = makeApp();
  const a = await app.createIncident({ phone: '0555000001' }, 'operator');
  const tokenA = tokenOf(sent);
  const b = await app.createIncident({ phone: '0555000002' }, 'operator');
  const tokenB = tokenOf(sent);
  assert.notStrictEqual(tokenA, tokenB);
  assert.ok(!db.prepare('SELECT token_hash FROM caller_links').all().some(r => r.token_hash === tokenA), 'tokens are stored hashed');

  app.callerLocation(tokenA, { lat: 36.75, lon: 3.06, accuracy: 10 });
  const q = id => db.prepare('SELECT lat FROM incidents WHERE id = ?').get(id).lat;
  assert.strictEqual(q(a.id), 36.75);
  assert.strictEqual(q(b.id), null);
  assert.deepStrictEqual(Object.keys(app.callerStatus(tokenA)).sort(), ['sent', 'valid']);

  const countEvents = id => db.prepare("SELECT COUNT(*) AS c FROM events WHERE incident_id = ? AND action = 'location_set'").get(id).c;
  assert.strictEqual(countEvents(a.id), 1);
  // Jitter update from the same caller (under 20m, identical accuracy) does not add a journal event
  app.callerLocation(tokenA, { lat: 36.75005, lon: 3.06005, accuracy: 10 });
  assert.strictEqual(countEvents(a.id), 1, 'minor updates from same caller do not spam events journal');
  // Significant position change (> 20m) logs an event
  app.callerLocation(tokenA, { lat: 36.751, lon: 3.06, accuracy: 10 });
  assert.strictEqual(countEvents(a.id), 2, 'significant moves create a location_set event');

  assert.throws(() => app.callerLocation('not-a-token', { lat: 1, lon: 1 }), /expiré/);
  advance(R.CONFIG.linkTtlMs + 1);
  assert.throws(() => app.callerLocation(tokenB, { lat: 36.7, lon: 3 }), /expiré/);
});

test('the citizen app dispatches nothing until the operator confirms', () => {
  const { app, db } = makeApp();
  app.appReport({ lat: 36.75, lon: 3.06 });
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM incidents').get().n, 0);
  const r = app.operatorState().pending[0];
  const { incidentId } = app.confirmReport(r.id, 'operator');
  assert.strictEqual(db.prepare('SELECT status FROM incidents WHERE id = ?').get(incidentId).status, 'located');
  assert.strictEqual(app.operatorState().pending.length, 0);
});

test('the full mission runs, a hospital sees only its own and must re-acknowledge changes', async () => {
  const { app, advance } = makeApp();
  const { id } = await app.createIncident({ phone: '0555000003' }, 'operator');
  app.setIncidentLocation(id, { lat: 36.755, lon: 3.06 }, 'operator', 'manual');
  assert.strictEqual(app.assess(id, { vehicles: 2, victims: 1, trapped: true, conscious: true }, 'operator').level, 'medium');
  const s = await app.suggest(id);
  const { missionId } = await app.dispatch(id, { unitId: s.units[0].id, hospitalId: s.hospitals[0].id }, 'operator');

  const er = app.hospitalState(s.hospitals[0].id);
  assert.strictEqual(er.incoming.length, 1);
  assert.ok(er.incoming[0].ackPending);
  assert.ok(!JSON.stringify(er).includes('555000003'), 'no caller number on the hospital screen');
  assert.strictEqual(app.hospitalState(s.hospitals[1].id).incoming.length, 0);

  app.acknowledge(missionId, 'hospital:1');
  assert.ok(!app.hospitalState(s.hospitals[0].id).incoming[0].ackPending);

  await app.crewAction(missionId, 'accept', 'crew');
  await app.crewAction(missionId, 'arrive_scene', 'crew');
  app.updateVictims(missionId, { victims: 3 }, 'crew');
  assert.ok(app.hospitalState(s.hospitals[0].id).incoming[0].ackPending, 'a change asks for a new acknowledgement');

  advance(R.CONFIG.ackTimeoutMs + 1);
  assert.ok(app.operatorState().incidents[0].missions[0].ackLate, 'the operator sees an unanswered alert');

  await assert.rejects(app.crewAction(missionId, 'arrive_hospital', 'crew'), /ne correspond pas/);
  await app.crewAction(missionId, 'leave_scene', 'crew');
  await app.crewAction(missionId, 'arrive_hospital', 'crew');
  app.closeIncident(id, 'operator');
  const m = app.metrics().incidents[0];
  assert.strictEqual(m.status, 'closed');
  assert.ok(m.totalS != null);
});

test('light priority is requested ahead of the ambulance and released on scene', async () => {
  const { app, db, advance } = makeApp();
  const light = loadLights(seed)[0];
  const { id } = await app.createIncident({}, 'operator');
  app.setIncidentLocation(id, { lat: light.lat + 0.003, lon: light.lon }, 'operator', 'manual');
  const unit = db.prepare('SELECT id FROM units LIMIT 1').get(), hosp = db.prepare('SELECT id FROM hospitals LIMIT 1').get();
  db.prepare('INSERT INTO unit_positions (unit_id, lat, lon, updated_at) VALUES (?, ?, ?, ?)').run(unit.id, light.lat - 0.003, light.lon, 1_800_000_000_000);
  const { missionId } = await app.dispatch(id, { unitId: unit.id, hospitalId: hosp.id }, 'operator');
  await app.crewAction(missionId, 'accept', 'crew');
  const statuses = () => db.prepare("SELECT status FROM priority_requests WHERE mission_id = ? AND light_id = ?").all(missionId, light.id).map(r => r.status);
  await app.tick();
  assert.deepStrictEqual(statuses(), ['requested']);
  advance(R.CONFIG.yellowAndAllRedMs);
  app.setPosition(missionId, { lat: light.lat - 0.003, lon: light.lon });
  await app.tick();
  assert.deepStrictEqual(statuses(), ['active']);
  await app.crewAction(missionId, 'arrive_scene', 'crew');
  assert.deepStrictEqual(statuses(), ['released']);
});

test('personal data of closed incidents is removed after 30 days', async () => {
  const { app, db, advance } = makeApp();
  const { id } = await app.createIncident({ phone: '0555000004' }, 'operator');
  app.closeIncident(id, 'operator');
  advance(R.CONFIG.retentionMs + 1);
  app.purgeOld();
  assert.strictEqual(db.prepare('SELECT phone FROM incidents WHERE id = ?').get(id).phone, null);
  assert.strictEqual(db.prepare('SELECT phone_e164 FROM caller_links WHERE incident_id = ?').get(id).phone_e164, null);
});

test('a witness adds details to their own report, and they stay unverified', () => {
  const { app, advance } = makeApp();
  const { token } = app.appReport({ lat: 36.75, lon: 3.06 });
  assert.ok(token);
  app.appReportInfo(token, { victims: 3, vehicles: 2, trapped: true, fire: null, note: ' Bus renversé ' });
  app.appReportPhoto(token, 'abc.jpg');
  const r = app.operatorState().pending[0];
  assert.deepStrictEqual(r.info, { victims: 3, vehicles: 2, trapped: true, fire: null, note: 'Bus renversé' });
  assert.deepStrictEqual(r.photos, ['abc.jpg']);
  assert.strictEqual(r.edit_token_hash, undefined);
  assert.ok(app.photoAllowed('abc.jpg'));
  const { incidentId } = app.confirmReport(r.id, 'operator');
  const seen = app.operatorState().incidents.find(i => i.id === incidentId);
  assert.strictEqual(seen.assessment, null);
  assert.deepStrictEqual(seen.reports[0].photos, ['abc.jpg']);
  assert.throws(() => app.appReportInfo('wrong', {}), /introuvable/);
  assert.throws(() => app.appReportInfo(token, { victims: -1 }), /invalide/);
  assert.throws(() => app.appReportInfo(token, { note: 'x'.repeat(301) }), /trop long/);
  app.appReportPhoto(token, 'b.jpg'); app.appReportPhoto(token, 'c.jpg');
  assert.throws(() => app.appReportCanAddPhoto(token), /maximal/);
  advance(R.CONFIG.linkTtlMs + 1);
  assert.throws(() => app.appReportInfo(token, {}), /plus être complété/);
});

test('witness photos and notes are removed after 30 days, even without a phone or an accident', () => {
  const { app, db, advance } = makeApp();
  const kept = app.appReport({ lat: 36.75, lon: 3.06 });
  app.appReportPhoto(kept.token, 'kept.jpg');
  app.appReportInfo(kept.token, { note: 'à garder' });
  const r = app.operatorState().pending[0];
  app.rejectReport(r.id, 'operator');
  advance(R.CONFIG.retentionMs + 1);
  const removed = app.purgeOld();
  assert.ok(removed.includes('kept.jpg'));
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM report_photos').get().n, 0);
  assert.strictEqual(db.prepare('SELECT info_json FROM reports WHERE id = ?').get(r.id).info_json, null);
});
