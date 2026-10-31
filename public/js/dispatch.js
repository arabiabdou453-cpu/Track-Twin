// Civil Protection operator's screen.
import { h, api, live, severityPill, STATUS, MISSION, PRIORITY, logo, minutes, clock, marker, baseMap, assessmentFacts, lightColor, lightLabel, lightsNote } from './common.js';

const L = window.L;
const kpisEl = document.getElementById('kpis'), freshEl = h('span', { class: 'fresh', role: 'status' });
document.getElementById('rail').append(
  h('div', { class: 'brand' }, logo(), h('a', { href: '/' }, 'Track Twin')),
  h('a', { href: '/dispatch', class: 'item on', 'aria-current': 'page' }, 'Régulation'),
  h('a', { href: '/metrics', class: 'item' }, 'Délais'),
  h('a', { href: '/twin', class: 'item' }, 'Simulation'),
  freshEl,
  h('button', { type: 'button', class: 'logout', onclick: async () => { await api('/logout', {}); location.href = '/login'; } }, 'Déconnexion'));
const priorityOf = i => PRIORITY[i.severity] || 9;
const refOf = i => `ALG-${new Date(i.created_at).toISOString().slice(0, 10).replaceAll('-', '')}-${String(i.id).padStart(4, '0')}`;
const EVENT = { incident_created: 'Accident créé', link_sent: 'Lien envoyé au témoin', location_set: 'Lieu reçu', photo_added: 'Photo reçue', app_report: "Signalement depuis l'application", app_report_rejected: 'Signalement rejeté', merged_into: 'Accidents fusionnés', assessed: 'Gravité évaluée', dispatched: 'Unité envoyée', alert_raised: 'Hôpital alerté', hospital_changed: 'Hôpital changé', hospital_ack: 'Hôpital : alerte reçue', hospital_ready: 'Hôpital : équipe prête', hospital_availability: 'Disponibilité hôpital modifiée', closed: 'Accident clôturé', cancelled: 'Accident annulé', route_changed: 'Itinéraire changé', route_suggested: 'Itinéraire plus rapide proposé à l\'équipage', route_accepted: 'Équipage : nouvel itinéraire accepté', route_dismissed: 'Équipage : itinéraire gardé', simulation_started: 'Trajet simulé lancé', ack_escalated: 'Hôpital relancé par SMS', light_refused: 'Feu : commande refusée', crew_accept: 'Équipage : mission acceptée', crew_arrive_scene: 'Équipage : sur les lieux', crew_leave_scene: "Équipage : départ vers l'hôpital", crew_arrive_hospital: "Équipage : arrivé à l'hôpital", victims_updated: 'Nombre de victimes modifié' };
const map = baseMap(L, 'map');
const layer = L.layerGroup().addTo(map);
const listEl = document.getElementById('list'), detailEl = document.getElementById('detail'), pendingEl = document.getElementById('pending'), msgEl = document.getElementById('msg');

let state = null, selected = null, pickFor = null;
const drafts = {}, suggestions = {}, links = {}, questionsOpen = {};
const say = text => { msgEl.textContent = text || ''; };
const act = fn => async (...a) => { say(''); try { return await fn(...a); } catch (e) { say(e.message); } };

// New incident
document.getElementById('newForm').addEventListener('submit', act(async e => {
  e.preventDefault();
  const phone = document.getElementById('phone').value.trim();
  const r = await api('/incidents', phone ? { phone } : {});
  selected = r.id;
  if (r.link) links[r.id] = r.link;
  document.getElementById('phone').value = '';
}));

// Placing an incident by hand, for callers without internet
map.on('click', act(async e => {
  if (!pickFor) return;
  const road = document.getElementById('road') ? document.getElementById('road').value.trim() : '';
  await api(`/incidents/${pickFor}/location`, { lat: e.latlng.lat, lon: e.latlng.lng, road_label: road || null });
  pickFor = null;
  map.getContainer().style.cursor = '';
}));

