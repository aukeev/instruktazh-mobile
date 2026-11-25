/* Сервер электронного журнала инструктажей.
   Без внешних зависимостей: Node.js 22+ (http, crypto, встроенный SQLite).
   API: /api/*, статика: / (мобильное приложение), /journal/ (журнал), /admin/ (пользователи). */
'use strict';
process.removeAllListeners('warning'); // скрыть ExperimentalWarning про node:sqlite
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');

const VERSION = '1.0.0';
const env = (k, d) => process.env[k] ?? d;
const CFG = {
  port: +env('PORT', 8080),
  host: env('HOST', '0.0.0.0'),
  dbFile: env('DB_FILE', path.join(__dirname, 'data', 'journal.sqlite')),
  backupDir: env('BACKUP_DIR', path.join(__dirname, 'backups')),
  backupHour: +env('BACKUP_HOUR', 2),
  backupKeepDays: +env('BACKUP_KEEP_DAYS', 30),
  sessionDays: +env('SESSION_DAYS', 30),
  publicDir: env('PUBLIC_DIR', path.join(__dirname, '..')),
  adminDir: env('ADMIN_DIR', path.join(__dirname, 'admin')),
  origins: env('ALLOWED_ORIGINS', 'https://aukeev.github.io,null').split(',').map(s => s.trim()).filter(Boolean),
  trustProxy: env('TRUST_PROXY', '0') === '1',
  maxBody: 20 * 1024 * 1024,
};

const db = store.open(CFG.dbFile);
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------- ограничение попыток входа ---------- */
const fails = new Map(); // ключ -> {n, until}
// логин блокируется после 10 ошибок, адрес — после 50 (в офисе многие выходят в интернет с одного адреса)
const LOCK_MS = 15 * 60000;
const isLocked = k => { const f = fails.get(k); return f && f.until > Date.now(); };
const addFail = k => { const f = fails.get(k) || { n: 0, until: 0 }; f.n++; if (f.n >= (k.startsWith('ip:') ? 50 : 10)) { f.until = Date.now() + LOCK_MS; f.n = 0; } fails.set(k, f); };
setInterval(() => { const t = Date.now(); for (const [k, f] of fails) if (f.until < t && !f.n) fails.delete(k); }, 600000).unref();

