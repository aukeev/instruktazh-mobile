/* Проверка API: node --test server/test/ */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-'));
process.env.DB_FILE = path.join(dir, 'db.sqlite');
process.env.BACKUP_DIR = path.join(dir, 'bk');
const { server, db } = require('../server');
const store = require('../store');

let base;
const call = async (method, p, body, token, origin) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(origin ? { Origin: origin } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};
const mkUser = (login, role) => { const pass = 'pass-' + login + '-123'; db.prepare('INSERT INTO users(login,fio,role,unit,pass,created,must_change) VALUES(?,?,?,?,?,?,0)').run(login, login.toUpperCase(), role, '', store.hashPass(pass), store.now()); return pass; };
const login = async (l, p) => (await call('POST', '/api/login', { login: l, password: p })).body.token;
const rec = (id, closed, sigAt = '2026-11-24T10:00:00.000Z') => ({ id, created: '2026-11-24T09:00:00.000Z', unit: 'ГНПС «Атасу»', date: '2026-11-24', type: 'Повторный', reason: '', instructions: 'ИОТ-01',
  instructor: { fio: 'Инструктор И.И.', position: 'мастер', iin: '' }, source: 'mobile',
  workers: [{ id: 'w1', fio: 'Иванов Иван', iin: '', birthYear: '', profession: 'оператор', knowledge: true, sid: '', sig: { demo: false, cms: 'MIIB', signer: { cn: 'ИВАНОВ', gn: 'ИВАН', iin: '900101300123' }, at: sigAt, check: 'name', doc: 'текст' } }],
  instructorSig: closed ? { demo: false, cms: 'MIIC', signer: { cn: 'ИНСТРУКТОР' }, at: '2026-11-24T10:05:00.000Z', check: 'ok', doc: 'текст' } : null });

test.before(() => new Promise(ok => server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; ok(); })));
test.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('вход, смена временного пароля, роли', async () => {
  assert.equal((await call('GET', '/api/health')).body.ok, true);
  assert.equal((await call('GET', '/api/records')).status, 401);
  db.prepare('INSERT INTO users(login,fio,role,unit,pass,created) VALUES(?,?,?,?,?,?)').run('admin', 'Админ', 'admin', '', store.hashPass('temp-pass-1'), store.now());
  assert.equal((await call('POST', '/api/login', { login: 'admin', password: 'wrong' })).status, 401);
  const r1 = await call('POST', '/api/login', { login: 'admin', password: 'temp-pass-1' });
  assert.equal(r1.status, 403); assert.equal(r1.body.mustChange, true);
  const r2 = await call('POST', '/api/login', { login: 'ADMIN', password: 'temp-pass-1', newPassword: 'my-new-pass-1' });
  assert.equal(r2.status, 200); assert.ok(r2.body.token);
  const tok = r2.body.token;
  const cu = await call('POST', '/api/users', { login: 'ivanov', fio: 'Иванов', role: 'instructor' }, tok);
  assert.equal(cu.status, 200); assert.ok(cu.body.password.length >= 8);
  assert.equal((await call('POST', '/api/users', { login: 'ivanov', role: 'instructor' }, tok)).status, 409);
  const ti = (await call('POST', '/api/login', { login: 'ivanov', password: cu.body.password, newPassword: 'ivanov-pass-1' })).body.token;
  assert.equal((await call('GET', '/api/users', null, ti)).status, 403);
  assert.equal((await call('PUT', '/api/staff', { staff: [] }, ti)).status, 403);
  assert.equal((await call('GET', '/api/me', null, ti)).body.user.role, 'instructor');
  await call('POST', '/api/logout', null, ti);
  assert.equal((await call('GET', '/api/me', null, ti)).status, 401);
});

test('блокировка после 10 неудачных попыток', async () => {
  mkUser('victim', 'instructor');
  for (let i = 0; i < 10; i++) await call('POST', '/api/login', { login: 'victim', password: 'x' });
  assert.equal((await call('POST', '/api/login', { login: 'victim', password: 'pass-victim-123' })).status, 429);
});