function drawMap() {
  layer.clearLayers();
  for (const u of state.units) marker(L, 'unit', u.lat, u.lon, u.name).addTo(layer);
  for (const r of state.pending) marker(L, 'report', r.lat, r.lon, `Signalement ${r.id} depuis l'application`).addTo(layer);
  for (const i of state.incidents) {
    if (i.lat != null) marker(L, 'accident', i.lat, i.lon, `Accident ${i.id}`).on('click', () => { selected = i.id; showTab('incident'); drawAll(true); }).addTo(layer);
    for (const m of i.missions) {
      if (m.route) L.polyline(m.route.map(c => [c[1], c[0]]), { color: '#14161a', weight: 5, opacity: .9 }).addTo(layer);
      marker(L, 'ambulance', m.unit.lat, m.unit.lon, m.unit.name).addTo(layer);
      if (m.hospital) marker(L, 'hospital', m.hospital.lat, m.hospital.lon, m.hospital.name).addTo(layer);
      for (const p of m.priority) L.circleMarker([p.lat, p.lon], { radius: 9, color: lightColor(p.status), weight: 3, fillOpacity: .6 }).bindTooltip(lightLabel(p)).addTo(layer);
    }
  }
}

function drawList() {
  const ordered = [...state.incidents].sort((a, b) => priorityOf(a) - priorityOf(b) || b.id - a.id);
  listEl.replaceChildren(...ordered.map(i => h('button', { type: 'button', class: `incident ${i.id === selected ? 'current' : ''}`, onclick: () => { selected = i.id; showTab('incident'); drawAll(true); } },
    h('div', { class: 'row' }, h('span', { class: `prio p${priorityOf(i)}` }, i.severity ? `P${priorityOf(i)}` : 'P?'), h('b', {}, `Accident ${i.id}`), !i.missions.length && h('span', { class: 'pill warn' }, 'Sans unité')),
    h('span', {}, i.road_label || (i.lat != null ? 'Lieu placé sur la carte' : 'Lieu pas encore connu')),
    h('span', { class: 'muted' }, STATUS[i.status], i.duplicateOf ? ` • peut-être le même que l'accident ${i.duplicateOf}` : ''))));
  if (!state.incidents.length) listEl.replaceChildren(h('p', { class: 'muted', style: 'padding:12px 14px' }, 'Aucun accident ouvert. Créez-en un quand un appel arrive au 14.'));
}

function drawPending() {
  pendingEl.replaceChildren(...state.pending.map(r => h('div', { class: 'block' },
    h('b', {}, `Signalement ${r.id} depuis l'application : à confirmer`),
    h('span', { class: 'muted' }, r.phone ? `Numéro ${r.phone}` : 'Sans numéro', r.nearIncident ? ` • près de l'accident ${r.nearIncident}` : ''),
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: act(async () => { const x = await api(`/reports/${r.id}/confirm`, {}); selected = x.incidentId; }) }, 'Confirmer comme nouvel accident'),
      r.nearIncident && h('button', { type: 'button', onclick: act(() => api(`/reports/${r.id}/confirm`, { intoId: r.nearIncident })) }, `Rattacher à ${r.nearIncident}`),
      h('button', { type: 'button', class: 'line', onclick: act(() => api(`/reports/${r.id}/reject`, {})) }, 'Rejeter')))));
}

const draftOf = i => (drafts[i.id] = drafts[i.id] || (i.assessment
  ? { vehicles: i.assessment.vehicles, victims: i.assessment.victims, bus: !!i.assessment.bus, trapped: !!i.assessment.trapped, fire: !!i.assessment.fire, conscious: !!i.assessment.conscious }
  : { vehicles: 2, victims: 1, bus: false, trapped: false, fire: false, conscious: true }));

function questionForm(i) {
  const d = draftOf(i);
  const num = (key, label) => h('label', {}, label, h('input', { type: 'number', min: 0, value: d[key], oninput: e => { d[key] = +e.target.value; } }));
  const yes = (key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d[key], onchange: e => { d[key] = e.target.checked; } }), label);
  return h('details', { class: 'block', open: i.missions.length && !questionsOpen[i.id] ? null : true, ontoggle: e => { if (i.missions.length) questionsOpen[i.id] = e.target.open; } }, h('summary', {}, 'Les six questions'),
    h('div', { class: 'q-grid' }, num('vehicles', 'Nombre de véhicules'), num('victims', 'Nombre de victimes'), yes('bus', 'Un bus est impliqué'), yes('trapped', 'Personnes coincées'), yes('fire', 'Incendie'), yes('conscious', 'Victimes conscientes')),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'go', onclick: act(async () => { await api(`/incidents/${i.id}/assess`, d); if (i.lat != null) suggestions[i.id] = await api(`/incidents/${i.id}/suggest`, {}); drawAll(true); }) }, i.assessment ? "Mettre à jour l'évaluation" : 'Calculer la gravité'),
      i.score != null && h('span', { class: 'num' }, `${i.score} points`), severityPill(i.severity)),
    h('p', { class: 'muted' }, 'Barème proposé, à valider par la Protection civile.'));
}

