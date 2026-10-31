// All the platform's behaviour. The HTTP layer in index.js only checks who is calling and passes requests here.
const R = require('./rules');
const { CONFIG } = R;

class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new ApiError(status, message); };

function createApp({ db, lights, sms, routes, signals, publicUrl, now = () => Date.now(), notify = () => {} }) {
  const q = sql => db.prepare(sql);
  const lightById = new Map(lights.map(l => [l.id, l]));

  const log = (incidentId, actor, action, detail) => q('INSERT INTO events (incident_id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)').run(incidentId, now(), actor, action, detail == null ? null : String(detail));
  const incident = id => q('SELECT * FROM incidents WHERE id = ?').get(id) || fail(404, 'Accident introuvable');
  const mission = id => q('SELECT * FROM missions WHERE id = ?').get(id) || fail(404, 'Mission introuvable');
  const unit = id => q('SELECT * FROM units WHERE id = ?').get(id) || fail(400, 'Unité introuvable');
  const hospital = id => q('SELECT * FROM hospitals WHERE id = ?').get(id) || fail(400, 'Hôpital introuvable');
  const assessment = id => q('SELECT * FROM assessments WHERE incident_id = ?').get(id) || null;
  const number = (v, label) => { const n = Number(v); if (!Number.isFinite(n)) fail(400, `Valeur invalide: ${label}`); return n; };
  const coords = b => {
    const lat = number(b.lat, 'latitude'), lon = number(b.lon, 'longitude');
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) fail(400, 'Coordonnées invalides');
    return { lat, lon };
  };
  const unitPosition = u => q('SELECT lat, lon, updated_at FROM unit_positions WHERE unit_id = ?').get(u.id) || { lat: u.lat, lon: u.lon, updated_at: null };

  const setStatus = (id, status, stampColumn) => {
    q(`UPDATE incidents SET status = ?${stampColumn ? `, ${stampColumn} = COALESCE(${stampColumn}, ?)` : ''} WHERE id = ?`).run(...(stampColumn ? [status, now(), id] : [status, id]));
  };

  // ---- reporting
  function createLink(incidentId, phone) {
    const token = R.newToken();
    q('INSERT INTO caller_links (token_hash, incident_id, phone_e164, expires_at) VALUES (?, ?, ?, ?)').run(R.hashToken(token), incidentId, phone, now() + CONFIG.linkTtlMs);
    return token;
  }

  async function sendLink(incidentId, phone, actor) {
    const token = createLink(incidentId, phone), url = `${publicUrl()}/l/${token}`;
    const text = `Track Twin (نسخة عرض): افتح هذا الرابط لإرسال موقعك إلى العون. ${url}`;
    const result = phone ? await sms.send(phone, text) : { status: 'no_phone' };
    q('UPDATE caller_links SET sms_status = ? WHERE token_hash = ?').run(result.status, R.hashToken(token));
    log(incidentId, actor, 'link_sent', result.status);
    notify();
    return { url, smsStatus: result.status };
  }

  async function createIncident(body, actor) {
    const phone = body.phone ? R.normalizePhone(body.phone) : null;
    if (body.phone && !phone) fail(400, 'Numéro de téléphone invalide');
    const { lastInsertRowid } = q('INSERT INTO incidents (phone, road_label, created_by, created_at) VALUES (?, ?, ?, ?)').run(phone, body.road_label ? String(body.road_label).slice(0, 200) : null, actor, now());
    const id = Number(lastInsertRowid);
    log(id, actor, 'incident_created');
    const link = phone ? await sendLink(id, phone, actor) : null;
    notify();
    return { id, link };
  }

  function linkFor(token) {
    return q('SELECT * FROM caller_links WHERE token_hash = ?').get(R.hashToken(String(token)));
  }

  function setIncidentLocation(id, loc, actor, source) {
    const i = incident(id);
    const isFirst = i.lat == null;
    let shouldLog = isFirst;
    if (!isFirst) {
      if (actor !== 'caller') {
        shouldLog = true;
      } else {
        const dist = R.distanceM(i, loc);
        const accDiff = (i.accuracy_m ?? Infinity) - (loc.accuracy ?? Infinity);
        if (dist > 20 || accDiff >= 15) {
          shouldLog = true;
        }
      }
    }
    q('UPDATE incidents SET lat = ?, lon = ?, accuracy_m = ?, located_at = COALESCE(located_at, ?), road_label = COALESCE(?, road_label) WHERE id = ?').run(loc.lat, loc.lon, loc.accuracy ?? null, now(), loc.road_label || null, id);
    if (i.status === 'new') q("UPDATE incidents SET status = 'located' WHERE id = ?").run(id);
    if (shouldLog) log(id, actor, 'location_set', source);
    notify();
  }

  function callerStatus(token) {
    const link = linkFor(token);
    return { valid: R.linkIsValid(link, now()), sent: Boolean(link && link.used_at) };
  }

  function callerLocation(token, body) {
    const link = linkFor(token);
    if (!R.linkIsValid(link, now())) fail(410, 'Ce lien a expiré');
    const loc = coords(body), accuracy = body.accuracy == null ? null : number(body.accuracy, 'précision');
    q('UPDATE caller_links SET used_at = COALESCE(used_at, ?) WHERE id = ?').run(now(), link.id);
    const existing = q("SELECT id FROM reports WHERE incident_id = ? AND channel = 'link' AND phone IS ?").get(link.incident_id, link.phone_e164);
    if (existing) q('UPDATE reports SET lat = ?, lon = ?, accuracy_m = ? WHERE id = ?').run(loc.lat, loc.lon, accuracy, existing.id);
    else q("INSERT INTO reports (incident_id, channel, lat, lon, accuracy_m, phone, confirmed, created_at) VALUES (?, 'link', ?, ?, ?, ?, 1, ?)").run(link.incident_id, loc.lat, loc.lon, accuracy, link.phone_e164, now());
    setIncidentLocation(link.incident_id, { ...loc, accuracy }, 'caller', 'link');
    return { ok: true };
  }

  function callerPhoto(token, relativePath) {
    const link = linkFor(token);
    if (!R.linkIsValid(link, now())) fail(410, 'Ce lien a expiré');
    const report = q("SELECT id FROM reports WHERE incident_id = ? AND channel = 'link' AND phone IS ?").get(link.incident_id, link.phone_e164);
    if (report) q('UPDATE reports SET photo_path = ? WHERE id = ?').run(relativePath, report.id);
    else q("INSERT INTO reports (incident_id, channel, photo_path, phone, confirmed, created_at) VALUES (?, 'link', ?, ?, 1, ?)").run(link.incident_id, relativePath, link.phone_e164, now());
    log(link.incident_id, 'caller', 'photo_added');
    notify();
    return { ok: true };
  }

  // The citizen app never dispatches anything: its report waits for the operator.
  function appReport(body) {
    const loc = coords(body), phone = body.phone ? R.normalizePhone(body.phone) : null;
    const { lastInsertRowid } = q("INSERT INTO reports (channel, lat, lon, accuracy_m, phone, created_at) VALUES ('app', ?, ?, ?, ?, ?)").run(loc.lat, loc.lon, body.accuracy == null ? null : number(body.accuracy, 'précision'), phone, now());
    log(null, 'citizen', 'app_report', Number(lastInsertRowid));
    notify();
    return { ok: true };
  }

  function confirmReport(reportId, actor, intoIncidentId) {
    const r = q('SELECT * FROM reports WHERE id = ?').get(reportId) || fail(404, 'Signalement introuvable');
    let incidentId = intoIncidentId ? incident(intoIncidentId).id : null;
    if (!incidentId) {
      const { lastInsertRowid } = q('INSERT INTO incidents (phone, created_by, created_at) VALUES (?, ?, ?)').run(r.phone, actor, now());
      incidentId = Number(lastInsertRowid);
      log(incidentId, actor, 'incident_created', 'from_app_report');
      setIncidentLocation(incidentId, { lat: r.lat, lon: r.lon, accuracy: r.accuracy_m }, actor, 'app');
    }
    q('UPDATE reports SET incident_id = ?, confirmed = 1 WHERE id = ?').run(incidentId, reportId);
    notify();
    return { incidentId };
  }

  function rejectReport(reportId, actor) {
    q('UPDATE reports SET rejected = 1 WHERE id = ?').run(reportId);
    log(null, actor, 'app_report_rejected', reportId);
    notify();
    return { ok: true };
  }

  // Two open incidents that are one accident: the operator keeps one, and the other's reports move to it.
  function mergeIncident(id, intoId, actor) {
    if (Number(id) === Number(intoId)) fail(400, 'Impossible de fusionner un accident avec lui-même');
    incident(id); incident(intoId);
    if (q('SELECT 1 FROM missions WHERE incident_id = ?').get(id)) fail(409, 'Cet accident a une mission, fusion impossible');
    q('UPDATE reports SET incident_id = ? WHERE incident_id = ?').run(intoId, id);
    q('UPDATE caller_links SET incident_id = ? WHERE incident_id = ?').run(intoId, id);
    setStatus(id, 'cancelled', 'cancelled_at');
    log(id, actor, 'merged_into', intoId);
    notify();
    return { ok: true };
  }

  // ---- assessment and suggestions
  function assess(id, b, actor) {
    const i = incident(id);
    const a = { vehicles: Math.max(0, Math.round(number(b.vehicles, 'véhicules'))), bus: Boolean(b.bus), victims: Math.max(0, Math.round(number(b.victims, 'victimes'))), trapped: Boolean(b.trapped), fire: Boolean(b.fire), conscious: b.conscious !== false };
    const s = R.severity(a);
    q(`INSERT INTO assessments (incident_id, vehicles, bus, victims, trapped, fire, conscious, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(incident_id) DO UPDATE SET vehicles = excluded.vehicles, bus = excluded.bus, victims = excluded.victims, trapped = excluded.trapped, fire = excluded.fire, conscious = excluded.conscious, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(id, a.vehicles, a.bus ? 1 : 0, a.victims, a.trapped ? 1 : 0, a.fire ? 1 : 0, a.conscious ? 1 : 0, actor, now());
    q('UPDATE incidents SET score = ?, severity = ?, assessed_at = COALESCE(assessed_at, ?) WHERE id = ?').run(s.score, s.level, now(), id);
    if (['new', 'located'].includes(i.status)) q("UPDATE incidents SET status = 'assessed' WHERE id = ?").run(id);
    log(id, actor, 'assessed', JSON.stringify(s));
    raiseAlert(id, actor);
    notify();
    return s;
  }

  async function nearest(list, from, take = 3) {
    const byAir = list.map(x => ({ x, air: R.distanceM(from, x) })).sort((a, b) => a.air - b.air).slice(0, take);
    const out = [];
    for (const c of byAir) {
      const r = await routes.route(from.routeFrom === 'item' ? c.x : from, from.routeFrom === 'item' ? from : c.x);
      out.push({ ...c, etaS: r.etaS, km: r.distanceM / 1000, source: r.source });
    }
    return out.sort((a, b) => a.etaS - b.etaS);
  }

  async function suggest(id) {
    const i = incident(id);
    if (i.lat == null) fail(409, "Indiquez d'abord le lieu de l'accident");
    const busy = new Set(q("SELECT unit_id FROM missions WHERE status NOT IN ('done', 'cancelled')").all().map(m => m.unit_id));
    const free = q('SELECT * FROM units WHERE available = 1').all().filter(u => !busy.has(u.id)).map(u => ({ ...u, ...coordsOf(unitPosition(u), u) }));
    const units = await nearest(free, { lat: i.lat, lon: i.lon, routeFrom: 'item' });
    const hospitals = await nearest(q('SELECT * FROM hospitals WHERE available = 1').all(), { lat: i.lat, lon: i.lon });
    const pack = c => ({ id: c.x.id, name: c.x.name, etaMin: Math.round(c.etaS / 6) / 10, km: Math.round(c.km * 10) / 10, reason: c.source === 'osrm' ? 'Le plus proche en temps par la route' : "Le plus proche à vol d'oiseau, itinéraire indisponible" });
    return { units: units.map(pack), hospitals: hospitals.map(pack), etaNote: 'Durée sans le trafic en direct' };
  }
  const coordsOf = (p, u) => ({ lat: p.lat ?? u.lat, lon: p.lon ?? u.lon });

  // ---- dispatch and the shared record
  async function dispatch(id, b, actor) {
    const i = incident(id);
    if (i.lat == null) fail(409, "Indiquez d'abord le lieu de l'accident");
    const u = unit(b.unitId), h = hospital(b.hospitalId);
    if (q("SELECT 1 FROM missions WHERE unit_id = ? AND status NOT IN ('done', 'cancelled')").get(u.id)) fail(409, 'Cette unité est sur une autre mission');
    const { lastInsertRowid } = q('INSERT INTO missions (incident_id, unit_id, hospital_id, alert_at, created_at) VALUES (?, ?, ?, ?, ?)').run(id, u.id, h.id, now(), now());
    const missionId = Number(lastInsertRowid);
    q('UPDATE incidents SET dispatched_at = COALESCE(dispatched_at, ?) WHERE id = ?').run(now(), id);
    if (['new', 'located', 'assessed'].includes(i.status)) q("UPDATE incidents SET status = 'dispatched' WHERE id = ?").run(id);
    log(id, actor, 'dispatched', `unit ${u.id} hospital ${h.id}`);
    await refreshRoute(missionId, true);
    notify();
    return { missionId };
  }

  // An important change asks the hospital to acknowledge again.
  function raiseAlert(incidentId, actor) {
    q("UPDATE missions SET alert_version = alert_version + 1, alert_at = ? WHERE incident_id = ? AND status NOT IN ('done', 'cancelled')").run(now(), incidentId);
    log(incidentId, actor, 'alert_raised');
  }

  function changeHospital(missionId, hospitalId, actor) {
    const m = mission(missionId), h = hospital(hospitalId);
    q('UPDATE missions SET hospital_id = ?, alert_version = alert_version + 1, alert_at = ?, ack_version = 0, ack_at = NULL, ready_at = NULL, route_checked_at = NULL WHERE id = ?').run(h.id, now(), m.id);
    log(m.incident_id, actor, 'hospital_changed', h.id);
    notify();
    return { ok: true };
  }

  function acknowledge(missionId, by) {
    const m = mission(missionId);
    q('UPDATE missions SET ack_version = alert_version, ack_at = ?, ack_by = ? WHERE id = ?').run(now(), by, m.id);
    log(m.incident_id, by, 'hospital_ack', m.alert_version);
    notify();
    return { ok: true };
  }

  function markReady(missionId, by) {
    const m = mission(missionId);
    q('UPDATE missions SET ready_at = ? WHERE id = ?').run(now(), m.id);
    log(m.incident_id, by, 'hospital_ready');
    notify();
    return { ok: true };
  }

  function setHospitalAvailability(hospitalId, available, actor) {
    q('UPDATE hospitals SET available = ?, updated_at = ? WHERE id = ?').run(available ? 1 : 0, now(), hospitalId);
    log(null, actor, 'hospital_availability', `${hospitalId}:${available}`);
    notify();
    return { ok: true };
  }

  const CREW_FLOW = {
    accept: { from: ['sent'], to: 'accepted', stamp: 'accepted_at' },
    arrive_scene: { from: ['accepted'], to: 'on_scene', stamp: 'on_scene_at', incident: 'on_scene' },
    leave_scene: { from: ['on_scene'], to: 'to_hospital', stamp: 'left_scene_at', incident: 'to_hospital' },
    arrive_hospital: { from: ['to_hospital'], to: 'at_hospital', stamp: 'arrived_at', incident: 'arrived' },
  };

  async function crewAction(missionId, action, actor) {
    const m = mission(missionId), step = CREW_FLOW[action] || fail(400, 'Action inconnue');
    if (!step.from.includes(m.status)) fail(409, "Cette étape ne correspond pas à l'état de la mission");
    q('UPDATE missions SET status = ?, route_checked_at = NULL WHERE id = ?').run(step.to, m.id);
    q(`UPDATE incidents SET ${step.stamp} = COALESCE(${step.stamp}, ?) WHERE id = ?`).run(now(), m.incident_id);
    if (step.incident) q('UPDATE incidents SET status = ? WHERE id = ?').run(step.incident, m.incident_id);
    log(m.incident_id, actor, `crew_${action}`);
    if (step.to === 'on_scene' || step.to === 'at_hospital') await releaseAll(m.id);
    if (step.to === 'to_hospital' || step.to === 'accepted') await refreshRoute(m.id, true);
    notify();
    return { ok: true };
  }

  function updateVictims(missionId, b, actor) {
    const m = mission(missionId), prev = assessment(m.incident_id) || {};
    const merged = { vehicles: prev.vehicles ?? 0, bus: !!prev.bus, victims: b.victims ?? prev.victims ?? 0, trapped: b.trapped ?? !!prev.trapped, fire: b.fire ?? !!prev.fire, conscious: b.conscious ?? (prev.conscious == null ? true : !!prev.conscious) };
    return assess(m.incident_id, merged, actor);
  }

  function closeIncident(id, actor, cancelled) {
    incident(id);
    q("UPDATE missions SET status = ? WHERE incident_id = ? AND status NOT IN ('done', 'cancelled')").run(cancelled ? 'cancelled' : 'done', id);
    for (const m of q('SELECT id FROM missions WHERE incident_id = ?').all(id)) releaseAll(m.id);
    setStatus(id, cancelled ? 'cancelled' : 'closed', cancelled ? 'cancelled_at' : 'closed_at');
    log(id, actor, cancelled ? 'cancelled' : 'closed');
    notify();
    return { ok: true };
  }

  // ---- routes and simulated light priority
  function routeTarget(m) {
    if (['sent', 'accepted'].includes(m.status)) { const i = incident(m.incident_id); return i.lat == null ? null : { lat: i.lat, lon: i.lon }; }
    if (m.status === 'to_hospital') { const h = hospital(m.hospital_id); return { lat: h.lat, lon: h.lon }; }
    return null;
  }

  async function refreshRoute(missionId, force) {
    const m = mission(missionId), target = routeTarget(m);
    if (!target) return;
    const from = unitPosition(unit(m.unit_id));
    const fresh = await routes.route(from, target);
    const stored = m.route_json ? JSON.parse(m.route_json) : null;
    let remaining = 0;
    if (stored && !force && m.eta_seconds > 0) {
      const a = R.along(stored, from);
      remaining = a.totalM > 0 ? m.eta_seconds * Math.max(0, 1 - a.sM / a.totalM) : 0;
    }
    // Each leg starts on the usual route. After that the platform never changes it alone: a route at least
    // routeMinGain faster is only offered, and the crew decides (twin: automatic changes lost 6 of 24 sites against 4).
    if (force || !stored) {
      q('UPDATE missions SET route_json = ?, route_source = ?, eta_seconds = ?, route_checked_at = ?, suggested_route_json = NULL, suggested_eta = NULL, suggested_at = NULL WHERE id = ?').run(JSON.stringify(fresh.coords), fresh.source, fresh.etaS, now(), m.id);
    } else if (R.shouldSwitchRoute(remaining, fresh.etaS)) {
      const had = m.suggested_route_json != null;
      q('UPDATE missions SET suggested_route_json = ?, suggested_eta = ?, suggested_at = COALESCE(suggested_at, ?), route_checked_at = ? WHERE id = ?').run(JSON.stringify(fresh.coords), fresh.etaS, now(), now(), m.id);
      if (!had) { log(m.incident_id, 'system', 'route_suggested'); notify(); }
    } else {
      q('UPDATE missions SET route_checked_at = ?, suggested_route_json = NULL, suggested_eta = NULL, suggested_at = NULL WHERE id = ?').run(now(), m.id);
      if (m.suggested_route_json != null) notify();
    }
  }

  // The crew accepts the suggested route, or dismisses it. Only then does the route change.
  function answerRoute(missionId, accept, actor) {
    const m = mission(missionId);
    if (!m.suggested_route_json) fail(409, 'Aucun itinéraire proposé');
    if (accept) {
      q('UPDATE missions SET route_json = ?, eta_seconds = ?, route_changes = route_changes + 1, suggested_route_json = NULL, suggested_eta = NULL, suggested_at = NULL WHERE id = ?').run(m.suggested_route_json, m.suggested_eta, m.id);
      log(m.incident_id, actor, 'route_accepted');
    } else {
      q('UPDATE missions SET suggested_route_json = NULL, suggested_eta = NULL, suggested_at = NULL WHERE id = ?').run(m.id);
      log(m.incident_id, actor, 'route_dismissed');
    }
    notify();
    return { ok: true };
  }

  async function releaseAll(missionId) {
    for (const p of q("SELECT * FROM priority_requests WHERE mission_id = ? AND status != 'released'").all(missionId)) {
      await signals.release(lightById.get(p.light_id), missionId);
      q("UPDATE priority_requests SET status = 'released', released_at = ? WHERE id = ?").run(now(), p.id);
    }
  }

  async function updatePriority(m) {
    const moving = ['accepted', 'to_hospital'].includes(m.status) && m.route_json;
    const open = q("SELECT * FROM priority_requests WHERE mission_id = ? AND status != 'released'").all(m.id);
    const pos = unitPosition(unit(m.unit_id));
    if (!moving || !pos.updated_at || now() - pos.updated_at > CONFIG.priorityExpiryMs) { if (open.length) await releaseAll(m.id); return; }
    const ahead = new Map(R.lightsAhead(JSON.parse(m.route_json), pos, lights).map(a => [a.light.id, a]));
    const held = new Set();
    for (const p of open) {
      // A real controller lets a command expire by itself, so each one is renewed, and a refusal ends it here too.
      const renewed = ahead.has(p.light_id) && signals.live ? await signals.request(lightById.get(p.light_id), m.id) : null;
      if (!ahead.has(p.light_id)) {
        await signals.release(lightById.get(p.light_id), m.id);
        q("UPDATE priority_requests SET status = 'released', released_at = ? WHERE id = ?").run(now(), p.id);
        held.add(p.light_id);
        continue;
      }
      held.add(p.light_id);
      if (renewed && !renewed.accepted) {
        log(m.incident_id, 'system', 'light_refused', renewed.reason);
        q("UPDATE priority_requests SET status = 'released', released_at = ? WHERE id = ?").run(now(), p.id);
      } else if (p.status === 'requested' && now() - p.requested_at >= CONFIG.yellowAndAllRedMs) {
        q("UPDATE priority_requests SET status = 'active', active_at = ? WHERE id = ?").run(now(), p.id);
      }
    }
    for (const [id, a] of ahead) {
      if (held.has(id)) continue;
      // Never show a light as opening unless its controller accepted. It is asked again on the next pass.
      const asked = await signals.request(a.light, m.id);
      if (asked && asked.accepted === false) continue;
      q("INSERT INTO priority_requests (mission_id, light_id, status, requested_at) VALUES (?, ?, 'requested', ?)").run(m.id, id, now());
    }
  }

  function setPosition(missionId, body) {
    const m = mission(missionId), p = coords(body);
    q('INSERT INTO unit_positions (unit_id, lat, lon, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(unit_id) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, updated_at = excluded.updated_at').run(m.unit_id, p.lat, p.lon, now());
    notify();
    return { ok: true };
  }

  // For demos without a moving phone: drives the unit along its route, and every screen says it is simulated.
  function simulateDrive(missionId, actor) {
    const m = mission(missionId);
    q('UPDATE missions SET simulated = 1 WHERE id = ?').run(m.id);
    log(m.incident_id, actor, 'simulation_started');
    notify();
    return { ok: true };
  }

  function advanceSimulated(dtS, speedMs = 14) {
    for (const m of q("SELECT * FROM missions WHERE simulated = 1 AND status IN ('accepted', 'to_hospital') AND route_json IS NOT NULL").all()) {
      const route = JSON.parse(m.route_json), a = R.along(route, unitPosition(unit(m.unit_id)));
      let left = a.sM + speedMs * dtS, point = route[route.length - 1];
      for (let i = 1; i < route.length; i++) {
        const p0 = { lat: route[i - 1][1], lon: route[i - 1][0] }, p1 = { lat: route[i][1], lon: route[i][0] }, len = R.distanceM(p0, p1);
        if (left <= len) { const t = len ? left / len : 0; point = [p0.lon + (p1.lon - p0.lon) * t, p0.lat + (p1.lat - p0.lat) * t]; break; }
        left -= len;
      }
      setPosition(m.id, { lat: point[1], lon: point[0] });
    }
  }

  // Runs every few seconds: routes, light priority, unanswered alerts and old personal data.
  async function tick() {
    const active = q("SELECT * FROM missions WHERE status IN ('sent', 'accepted', 'on_scene', 'to_hospital')").all();
    for (const m of active) {
      if (['accepted', 'to_hospital'].includes(m.status) && (!m.route_checked_at || now() - m.route_checked_at >= CONFIG.routeRefreshMs)) await refreshRoute(m.id);
      await updatePriority(q('SELECT * FROM missions WHERE id = ?').get(m.id));
      if (m.ack_version < m.alert_version && m.alert_at && now() - m.alert_at >= CONFIG.ackTimeoutMs && m.sms_escalated_version < m.alert_version) {
        const h = hospital(m.hospital_id), i = incident(m.incident_id);
        q('UPDATE missions SET sms_escalated_version = ? WHERE id = ?').run(m.alert_version, m.id);
        const r = h.phone ? await sms.send(h.phone, `Alerte ambulance : accident ${i.id}, gravité ${levelText(i.severity)}. Ouvrez l'écran des urgences.`) : { status: 'no_hospital_phone' };
        log(m.incident_id, 'system', 'ack_escalated', r.status);
      }
    }
    purgeOld();
    if (active.length) notify();
  }

  const levelText = l => ({ low: 'faible', medium: 'moyenne', high: 'élevée', critical: 'critique' }[l] || 'non définie');

  function purgeOld() {
    const limit = now() - CONFIG.retentionMs;
    const old = q('SELECT id FROM incidents WHERE (closed_at < ? OR cancelled_at < ?) AND phone IS NOT NULL').all(limit, limit);
    const removed = [];
    for (const { id } of old) {
      for (const r of q('SELECT photo_path FROM reports WHERE incident_id = ? AND photo_path IS NOT NULL').all(id)) removed.push(r.photo_path);
      q('UPDATE incidents SET phone = NULL WHERE id = ?').run(id);
      q('UPDATE reports SET phone = NULL, photo_path = NULL WHERE incident_id = ?').run(id);
      q('UPDATE caller_links SET phone_e164 = NULL WHERE incident_id = ?').run(id);
    }
    return removed;
  }

  // ---- what each role may see
  function missionView(m) {
    const u = unit(m.unit_id), h = m.hospital_id ? hospital(m.hospital_id) : null, pos = unitPosition(u);
    const requests = q("SELECT light_id, status FROM priority_requests WHERE mission_id = ? AND status != 'released'").all(m.id);
    let etaLeft = m.eta_seconds;
    const route = m.route_json ? JSON.parse(m.route_json) : null;
    if (route && pos.updated_at) { const a = R.along(route, pos); if (a.totalM > 0) etaLeft = m.eta_seconds * Math.max(0, 1 - a.sM / a.totalM); }
    return {
      id: m.id, incident_id: m.incident_id, status: m.status, simulated: !!m.simulated,
      unit: { id: u.id, name: u.name, lat: pos.lat, lon: pos.lon, ageS: pos.updated_at ? Math.round((now() - pos.updated_at) / 1000) : null },
      hospital: h && { id: h.id, name: h.name, lat: h.lat, lon: h.lon },
      suggestion: m.suggested_route_json ? { route: JSON.parse(m.suggested_route_json), etaS: Math.round(m.suggested_eta), gainS: etaLeft == null ? null : Math.max(0, Math.round(etaLeft - m.suggested_eta)) } : null,
      route, routeSource: m.route_source, routeChanges: m.route_changes, etaLeftS: etaLeft == null ? null : Math.round(etaLeft),
      ackPending: m.ack_version < m.alert_version, ackAt: m.ack_at, ackBy: m.ack_by, readyAt: m.ready_at,
      ackLate: m.ack_version < m.alert_version && !!m.alert_at && now() - m.alert_at >= CONFIG.ackTimeoutMs,
      priority: requests.map(r => { const l = lightById.get(r.light_id); return { status: r.status, lat: l.lat, lon: l.lon, names: l.names, source: l.source, live: Boolean(signals.live) }; }),
    };
  }

  const openMissions = where => q(`SELECT * FROM missions WHERE ${where} ORDER BY id DESC`);

  function operatorState() {
    const incidents = q("SELECT * FROM incidents WHERE status NOT IN ('closed', 'cancelled') ORDER BY id DESC LIMIT 100").all();
    const views = incidents.map(i => ({
      ...i,
      assessment: assessment(i.id),
      reports: q('SELECT id, channel, lat, lon, accuracy_m, photo_path, confirmed, created_at FROM reports WHERE incident_id = ?').all(i.id),
      links: q('SELECT sms_status, used_at, expires_at FROM caller_links WHERE incident_id = ? ORDER BY id DESC LIMIT 1').all(i.id),
      missions: q("SELECT * FROM missions WHERE incident_id = ? AND status NOT IN ('done', 'cancelled')").all(i.id).map(missionView),
      duplicateOf: null,
    }));
    for (const v of views) {
      if (v.lat == null || v.missions.length) continue;
      const twin = views.find(o => o.id !== v.id && o.id < v.id && R.isNearDuplicate({ lat: v.lat, lon: v.lon }, { ...o, created_at: v.created_at }, now()) && v.created_at - o.created_at <= CONFIG.mergeWindowMs);
      if (twin) v.duplicateOf = twin.id;
    }
    const pending = q('SELECT id, lat, lon, accuracy_m, phone, created_at FROM reports WHERE incident_id IS NULL AND confirmed = 0 AND rejected = 0 ORDER BY id DESC LIMIT 50').all()
      .map(r => {
        const near = views.find(i => R.isNearDuplicate(r, { ...i, created_at: r.created_at }, now()) && r.created_at - i.created_at <= CONFIG.mergeWindowMs);
        return { ...r, nearIncident: near ? near.id : null };
      });
    return {
      role: 'operator', now: now(), staleAfterS: CONFIG.staleAfterMs / 1000, incidents: views, pending,
      events: q('SELECT id, incident_id, at, actor, action FROM events ORDER BY id DESC LIMIT 30').all(),
      units: q('SELECT * FROM units').all().map(u => { const p = unitPosition(u); return { id: u.id, name: u.name, lat: p.lat, lon: p.lon, available: !!u.available, ageS: p.updated_at ? Math.round((now() - p.updated_at) / 1000) : null }; }),
      hospitals: q('SELECT id, name, lat, lon, available, phone FROM hospitals').all().map(h => ({ ...h, available: !!h.available })),
      smsConfigured: sms.configured,
    };
  }

  function crewState(unitId) {
    const u = unit(unitId);
    const m = openMissions("unit_id = ? AND status NOT IN ('done', 'cancelled')").get(unitId);
    const i = m ? incident(m.incident_id) : null;
    return {
      role: 'crew', now: now(), unit: { id: u.id, name: u.name },
      mission: m ? missionView(m) : null,
      incident: i && { id: i.id, status: i.status, severity: i.severity, score: i.score, lat: i.lat, lon: i.lon, road_label: i.road_label, assessment: assessment(i.id) },
    };
  }

  function hospitalState(hospitalId) {
    const h = hospital(hospitalId);
    const list = openMissions("hospital_id = ? AND status NOT IN ('done', 'cancelled')").all(hospitalId).map(m => {
      const i = incident(m.incident_id), v = missionView(m);
      return { ...v, route: undefined, priority: undefined, incident: { id: i.id, status: i.status, severity: i.severity, score: i.score, road_label: i.road_label, assessment: assessment(i.id) } };
    });
    return { role: 'hospital', now: now(), hospital: { id: h.id, name: h.name, available: !!h.available }, incoming: list };
  }

  function metrics() {
    const rows = q('SELECT * FROM incidents WHERE assessed_at IS NOT NULL OR located_at IS NOT NULL ORDER BY id DESC LIMIT 200').all();
    const stages = [
      ['located_at', 'created_at', 'Localisation'],
      ['assessed_at', 'located_at', 'Évaluation'],
      ['dispatched_at', 'assessed_at', 'Envoi'],
      ['on_scene_at', 'dispatched_at', 'Trajet vers les lieux'],
      ['left_scene_at', 'on_scene_at', 'Sur les lieux'],
      ['arrived_at', 'left_scene_at', "Transport à l'hôpital"]
    ];
    const list = rows.map(r => ({
      id: r.id,
      status: r.status,
      severity: r.severity,
      road_label: r.road_label,
      created_at: r.created_at,
      durations: stages.map(([end, start]) => (r[end] && r[start] ? Math.round((r[end] - r[start]) / 1000) : null)),
      totalS: r.arrived_at ? Math.round((r.arrived_at - r.created_at) / 1000) : null
    }));
    const averages = stages.map((_, k) => {
      const v = list.map(x => x.durations[k]).filter(d => d != null);
      return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
    });

    // Slowest stage identification
    let slowest = null, maxAvg = -1;
    stages.forEach((s, k) => {
      if (averages[k] != null && averages[k] > maxAvg) {
        maxAvg = averages[k];
        slowest = { index: k, name: s[2], durationS: averages[k] };
      }
    });

    // Incidents grouped per day
    const dayMap = {};
    list.forEach(item => {
      if (!item.created_at) return;
      const day = new Date(item.created_at).toISOString().slice(0, 10);
      if (!dayMap[day]) dayMap[day] = { day, count: 0, totalDuration: 0, closedCount: 0 };
      dayMap[day].count++;
      if (item.totalS != null) {
        dayMap[day].totalDuration += item.totalS;
        dayMap[day].closedCount++;
      }
    });
    const perDay = Object.values(dayMap).sort((a, b) => b.day.localeCompare(a.day)).map(d => ({
      day: d.day,
      count: d.count,
      avgTotalS: d.closedCount ? Math.round(d.totalDuration / d.closedCount) : null
    }));

    const totals = list.map(x => x.totalS).filter(t => t != null);
    const overallAvgTotalS = totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : null;

    return {
      stages: stages.map(s => s[2]),
      averages,
      incidents: list,
      slowest,
      perDay,
      summary: {
        totalIncidents: list.length,
        closedWithArrival: totals.length,
        avgTotalS: overallAvgTotalS,
        slowestStage: slowest
      }
    };
  }

  const lightsForMap = () => lights;
  const photoAllowed = p => Boolean(q('SELECT 1 FROM reports WHERE photo_path = ?').get(p));
  const missionOwnedByUnit = (id, unitId) => mission(id).unit_id === unitId;
  const missionGoesTo = (id, hospitalId) => mission(id).hospital_id === hospitalId;
  const loginOptions = () => ({ units: q('SELECT id, name FROM units ORDER BY id').all(), hospitals: q('SELECT id, name FROM hospitals ORDER BY name').all() });

  return { ApiError, createIncident, sendLink, setIncidentLocation, callerStatus, callerLocation, callerPhoto, appReport, confirmReport, rejectReport, mergeIncident, assess, suggest, dispatch, changeHospital, acknowledge, markReady, setHospitalAvailability, crewAction, answerRoute, updateVictims, closeIncident, setPosition, simulateDrive, advanceSimulated, refreshRoute, tick, purgeOld, operatorState, crewState, hospitalState, metrics, lightsForMap, photoAllowed, missionOwnedByUnit, missionGoesTo, loginOptions, mission, q, log };
}

module.exports = { createApp };