test('записи: добавление, объединение, конфликт, видимость', async () => {
  const ta = await login('petrov', mkUser('petrov', 'instructor'));
  const tb = await login('sidorov', mkUser('sidorov', 'instructor'));
  const to = await login('otos1', mkUser('otos1', 'otos'));
  let r = await call('POST', '/api/records', { records: [rec('r1', true), rec('r2', false), { bad: 1 }] }, ta);
  assert.deepEqual(r.body.results.map(x => x.status), ['added', 'added', 'invalid']);
  // повтор той же закрытой записи — без изменений
  r = await call('POST', '/api/records', { records: [rec('r1', true)] }, ta);
  assert.equal(r.body.results[0].status, 'same');
  // другая версия закрытой записи — конфликт, исходник не меняется
  const alt = rec('r1', true); alt.instructions = 'подмена';
  r = await call('POST', '/api/records', { records: [alt] }, to);
  assert.equal(r.body.results[0].status, 'conflict');
  assert.equal((await call('GET', '/api/conflicts', null, to)).body.conflicts.length, 1);
  // черновик дописывается подписью, прежняя уходит в sigHistory
  r = await call('POST', '/api/records', { records: [rec('r2', false, '2026-11-24T11:00:00.000Z')] }, ta);
  assert.equal(r.body.results[0].status, 'updated');
  // чужую запись инструктор менять не может
  r = await call('POST', '/api/records', { records: [rec('r2', true)] }, tb);
  assert.equal(r.body.results[0].status, 'forbidden');
  // закрытие черновика
  r = await call('POST', '/api/records', { records: [rec('r2', true)] }, ta);
  assert.equal(r.body.results[0].status, 'updated');
  // видимость
  assert.equal((await call('GET', '/api/records', null, tb)).body.records.length, 0);
  const own = await call('GET', '/api/records', null, ta);
  assert.equal(own.body.records.length, 2);
  const all = await call('GET', '/api/records', null, to);
  assert.equal(all.body.records.length, 2);
  const r2 = all.body.records.find(x => x.id === 'r2');
  assert.equal(r2.workers[0].sigHistory.length, 1);
  // инкрементальная загрузка
  assert.equal((await call('GET', '/api/records?since=' + all.body.rev, null, to)).body.records.length, 0);
});

test('список персонала и CORS', async () => {
  const to = await login('otos2', mkUser('otos2', 'otos'));
  const ti = await login('instr9', mkUser('instr9', 'instructor'));
  assert.equal((await call('PUT', '/api/staff', { staff: [{ fio: 'Иванов Иван', iin: '900101300123', unit: 'ГНПС «Атасу»' }, { x: 1 }] }, to)).body.count, 1);
  const s = await call('GET', '/api/staff', null, ti);
  assert.equal(s.body.staff[0].fio, 'Иванов Иван');
  assert.equal((await call('PUT', '/api/config', { config: { x: 1 } }, ti)).status, 403);
  assert.equal((await call('GET', '/api/config', null, ti)).body.config, null);
  assert.equal((await call('PUT', '/api/config', { config: { ezhi: { journals: [{ id: 'j1' }] } } }, to)).body.ok, true);
  assert.equal((await call('GET', '/api/config', null, ti)).body.config.ezhi.journals[0].id, 'j1');
  const c = await call('GET', '/api/health', null, null, 'https://aukeev.github.io');
  assert.equal(c.headers.get('access-control-allow-origin'), 'https://aukeev.github.io');
  const c2 = await call('GET', '/api/health', null, null, 'https://evil.example');
  assert.equal(c2.headers.get('access-control-allow-origin'), null);
});

test('статика не отдает файлы сервера', async () => {
  for (const p of ['/server/store.js', '/.git/config', '/%2e%2e/etc/passwd', '/server%2fstore.js']) assert.equal((await fetch(base + p)).status, 404, p);
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/admin/')).status, 200);
});

test('резервная копия открывается и содержит записи', async () => {
  const f = store.backup(db, process.env.BACKUP_DIR, 30);
  const { DatabaseSync } = require('node:sqlite');
  const b = new DatabaseSync(f, { readOnly: true });
  assert.ok(b.prepare('SELECT COUNT(*) n FROM records').get().n >= 2); b.close();
});