function dispatchBox(i) {
  const s = suggestions[i.id];
  if (!s) return h('div', { class: 'block' }, h('button', { type: 'button', disabled: i.lat == null, onclick: act(async () => { suggestions[i.id] = await api(`/incidents/${i.id}/suggest`, {}); drawAll(true); }) }, i.missions.length ? 'Proposer une unité de plus' : 'Proposer une unité et un hôpital'), i.lat == null && h('span', { class: 'muted' }, "Indiquez d'abord le lieu"));
  const pick = s.pick = s.pick || { unitId: s.units[0] && s.units[0].id, hospitalId: s.hospitals[0] && s.hospitals[0].id };
  const choice = (item, key) => h('button', { type: 'button', class: `choice ${pick[key] === item.id ? 'selected' : ''}`, 'aria-pressed': pick[key] === item.id ? 'true' : 'false', onclick: () => { pick[key] = item.id; drawAll(true); } },
    h('b', {}, item.name), h('span', { class: 'muted' }, `${item.etaMin} min • ${item.km} km • ${item.reason}`));
  return h('div', { class: 'block' },
    h('h3', {}, 'Unité'), s.units.map(u => choice(u, 'unitId')),
    h('h3', {}, 'Hôpital'), s.hospitals.map(x => choice(x, 'hospitalId')),
    h('p', { class: 'muted' }, s.etaNote, '. La décision vous revient.'),
    h('button', { type: 'button', class: 'primary', disabled: !pick.unitId || !pick.hospitalId, onclick: act(async () => { await api(`/incidents/${i.id}/dispatch`, pick); delete suggestions[i.id]; }) }, "Envoyer l'unité et alerter l'hôpital"));
}

function missionBox(i, m) {
  const hospitals = state.hospitals.filter(x => x.available);
  return h('div', { class: 'block' },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', {}, m.unit.name), h('span', { class: 'bigtime' }, minutes(m.etaLeftS))),
    h('span', { class: 'muted' }, MISSION[m.status] || m.status, m.routeSource === 'straight' ? " · estimation à vol d'oiseau" : ' · sans le trafic en direct'),
    h('div', { class: 'row' }, m.unit.ageS == null ? h('span', { class: 'pill warn' }, "Position de l'équipage pas encore reçue") : m.unit.ageS > state.staleAfterS ? h('span', { class: 'pill bad' }, `Dernière position il y a ${minutes(m.unit.ageS)} : contactez par radio`) : h('span', { class: 'pill ok' }, "Position de l'équipage en direct"), m.simulated && h('span', { class: 'pill warn' }, 'Trajet simulé')),
    h('div', { class: m.ackPending || m.ackLate ? 'warnbox' : 'pill ok' }, `${m.hospital ? m.hospital.name : ''} : ${m.ackLate ? 'pas de confirmation, appelez' : m.ackPending ? 'alerte envoyée, en attente de confirmation' : m.readyAt ? 'équipe prête' : 'alerte reçue'}`),
    m.ackPending && h('button', { type: 'button', onclick: act(() => api(`/missions/${m.id}/phone-ack`, {})) }, 'Confirmé par téléphone'),
    m.priority.length > 0 && h('span', { class: 'pill warn' }, lightsNote(m.priority)),
    h('label', { class: 'muted' }, "Changer d'hôpital", h('select', { onchange: act(e => { if (e.target.value) return api(`/missions/${m.id}/hospital`, { hospitalId: +e.target.value }); }) },
      h('option', { value: '' }, 'Choisir un autre hôpital'), hospitals.filter(x => !m.hospital || x.id !== m.hospital.id).map(x => h('option', { value: x.id }, x.name)))),
    h('div', { class: 'row' },
      !m.simulated && h('button', { type: 'button', onclick: act(() => api(`/missions/${m.id}/simulate`, {})) }, 'Simuler le trajet (démo)'),
      m.status === 'sent' && h('button', { type: 'button', onclick: act(() => api(`/missions/${m.id}/action`, { action: 'accept' })) }, "Accepter pour l'équipage"),
      m.status === 'accepted' && h('button', { type: 'button', onclick: act(() => api(`/missions/${m.id}/action`, { action: 'arrive_scene' })) }, "Arrivée sur les lieux (pour l'équipage)"),
      m.status === 'on_scene' && h('button', { type: 'button', onclick: act(() => api(`/missions/${m.id}/action`, { action: 'leave_scene' })) }, "Départ des lieux (pour l'équipage)"),
      m.status === 'to_hospital' && h('button', { type: 'button', onclick: act(() => api(`/missions/${m.id}/action`, { action: 'arrive_hospital' })) }, "Arrivée à l'hôpital (pour l'équipage)")));
}

