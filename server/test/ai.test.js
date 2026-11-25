/* Проверка ИИ-помощника: обезличивание, тестовый режим, вызов ИИ через подставной сервер Anthropic.
   Настоящий ИИ не вызывается: ANTHROPIC_BASE_URL указывает на локальную заглушку, которая
   записывает, что ей прислали, и проверяет, что ФИО и ИИН до нее не дошли. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-ai-'));
process.env.DB_FILE = path.join(dir, 'db.sqlite');
process.env.BACKUP_DIR = path.join(dir, 'bk');
delete process.env.ANTHROPIC_API_KEY;
const core = require('../../ai/core');
const demo = require('../../ai/demo-data');
const { server, db } = require('../server');
const store = require('../store');

let base, token, fake, fakeBase, lastBody = null, reply = 'Просрочен: Работник-2 и Работнику-8.';
const call = async (method, p, body, tok = token) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// заглушка API Anthropic: потоковый ответ (SSE) с текстом из reply
const sse = (res, ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
function fakeAnthropic(req, res) {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    lastBody = { path: req.url, headers: req.headers, json: JSON.parse(b) };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const model = lastBody.json.model;
    sse(res, 'message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end();
  });
}

test.before(async () => {
  await new Promise(ok => server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; ok(); }));
  fake = http.createServer(fakeAnthropic);
  await new Promise(ok => fake.listen(0, '127.0.0.1', () => { fakeBase = 'http://127.0.0.1:' + fake.address().port; ok(); }));
  db.prepare('INSERT INTO users(login,fio,role,unit,pass,created,must_change) VALUES(?,?,?,?,?,?,0)').run('otos', 'ОТОС', 'otos', '', store.hashPass('pass-otos-123'), store.now());
  token = (await call('POST', '/api/login', { login: 'otos', password: 'pass-otos-123' }, null)).body.token;
});
test.after(() => { server.close(); fake.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('обезличивание: ФИО и ИИН заменяются кодами и возвращаются в ответе', () => {
  const ctx = { today: '2026-11-25', people: [
    { iin: '900101300123', fio: 'Иванов Пётр Сергеевич', pos: 'Оператор', section: 'ГНПС «Атасу»', state: 'over' },
    { iin: '910202400456', fio: 'Петрова Анна Ивановна', pos: 'Лаборант', section: 'ГНПС «Атасу»', state: 'ok' },
    { iin: '', fio: 'Ким Олег Ли', pos: 'Мастер', section: 'НПС' }],
    records: [{ no: '1', date: '2026-11-01', kind: 'povt', person: { iin: '900101300123', fio: 'Иванов Пётр Сергеевич' }, instr: { iin: '', fio: 'Ким Олег Ли' }, topic: 'Проводил Ким О.Л. для Иванова П.С.' }] };
  const p = core.pseudonymize(ctx, 'Почему Иванову П. С. и Петровой не продлили? ИИН 910202400456, ещё 123456789012, спросить Ёлкина', [{ role: 'assistant', text: 'Иванов Пётр в списке' }]);
  const all = JSON.stringify({ d: p.data, q: p.question, h: p.history });
  for (const bad of ['Иванов', 'Петров', 'Ким', '900101300123', '910202400456', '123456789012']) assert.ok(!all.includes(bad), 'утечка: ' + bad + ' в ' + all);
  assert.deepEqual(p.leaks, []);
  assert.match(p.question, /Работник-1 и Работник-2 не продлили\? ИИН Работник-2, ещё \[ИИН скрыт\]/);
  assert.equal(p.data.records[0].person, 'Работник-1'); assert.equal(p.data.records[0].instr, 'Работник-3');
  assert.equal(p.data.records[0].topic, 'Проводил Работник-3 для Работник-1');
  assert.equal(p.pseudo.restore('Работник-1, Работнику‑2 и работника 3; Работник-99'), 'Иванов Пётр Сергеевич, Петрова Анна Ивановна и Ким Олег Ли; Работник-99');
});

test('проверка утечки ловит фамилию, оставшуюся в необрабатываемом поле', () => {
  const p = core.pseudonymize({ people: [{ iin: '900101300123', fio: 'Сидоренко Иван', pos: 'Помощник Сидоренко' }] }, 'вопрос');
  assert.ok(p.leaks.length > 0);
});

test('без ключа: тестовый режим на демо-данных', async () => {
  assert.equal((await call('POST', '/api/ai/chat', { question: 'кто' }, null)).status, 401);
  const st = await call('GET', '/api/ai/status'); assert.equal(st.body.mode, 'test');
  const r = await call('POST', '/api/ai/chat', { question: 'Кто на Атасу просрочил повторный?', demo: true });
  assert.equal(r.status, 200); assert.equal(r.body.mode, 'test'); assert.equal(r.body.demo, true);
  const people = demo.build().people;
  const over = people.filter(x => x.section === 'ГНПС «Атасу»' && x.state === 'over');
  assert.ok(over.length > 0);
  for (const x of over) assert.ok(r.body.answer.includes(x.fio), 'нет в ответе: ' + x.fio);
  const sent = JSON.stringify(r.body.sent);
  for (const x of people) { assert.ok(!sent.includes(x.fio.split(' ')[0]), 'ФИО в отправленном'); assert.ok(!sent.includes(x.iin), 'ИИН в отправленном'); }
  const pr = await call('POST', '/api/ai/chat', { question: 'Как часто проводить повторный инструктаж?', demo: true });
  assert.match(pr.body.answer, /8\.3\.25/);
});

test('с ключом: в Anthropic уходят только коды, ответ возвращается с ФИО', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real'; process.env.ANTHROPIC_BASE_URL = fakeBase;
  try {
    const ctx = demo.build('2026-11-25');
    const r = await call('POST', '/api/ai/chat', { question: `Что с ${ctx.people[1].fio.split(' ')[0]}ым? ИИН ${ctx.people[7].iin}`, context: ctx, history: [{ role: 'user', text: 'привет' }, { role: 'assistant', text: 'Здравствуйте' }] });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.mode, 'claude');
    assert.equal(r.body.answer, `Просрочен: ${ctx.people[1].fio} и ${ctx.people[7].fio}.`);
    const j = lastBody.json, raw = JSON.stringify(j);
    assert.match(lastBody.path, /^\/v1\/messages/);
    assert.equal(j.model, 'claude-opus-5-5'); assert.equal(j.stream, true); assert.equal(j.fallbacks, 'default');
    assert.match(String(lastBody.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
    for (const x of ctx.people.concat([{ fio: 'Кенжебаев Нурлан', iin: '780505300111' }])) {
      assert.ok(!raw.includes(x.fio.split(' ')[0]), 'фамилия ушла в ИИ: ' + x.fio);
      assert.ok(!raw.includes(x.iin), 'ИИН ушел в ИИ');
    }
    assert.ok(raw.includes('Работник-2')); assert.match(raw, /Правила № 1019/);
    assert.deepEqual(j.messages.map(m => m.role), ['user', 'assistant', 'user']);
    const audit = db.prepare(`SELECT detail FROM audit WHERE action='ai.ask' ORDER BY n DESC`).get();
    assert.match(audit.detail, /^claude q=\d+ people=31 in=100 out=20$/);
  } finally { delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_BASE_URL; }
});

test('вопрос с непойманными ПДн не отправляется', async () => {
  const ctx = { people: [{ iin: '900101300123', fio: 'Сидоренко Иван', pos: 'Помощник Сидоренко', section: 'А' }] };
  const r = await call('POST', '/api/ai/chat', { question: 'кто это', context: ctx });
  assert.equal(r.status, 422); assert.match(r.body.error, /не отправлен/);
});
