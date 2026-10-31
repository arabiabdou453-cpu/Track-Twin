// SQLite storage: one file, no separate database server.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs'), path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'new',
  severity TEXT, score INTEGER,
  lat REAL, lon REAL, accuracy_m REAL, road_label TEXT,
  phone TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL, located_at INTEGER, assessed_at INTEGER, dispatched_at INTEGER, accepted_at INTEGER,
  on_scene_at INTEGER, left_scene_at INTEGER, arrived_at INTEGER, closed_at INTEGER, cancelled_at INTEGER
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER REFERENCES incidents(id),
  channel TEXT NOT NULL,
  lat REAL, lon REAL, accuracy_m REAL, photo_path TEXT, phone TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS caller_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  phone_e164 TEXT, expires_at INTEGER NOT NULL, used_at INTEGER, sms_status TEXT
);
CREATE TABLE IF NOT EXISTS units (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, available INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS unit_positions (unit_id INTEGER PRIMARY KEY REFERENCES units(id), lat REAL, lon REAL, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS hospitals (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, phone TEXT, available INTEGER NOT NULL DEFAULT 1, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS missions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  unit_id INTEGER NOT NULL REFERENCES units(id),
  hospital_id INTEGER REFERENCES hospitals(id),
  status TEXT NOT NULL DEFAULT 'sent',
  route_json TEXT, route_source TEXT, eta_seconds REAL, route_changes INTEGER NOT NULL DEFAULT 0, route_checked_at INTEGER,
  alert_version INTEGER NOT NULL DEFAULT 1, alert_at INTEGER, ack_version INTEGER NOT NULL DEFAULT 0, ack_at INTEGER, ack_by TEXT, ready_at INTEGER, sms_escalated_version INTEGER NOT NULL DEFAULT 0,
  simulated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS assessments (
  incident_id INTEGER PRIMARY KEY REFERENCES incidents(id),
  vehicles INTEGER, bus INTEGER, victims INTEGER, trapped INTEGER, fire INTEGER, conscious INTEGER,
  updated_by TEXT, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS priority_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id INTEGER NOT NULL REFERENCES missions(id),
  light_id TEXT NOT NULL, status TEXT NOT NULL,
  requested_at INTEGER, active_at INTEGER, released_at INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER, at INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_missions_incident ON missions(incident_id);
CREATE INDEX IF NOT EXISTS idx_priority_mission ON priority_requests(mission_id, status);
CREATE INDEX IF NOT EXISTS idx_reports_incident ON reports(incident_id);
`;

function openDb(file, seedDir) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // A faster route is only suggested to the crew; it is kept here until they accept it or it stops being faster.
  const have = new Set(db.prepare("SELECT name FROM pragma_table_info('missions')").all().map(c => c.name));
  for (const [col, type] of [['suggested_route_json', 'TEXT'], ['suggested_eta', 'REAL'], ['suggested_at', 'INTEGER']]) {
    if (!have.has(col)) db.exec(`ALTER TABLE missions ADD COLUMN ${col} ${type}`);
  }
  if (seedDir && db.prepare('SELECT COUNT(*) AS n FROM hospitals').get().n === 0) seed(db, seedDir);
  return db;
}

// Places come from OpenStreetMap. They must be checked before any real use.
function seed(db, seedDir) {
  const { places } = JSON.parse(fs.readFileSync(path.join(seedDir, 'units_hospitals.json'), 'utf8'));
  const addUnit = db.prepare('INSERT INTO units (name, lat, lon) VALUES (?, ?, ?)');
  const addHospital = db.prepare('INSERT INTO hospitals (name, lat, lon) VALUES (?, ?, ?)');
  let n = 0;
  for (const p of places) {
    if (p.kind === 'unit') addUnit.run(`${p.name || 'Unité'} ${++n}`, p.lat, p.lon);
    else if (p.name && !/clinique|polyclinique|cabinet/i.test(p.name)) addHospital.run(p.name, p.lat, p.lon);
  }
}

function loadLights(seedDir) {
  const g = JSON.parse(fs.readFileSync(path.join(seedDir, 'lights.geojson'), 'utf8'));
  return g.features.map(f => ({ id: f.properties.id, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], names: f.properties.names || [], source: f.properties.source }));
}

module.exports = { openDb, loadLights };