// "Sent" only means SMS Gateway accepted the message: the phone may send it minutes later.
const smsLabel = last => (last.used_at ? 'Le témoin a ouvert le lien' : last.sms_status === 'sent' ? 'SMS transmis à la passerelle' : 'SMS non envoyé');

function linkBox(i) {
  const link = links[i.id], last = i.links[0];
  const send = act(async () => { links[i.id] = await api(`/incidents/${i.id}/link`, {}); drawAll(true); });
  return h('div', { class: 'block' },
    h('div', { class: 'row' }, h('h3', {}, 'Lien de localisation'), last && h('span', { class: `pill ${last.used_at ? 'ok' : 'warn'}` }, smsLabel(last))),
    h('button', { type: 'button', onclick: send }, last ? 'Renvoyer le lien' : 'Envoyer le lien'),
    link && !last?.used_at && h('div', { class: 'linkbox' }, h('b', {}, link.smsStatus === 'sent' ? "Si le SMS tarde : dictez le lien ou scannez le code" : 'SMS non envoyé : dictez le lien ou scannez le code'), qr(link.url), h('span', { dir: 'ltr' }, link.url)));
}

function qr(url) {
  const code = window.qrcode(0, 'M'); code.addData(url); code.make();
  const d = h('div', {}); d.innerHTML = code.createSvgTag({ cellSize: 4, margin: 2 }); return d;
}

function detail(i) {
  if (!i) return h('p', { class: 'muted', style: 'padding:14px' }, 'Choisissez un accident dans la liste.');
  return [
    h('div', { class: 'block' },
      h('span', { class: 'ref' }, refOf(i)),
      h('h1', {}, `Accident ${i.id}`, i.road_label ? ` · ${i.road_label}` : ''),
      h('div', { class: 'row' }, severityPill(i.severity), h('span', { class: 'pill' }, STATUS[i.status])),
      i.phone && h('span', { class: 'num muted' }, i.phone), i.lat != null && h('span', { class: 'muted' }, `Précision : ${i.accuracy_m ? Math.round(i.accuracy_m) + ' m' : "placé par l'agent"}`),
      i.reports.filter(r => r.photo_path).map(r => h('a', { href: `/api/photos/${r.photo_path}`, target: '_blank' }, 'Photo du témoin')),
      i.duplicateOf && h('div', { class: 'row' }, h('span', { class: 'pill warn' }, `Peut-être le même que l'accident ${i.duplicateOf}`), h('button', { type: 'button', onclick: act(async () => { await api(`/incidents/${i.id}/merge`, { intoId: i.duplicateOf }); selected = i.duplicateOf; }) }, 'Fusionner')),
      i.assessment && h('div', { class: 'facts' }, assessmentFacts(i.assessment))),
    !i.missions.length && linkBox(i),
    !i.missions.length && h('div', { class: 'block' }, h('h3', {}, 'Placer le lieu à la main'), h('input', { id: 'road', 'aria-label': 'Route ou repère', placeholder: 'Route et kilomètre, ou repère le plus proche' }),
      h('button', { type: 'button', onclick: () => { pickFor = i.id; map.getContainer().style.cursor = 'crosshair'; say("Cliquez sur le lieu de l'accident sur la carte"); } }, 'Placer sur la carte')),
    i.missions.map(m => missionBox(i, m)),
    questionForm(i),
    dispatchBox(i),
    h('div', { class: 'block' }, h('div', { class: 'row' },
      h('button', { type: 'button', class: 'line', onclick: act(async () => { await api(`/incidents/${i.id}/close`, {}); selected = null; }) }, "Clôturer l'accident"),
      h('button', { type: 'button', class: 'line', onclick: act(async () => { await api(`/incidents/${i.id}/cancel`, {}); selected = null; }) }, 'Annuler'))),
  ];
}