/* ---------- помощники HTTP ---------- */
class HttpError extends Error { constructor(code, msg, extra) { super(msg); this.code = code; this.extra = extra; } }
const ipOf = req => (CFG.trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',').pop().trim() : req.socket.remoteAddress) || '';
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'geolocation=(), microphone=()' };
const cors = (req, res) => {
  const o = req.headers.origin;
  if (o && (CFG.origins.includes('*') || CFG.origins.includes(o))) {
    res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
};
const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC }); res.end(b); };
const readJson = req => new Promise((ok, bad) => {
  let n = 0; const parts = [];
  req.on('data', c => { n += c.length; if (n > CFG.maxBody) { bad(new HttpError(413, 'Слишком большой запрос')); req.destroy(); } else parts.push(c); });
  req.on('end', () => { if (!n) return ok({}); try { ok(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (e) { bad(new HttpError(400, 'Неверный JSON')); } });
  req.on('error', bad);
});

/* ---------- сессии ---------- */
const newSession = (login, device) => {
  const token = crypto.randomBytes(32).toString('base64url');
  const exp = new Date(Date.now() + CFG.sessionDays * 86400000).toISOString();
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(store.sha256(token), login, store.now(), exp, String(device || '').slice(0, 120));
  return { token, expires: exp };
};
const auth = req => {
  const m = /^Bearer\s+([\w-]{20,})$/.exec(req.headers.authorization || '');
  if (!m) throw new HttpError(401, 'Нужен вход');
  const h = store.sha256(m[1]);
  const row = db.prepare(`SELECT s.expires, u.login, u.fio, u.role, u.unit, u.active, u.must_change FROM sessions s JOIN users u ON u.login=s.login WHERE s.token_hash=?`).get(h);
  if (!row || !row.active || row.expires < store.now()) { if (row) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(h); throw new HttpError(401, 'Сессия истекла, войдите заново'); }
  // скользящий срок: продлеваем, если прошло больше половины
  if (Date.parse(row.expires) - Date.now() < CFG.sessionDays * 43200000) db.prepare('UPDATE sessions SET expires=? WHERE token_hash=?').run(new Date(Date.now() + CFG.sessionDays * 86400000).toISOString(), h);
  return { login: row.login, fio: row.fio, role: row.role, unit: row.unit, mustChange: !!row.must_change, ip: ipOf(req), tokenHash: h };
};
const need = (u, ...roles) => { if (!roles.includes(u.role)) throw new HttpError(403, 'Недостаточно прав'); };
const pub = u => ({ login: u.login, fio: u.fio, role: u.role, unit: u.unit, mustChange: !!(u.mustChange ?? u.must_change) });

/* ---------- маршруты API ---------- */
const routes = {
  'GET /api/health': () => ({ ok: true, version: VERSION, time: store.now() }),

  'POST /api/login': async req => {
    const b = await readJson(req); const login = String(b.login || '').trim().toLowerCase(); const ip = ipOf(req);
    if (isLocked('ip:' + ip) || isLocked('u:' + login)) throw new HttpError(429, 'Слишком много неудачных попыток. Подождите 15 минут.');
    const u = db.prepare('SELECT * FROM users WHERE login=?').get(login);
    if (!u || !u.active || !store.checkPass(String(b.password || ''), u.pass)) {
      addFail('ip:' + ip); addFail('u:' + login); store.audit(db, login, ip, 'login.fail');
      throw new HttpError(401, 'Неверный логин или пароль');
    }
    fails.delete('u:' + login);
    if (u.must_change) {
      const np = b.newPassword;
      if (!np) throw new HttpError(403, 'Задайте новый пароль', { mustChange: true });
      const pp = store.passProblem(np); if (pp) throw new HttpError(400, pp, { mustChange: true });
      if (np === b.password) throw new HttpError(400, 'Новый пароль должен отличаться от выданного', { mustChange: true });
      db.prepare('UPDATE users SET pass=?, must_change=0 WHERE login=?').run(store.hashPass(np), login); u.must_change = 0;
      store.audit(db, login, ip, 'password.change');
    }
    store.audit(db, login, ip, 'login.ok', b.device);
    return { ...newSession(login, b.device), user: pub(u) };
  },
  'POST /api/logout': req => { const u = auth(req); db.prepare('DELETE FROM sessions WHERE token_hash=?').run(u.tokenHash); return { ok: true }; },
  'GET /api/me': req => ({ user: pub(auth(req)) }),
  'POST /api/password': async req => {
    const u = auth(req); const b = await readJson(req);
    const row = db.prepare('SELECT pass FROM users WHERE login=?').get(u.login);
    if (!store.checkPass(String(b.old || ''), row.pass)) throw new HttpError(400, 'Текущий пароль неверный');
    const pp = store.passProblem(b.new); if (pp) throw new HttpError(400, pp);
    db.prepare('UPDATE users SET pass=?, must_change=0 WHERE login=?').run(store.hashPass(b.new), u.login);
    db.prepare('DELETE FROM sessions WHERE login=? AND token_hash<>?').run(u.login, u.tokenHash);
    store.audit(db, u.login, u.ip, 'password.change'); return { ok: true };
  },

  'GET /api/records': (req, url) => { const u = auth(req); return store.getRecords(db, u, Math.max(0, parseInt(url.searchParams.get('since') || '0', 10) || 0)); },
  'POST /api/records': async req => {
    const u = auth(req); const b = await readJson(req);
    if (!Array.isArray(b.records)) throw new HttpError(400, 'Нужен список records');
    if (b.records.length > 2000) throw new HttpError(413, 'Не больше 2000 записей за раз');
    const results = store.putRecords(db, b.records, u);
    return { results, rev: +db.prepare(`SELECT v FROM meta WHERE k='rev'`).get().v };
  },
  'GET /api/conflicts': req => { need(auth(req), 'otos', 'admin'); return { conflicts: db.prepare('SELECT n, record_id, login, at, data FROM conflicts ORDER BY n DESC LIMIT 200').all().map(c => ({ ...c, data: JSON.parse(c.data) })) }; },

  'GET /api/staff': req => { auth(req); const r = db.prepare('SELECT data, updated, login FROM staff WHERE k=1').get(); return r ? { staff: JSON.parse(r.data), updated: r.updated, by: r.login } : { staff: [], updated: null }; },
  'PUT /api/staff': async req => {
    const u = auth(req); need(u, 'otos', 'admin'); const b = await readJson(req);
    if (!Array.isArray(b.staff)) throw new HttpError(400, 'Нужен список staff');
    const list = b.staff.filter(s => s && s.fio).map(s => ({ id: String(s.id || crypto.randomUUID()), fio: String(s.fio), iin: String(s.iin || ''), tab: String(s.tab || ''), birthYear: String(s.birthYear || ''), position: String(s.position || ''), unit: String(s.unit || ''), ...(s.place ? { place: String(s.place) } : {}), ...(s.cat ? { cat: String(s.cat) } : {}) }));
    db.prepare('INSERT INTO staff(k,data,updated,login) VALUES(1,?,?,?) ON CONFLICT(k) DO UPDATE SET data=excluded.data, updated=excluded.updated, login=excluded.login').run(JSON.stringify(list), store.now(), u.login);
    store.audit(db, u.login, u.ip, 'staff.put', list.length); return { ok: true, count: list.length };
  },

  // настройки журнала ЭЖИ для телефонов: реквизиты, реестр журналов, программы (без ПДн)
  'GET /api/config': req => { auth(req); const r = db.prepare(`SELECT v FROM meta WHERE k='config'`).get(); return r ? JSON.parse(r.v) : { config: null }; },
  'PUT /api/config': async req => {
    const u = auth(req); need(u, 'otos', 'admin'); const b = await readJson(req);
    if (!b || typeof b.config !== 'object' || Array.isArray(b.config)) throw new HttpError(400, 'Нужен объект config');
    const v = JSON.stringify({ config: b.config, updated: store.now(), by: u.login });
    if (v.length > 2 * 1024 * 1024) throw new HttpError(413, 'Слишком большие настройки');
    db.prepare(`INSERT INTO meta(k,v) VALUES('config',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(v);
    store.audit(db, u.login, u.ip, 'config.put'); return { ok: true };
  },

  'GET /api/users': req => { need(auth(req), 'admin'); return { users: db.prepare('SELECT login, fio, role, unit, active, created, must_change FROM users ORDER BY role, login').all() }; },
  'POST /api/users': async req => {
    const u = auth(req); need(u, 'admin'); const b = await readJson(req);
    const login = String(b.login || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(login)) throw new HttpError(400, 'Логин: 3–40 латинских букв, цифр, точек, дефисов');
    if (!store.ROLES.includes(b.role)) throw new HttpError(400, 'Роль: instructor, otos или admin');
    if (db.prepare('SELECT 1 FROM users WHERE login=?').get(login)) throw new HttpError(409, 'Такой логин уже есть');
    const pass = store.genPass();
    db.prepare('INSERT INTO users(login,fio,role,unit,pass,created) VALUES(?,?,?,?,?,?)').run(login, String(b.fio || '').slice(0, 200), b.role, String(b.unit || '').slice(0, 200), store.hashPass(pass), store.now());
    store.audit(db, u.login, u.ip, 'user.add', `${login} ${b.role}`); return { login, password: pass };
  },
  'POST /api/users/update': async req => {
    const u = auth(req); need(u, 'admin'); const b = await readJson(req);
    const row = db.prepare('SELECT * FROM users WHERE login=?').get(String(b.login || '')); if (!row) throw new HttpError(404, 'Нет такого пользователя');
    if (b.role !== undefined && !store.ROLES.includes(b.role)) throw new HttpError(400, 'Неверная роль');
    if (row.login === u.login && (b.active === false || (b.role && b.role !== 'admin'))) throw new HttpError(400, 'Нельзя отключить или понизить самого себя');
    let pass;
    if (b.resetPassword) { pass = store.genPass(); db.prepare('UPDATE users SET pass=?, must_change=1 WHERE login=?').run(store.hashPass(pass), row.login); }
    db.prepare('UPDATE users SET fio=?, role=?, unit=?, active=? WHERE login=?').run(b.fio !== undefined ? String(b.fio) : row.fio, b.role || row.role, b.unit !== undefined ? String(b.unit) : row.unit, b.active === undefined ? row.active : (b.active ? 1 : 0), row.login);
    if (b.resetPassword || b.active === false) db.prepare('DELETE FROM sessions WHERE login=?').run(row.login);
    store.audit(db, u.login, u.ip, 'user.update', `${row.login} ${JSON.stringify({ ...b, login: undefined })}`);
    return pass ? { ok: true, password: pass } : { ok: true };
  },
  'GET /api/audit': (req, url) => { need(auth(req), 'admin'); const n = Math.min(1000, +url.searchParams.get('limit') || 200); return { audit: db.prepare('SELECT * FROM audit ORDER BY n DESC LIMIT ?').all(n) }; },
  'GET /api/stats': req => { need(auth(req), 'admin', 'otos'); return { records: db.prepare('SELECT COUNT(*) n, SUM(closed) closed FROM records').get(), users: db.prepare('SELECT role, COUNT(*) n FROM users WHERE active=1 GROUP BY role').all(), backups: listBackups().slice(0, 5) }; },
  'POST /api/backup': req => { const u = auth(req); need(u, 'admin'); const f = store.backup(db, CFG.backupDir, CFG.backupKeepDays); store.audit(db, u.login, u.ip, 'backup', path.basename(f)); return { ok: true, file: path.basename(f) }; },
};
const listBackups = () => { try { return fs.readdirSync(CFG.backupDir).filter(f => /^journal-.*\.sqlite$/.test(f)).sort().reverse().map(f => ({ file: f, size: fs.statSync(path.join(CFG.backupDir, f)).size })); } catch (e) { return []; } };

/* ---------- статика ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
const serveStatic = (req, res, pathname) => {
  let base = CFG.publicDir, rel = pathname;
  if (pathname === '/admin' || pathname === '/journal') { res.writeHead(301, { Location: pathname + '/' }); return res.end(); }
  if (pathname.startsWith('/admin/')) { base = CFG.adminDir; rel = pathname.slice(6); }
  if (rel.endsWith('/')) rel += 'index.html';
  let decoded; try { decoded = decodeURIComponent(rel); } catch (e) { return send(res, 400, { error: 'Неверный адрес' }); }
  const segs = decoded.split('/').filter(Boolean);
  if (segs.some(s => s.startsWith('.') || s === 'server' || s === 'node_modules' || s.includes('\\'))) return send(res, 404, { error: 'Не найдено' });
  const file = path.join(base, ...segs); const ext = path.extname(file);
  if (!file.startsWith(base) || !TYPES[ext]) return send(res, 404, { error: 'Не найдено' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'Не найдено' });
    res.writeHead(200, { 'Content-Type': TYPES[ext], 'Content-Length': st.size, 'Cache-Control': 'no-cache', ...SEC, ...(pathname.startsWith('/admin/') ? {} : { 'X-Frame-Options': 'SAMEORIGIN' }) });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      cors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      const h = routes[`${req.method} ${url.pathname}`];
      if (!h) throw new HttpError(404, 'Нет такого метода API');
      const out = await h(req, url);
      return send(res, 200, out);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Метод не поддерживается');
    serveStatic(req, res, url.pathname);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { error: e.message, ...(e.extra || {}) });
    log('ERROR', req.method, url.pathname, e && e.stack || e);
    send(res, 500, { error: 'Внутренняя ошибка сервера' });
  }
});

/* ---------- ежедневная резервная копия ---------- */
let lastBackupDay = '';
const backupTick = () => {
  const d = new Date(); const day = d.toLocaleDateString('sv-SE');
  if (d.getHours() === CFG.backupHour && day !== lastBackupDay) {
    lastBackupDay = day;
    try { const f = store.backup(db, CFG.backupDir, CFG.backupKeepDays); store.audit(db, null, null, 'backup', path.basename(f)); log('Резервная копия:', f); }
    catch (e) { log('ОШИБКА резервной копии:', e.message); }
  }
  db.prepare('DELETE FROM sessions WHERE expires<?').run(store.now());
};

if (require.main === module) {
  server.listen(CFG.port, CFG.host, () => {
    log(`Журнал инструктажей v${VERSION}: http://${CFG.host}:${CFG.port}, БД ${CFG.dbFile}`);
    if (!db.prepare(`SELECT 1 FROM users WHERE role='admin' AND active=1`).get()) log('Администратора нет. Создайте: node cli.js create-admin <логин>');
  });
  setInterval(backupTick, 60000).unref(); backupTick();
  const stop = () => { server.close(); try { db.close(); } catch (e) { } process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
module.exports = { server, db, CFG };
