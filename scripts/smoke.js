// Runs one full mission through the running server's real HTTP interface, including what each role must not be able to do.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert');
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const base = process.argv[2] || 'http://localhost:8080';

async function session(role, id, pin) {
  const res = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ role, id, pin }) });
  assert.strictEqual(res.status, 200, `login ${role}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return (p, body) => fetch(`${base}/api${p}`, { method: body ? 'POST' : 'GET', headers: { cookie }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, json: await r.json() }));
}
const anon = (p, body) => fetch(`${base}/api${p}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, json: await r.json() }));
const step = t => console.log('ok:', t);

(async () => {
  const op = await session('operator', 0, env.OPERATOR_PIN);
  // This run creates accidents with a placeholder number, so it must never reach a real SMS account.
  if ((await op('/state')).json.smsConfigured) { console.error('STOPPED: this server has real SMS turned on. Start it with SMSGATE_USERNAME= and SMSGATE_PASSWORD= to run this check.'); process.exit(1); }
  assert.strictEqual((await anon('/state')).status, 401); step('state needs a login');
  assert.strictEqual((await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ role: 'operator', pin: 'wrong' }) })).status, 401); step('a wrong code is refused');

  const created = (await op('/incidents', { phone: '0555123456' })).json;
  const token = created.link.url.split('/').pop();
  const seen = await anon(`/link/${token}`);
  assert.deepStrictEqual(Object.keys(seen.json).sort(), ['sent', 'valid']); step('a caller link reveals no incident data');
  assert.strictEqual((await anon(`/link/${token}/location`, { lat: 36.7540, lon: 3.0640, accuracy: 12 })).status, 200); step('the caller sends a location');
  assert.strictEqual((await anon('/link/not-a-real-token/location', { lat: 1, lon: 1 })).status, 410); step('a false token is refused');

  const level = (await op(`/incidents/${created.id}/assess`, { vehicles: 2, victims: 1, trapped: true, conscious: true })).json;
  assert.strictEqual(level.level, 'medium'); step('severity is computed');
  const sug = (await op(`/incidents/${created.id}/suggest`, {})).json;
  assert.ok(sug.units.length && sug.hospitals.length); step('a unit and a hospital are suggested');
  const unitId = sug.units[0].id, hospitalId = sug.hospitals[0].id, otherHospital = sug.hospitals[1].id;
  const missionId = (await op(`/incidents/${created.id}/dispatch`, { unitId, hospitalId })).json.missionId;

  const crew = await session('crew', unitId, env.CREW_PIN), wrongCrew = await session('crew', sug.units[1].id, env.CREW_PIN);
  const er = await session('hospital', hospitalId, env.HOSPITAL_PIN), wrongEr = await session('hospital', otherHospital, env.HOSPITAL_PIN);
  assert.strictEqual((await crew('/state')).json.mission.id, missionId); step('the crew sees the mission');
  const erState = (await er('/state')).json;
  assert.strictEqual(erState.incoming[0].incident.id, created.id);
  assert.ok(!JSON.stringify(erState).includes('555123456')); step('the hospital sees the patient and not the caller number');
  assert.strictEqual((await wrongEr('/state')).json.incoming.length, 0); step('another hospital sees nothing');
  assert.strictEqual((await wrongCrew(`/missions/${missionId}/action`, { action: 'accept' })).status, 403); step('another crew cannot act on this mission');
  assert.strictEqual((await wrongEr(`/missions/${missionId}/ack`, {})).status, 403); step('another hospital cannot acknowledge');
  assert.strictEqual((await crew(`/missions/${missionId}/hospital`, { hospitalId: otherHospital })).status, 403); step('a crew cannot change the hospital');
  assert.strictEqual((await er(`/incidents/${created.id}/close`, {})).status, 403); step('a hospital cannot close an incident');

  assert.strictEqual((await er(`/missions/${missionId}/ack`, {})).status, 200); step('the hospital acknowledges');
  assert.strictEqual((await crew(`/missions/${missionId}/action`, { action: 'accept' })).status, 200);
  assert.strictEqual((await crew(`/missions/${missionId}/position`, { lat: 36.76, lon: 3.06 })).status, 200); step('the crew accepts and sends a position');
  await crew(`/missions/${missionId}/action`, { action: 'arrive_scene' });
  await crew(`/missions/${missionId}/victims`, { victims: 3 });
  assert.ok((await er('/state')).json.incoming[0].ackPending); step('a new victim count asks the hospital again');
  await er(`/missions/${missionId}/ack`, {});
  await crew(`/missions/${missionId}/action`, { action: 'leave_scene' });
  await crew(`/missions/${missionId}/action`, { action: 'arrive_hospital' });
  await op(`/incidents/${created.id}/close`, {});
  const row = (await op('/metrics')).json.incidents.find(r => r.id === created.id);
  assert.strictEqual(row.status, 'closed');
  assert.ok(row.totalS != null); step('the incident closes and its times are measured');
  console.log('ALL PASSED');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
