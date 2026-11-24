/* Хранилище журнала: SQLite (встроен в Node.js), один файл БД.
   Записи хранятся в том же JSON-формате, что db.records журнала и мобильного приложения. */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROLES = ['instructor', 'otos', 'admin'];

const open = file => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(login TEXT PRIMARY KEY, fio TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, unit TEXT NOT NULL DEFAULT '',
      pass TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, login TEXT NOT NULL REFERENCES users(login) ON DELETE CASCADE,
      created TEXT NOT NULL, expires TEXT NOT NULL, device TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, data TEXT NOT NULL, closed INTEGER NOT NULL, demo INTEGER NOT NULL DEFAULT 0,
      unit TEXT, date TEXT, type TEXT, owner TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, rev INTEGER NOT NULL, sha256 TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS records_rev ON records(rev);
    CREATE INDEX IF NOT EXISTS records_owner ON records(owner);
    CREATE TABLE IF NOT EXISTS conflicts(n INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT NOT NULL, data TEXT NOT NULL, login TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS staff(k INTEGER PRIMARY KEY CHECK(k=1), data TEXT NOT NULL, updated TEXT NOT NULL, login TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(n INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, login TEXT, ip TEXT, action TEXT NOT NULL, detail TEXT);
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
    INSERT OR IGNORE INTO meta VALUES('rev','0');`);
  return db;
};

const now = () => new Date().toISOString();
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

/* ---------- пароли и сессии ---------- */
const hashPass = p => { const salt = crypto.randomBytes(16); const h = crypto.scryptSync(p, salt, 32, { N: 16384, r: 8, p: 1 }); return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`; };
const checkPass = (p, stored) => {
  const [alg, salt, h] = String(stored).split('$'); if (alg !== 'scrypt' || !salt || !h) return false;
  const x = crypto.scryptSync(p, Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(x, Buffer.from(h, 'hex'));
};
const genPass = () => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; return [...crypto.randomBytes(10)].map(b => a[b % a.length]).join(''); };
const passProblem = p => (typeof p !== 'string' || p.length < 8) ? 'Пароль: не короче 8 символов' : p.length > 200 ? 'Пароль слишком длинный' : '';

/* ---------- нормализация записи (как normRec в журнале v1.1) ---------- */
const S = v => String(v ?? '');
const normSig = s => (s && typeof s === 'object') ? s : null;
const normRec = raw => {
  if (!raw || typeof raw !== 'object' || !raw.id || !Array.isArray(raw.workers)) return null;
  const r = { ...raw };
  r.id = S(r.id).slice(0, 100); if (!/^[\w.-]+$/.test(r.id)) return null;
  r.created = S(r.created || now());
  r.instructor = { fio: '', position: '', iin: '', ...(r.instructor && typeof r.instructor === 'object' ? r.instructor : {}) };
  r.instructorSig = normSig(r.instructorSig);
  for (const k of ['unit', 'date', 'type', 'reason', 'instructions']) r[k] = S(r[k]);
  r.workers = r.workers.filter(w => w && typeof w === 'object' && w.fio).map(w => ({ birthYear: '', profession: '', iin: '', knowledge: false, sid: '', ...w, sig: normSig(w.sig), id: S(w.id || crypto.randomUUID()), fio: S(w.fio) }));
  return r;
};

/* ---------- объединение по id (те же правила, что mergeRecords в журнале v1.1) ----------
   закрытая запись неизменна: другая версия закрытой записи попадает в таблицу conflicts;
   в открытую запись дописываются недостающие подписи работников, прежняя подпись уходит в sigHistory */
const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v ?? null);
const mergeOne = (ex, r) => {
  // закрытая запись не меняется; устаревший черновик той же записи просто игнорируется
  if (ex.instructorSig) return r.instructorSig && canon(ex) !== canon(r) ? { st: 'conflict' } : { st: 'same' };
  if (r.instructorSig) { // закрытая версия заменяет черновик, но подписи, известные только серверу, сохраняются в sigHistory
    const out = JSON.parse(JSON.stringify(r)); const em = new Map(ex.workers.map(w => [w.id, w]));
    for (const w of out.workers) {
      const e = em.get(w.id); if (!e) continue;
      const seen = new Set([w.sig && w.sig.at, ...(w.sigHistory || []).map(h => h.at)].filter(Boolean));
      const extra = [...(e.sigHistory || []), ...(e.sig ? [{ ...e.sig, replacedAt: w.sig ? w.sig.at : '' }] : [])].filter(h => h.at && !seen.has(h.at));
      if (extra.length) w.sigHistory = [...(w.sigHistory || []), ...extra].sort((a, b) => S(a.at).localeCompare(S(b.at)));
    }
    return { st: 'updated', rec: out };
  }
  let ch = false; const out = JSON.parse(JSON.stringify(ex)); const wm = new Map(out.workers.map(w => [w.id, w]));
  for (const w of r.workers) {
    const e = wm.get(w.id);
    if (!e) { out.workers.push(w); ch = true; continue; }
    if (w.sig && !e.sig) { e.sig = w.sig; ch = true; }
    else if (w.sig && e.sig && S(w.sig.at) > S(e.sig.at)) { (e.sigHistory = e.sigHistory || []).push({ ...e.sig, replacedAt: w.sig.at }); e.sig = w.sig; ch = true; }
  }
  return ch ? { st: 'updated', rec: out } : { st: 'same' };
};

const nextRev = db => { const r = +db.prepare(`SELECT v FROM meta WHERE k='rev'`).get().v + 1; db.prepare(`UPDATE meta SET v=? WHERE k='rev'`).run(String(r)); return r; };

const putRecords = (db, list, user) => {
  const res = []; const t = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const get = db.prepare('SELECT data, owner FROM records WHERE id=?');
    const ins = db.prepare('INSERT INTO records(id,data,closed,demo,unit,date,type,owner,created,updated,rev,sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    const upd = db.prepare('UPDATE records SET data=?, closed=?, demo=?, unit=?, date=?, type=?, updated=?, rev=?, sha256=? WHERE id=?');
    for (const raw of list) {
      const r = normRec(raw);
      if (!r) { res.push({ id: raw && raw.id ? S(raw.id) : '', status: 'invalid' }); continue; }
      const row = get.get(r.id);
      const meta = rec => { const s = JSON.stringify(rec); return [s, rec.instructorSig ? 1 : 0, rec.demo ? 1 : 0, rec.unit, rec.date, rec.type, sha256(s)]; };
      if (!row) {
        const [s, c, d, u, dt, ty, h] = meta(r);
        ins.run(r.id, s, c, d, u, dt, ty, user.login, t, t, nextRev(db), h);
        res.push({ id: r.id, status: 'added' }); audit(db, user.login, user.ip, 'record.add', r.id); continue;
      }
      if (user.role === 'instructor' && row.owner !== user.login) { res.push({ id: r.id, status: 'forbidden' }); continue; }
      const m = mergeOne(JSON.parse(row.data), r);
      if (m.st === 'conflict') {
        db.prepare('INSERT INTO conflicts(record_id,data,login,at) VALUES(?,?,?,?)').run(r.id, JSON.stringify(r), user.login, t);
        audit(db, user.login, user.ip, 'record.conflict', r.id);
      } else if (m.st === 'updated') {
        const [s, c, d, u, dt, ty, h] = meta(m.rec);
        upd.run(s, c, d, u, dt, ty, t, nextRev(db), h, r.id); audit(db, user.login, user.ip, 'record.update', r.id);
      }
      res.push({ id: r.id, status: m.st });
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return res;
};

const getRecords = (db, user, since) => {
  const all = user.role !== 'instructor';
  const rows = all ? db.prepare('SELECT data, rev FROM records WHERE rev>? ORDER BY rev').all(since)
    : db.prepare('SELECT data, rev FROM records WHERE rev>? AND owner=? ORDER BY rev').all(since, user.login);
  const rev = +db.prepare(`SELECT v FROM meta WHERE k='rev'`).get().v;
  return { rev, records: rows.map(r => JSON.parse(r.data)) };
};

const audit = (db, login, ip, action, detail) => db.prepare('INSERT INTO audit(at,login,ip,action,detail) VALUES(?,?,?,?,?)').run(now(), login || null, ip || null, action, detail == null ? null : S(detail).slice(0, 500));

/* ---------- резервные копии ---------- */
const backup = (db, dir, keepDays) => {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-'); // местное время сервера
  const file = path.join(dir, `journal-${stamp}.sqlite`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const limit = Date.now() - keepDays * 86400000;
  for (const f of fs.readdirSync(dir)) if (/^journal-.*\.sqlite$/.test(f)) { const p = path.join(dir, f); if (fs.statSync(p).mtimeMs < limit) fs.unlinkSync(p); }
  return file;
};

module.exports = { open, ROLES, hashPass, checkPass, genPass, passProblem, sha256, normRec, mergeOne, putRecords, getRecords, audit, backup, now };