function showTab(tab) {
  document.getElementById('tabIncident').setAttribute('aria-pressed', tab === 'incident');
  document.getElementById('tabUnits').setAttribute('aria-pressed', tab === 'units');
  detailEl.hidden = tab !== 'incident';
  document.getElementById('units').hidden = tab !== 'units';
}
document.getElementById('tabIncident').addEventListener('click', () => showTab('incident'));
document.getElementById('tabUnits').addEventListener('click', () => showTab('units'));

function drawKpis() {
  const busy = new Set(state.incidents.flatMap(i => i.missions.map(m => m.unit.id)));
  const waiting = state.incidents.flatMap(i => i.missions).filter(m => m.ackPending).length;
  const noUnit = state.incidents.filter(i => !i.missions.length).length + state.pending.length;
  const kpi = (value, label, cls) => h('div', { class: cls || null }, h('b', {}, String(value)), ' ', h('span', {}, label));
  kpisEl.replaceChildren(
    kpi(state.incidents.length, 'accidents ouverts'),
    kpi(noUnit, 'à traiter', noUnit ? 'bad' : ''),
    kpi(state.units.length - busy.size, 'unités libres'),
    kpi(waiting, 'alertes sans réponse', waiting ? 'wait' : ''));
}

function drawUnits() {
  const missionOf = new Map(state.incidents.flatMap(i => i.missions.map(m => [m.unit.id, { m, i }])));
  const rows = [...state.units].sort((a, b) => missionOf.has(b.id) - missionOf.has(a.id) || a.name.localeCompare(b.name));
  document.getElementById('units').replaceChildren(...rows.map(u => {
    const on = missionOf.get(u.id);
    return h('div', { class: 'unit-row' }, h('span', {}, u.name), on ? h('span', { class: 'pill warn' }, `${MISSION[on.m.status]} (${on.i.id})`) : h('span', { class: 'pill ok' }, 'Disponible'));
  }));
}

function drawFeed() {
  document.getElementById('feed').replaceChildren(...state.events.map(e => h('li', {},
    h('time', {}, clock(e.at)), h('span', { class: 'who' }, e.incident_id ? `Accident ${e.incident_id}` : '—'), h('span', {}, EVENT[e.action] || e.action))));
}

// The map moves to an incident when it is chosen or first located, and is left alone otherwise.
let framed = '';
function frame() {
  const i = state.incidents.find(x => x.id === selected);
  if (!i || i.lat == null) return;
  const key = `${i.id}:${i.missions.map(m => m.status).join()}`;
  if (key === framed) return;
  framed = key;
  const pts = [[i.lat, i.lon]];
  for (const m of i.missions) { pts.push([m.unit.lat, m.unit.lon]); if (m.hospital) pts.push([m.hospital.lat, m.hospital.lon]); for (const c of m.route || []) pts.push([c[1], c[0]]); }
  if (pts.length > 1) map.fitBounds(pts, { padding: [50, 50], maxZoom: 16 }); else map.setView(pts[0], 15);
}

function drawAll(force) {
  if (!state) return;
  frame();
  drawMap(); drawList(); drawPending(); drawKpis(); drawUnits(); drawFeed();
  const typing = detailEl.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName);
  if (force || !typing) detailEl.replaceChildren(...[detail(state.incidents.find(i => i.id === selected))].flat(Infinity).filter(Boolean));
}

let updatedAt = Date.now();
setInterval(() => { freshEl.textContent = `Actualisé il y a ${Math.round((Date.now() - updatedAt) / 1000)} s`; }, 1000);

live(s => {
  state = s;
  updatedAt = Date.now();
  if (selected && !s.incidents.some(i => i.id === selected)) selected = null;
  if (!selected && s.incidents.length) selected = [...s.incidents].sort((a, b) => priorityOf(a) - priorityOf(b) || b.id - a.id)[0].id;
  document.getElementById('smsNote').hidden = s.smsConfigured;
  drawAll();
});
