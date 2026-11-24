/* Инструктаж КарНУ: мобильное приложение инструктирующего.
   Формат записей совпадает с db.records журнала (Журнал_инструктажей_ЭЦП.html),
   выгрузка .json импортируется в журнал. */
'use strict';
const KEY = 'kto-instr-mobile-v1';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const fmtD = d => d ? d.split('-').reverse().join('.') : '';
const fmtDT = iso => { const d = new Date(iso); return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); };
const maskIIN = i => i ? ('ИИН ••••' + String(i).slice(-4)) : '';
const byFromIIN = i => { if (!/^\d{12}$/.test(i || '')) return ''; const c = { 1: 1800, 2: 1800, 3: 1900, 4: 1900, 5: 2000, 6: 2000 }[i[6]]; return c ? String(c + +i.slice(0, 2)) : ''; };
const normIIN = v => { let d = String(v ?? '').replace(/\D/g, ''); if (d.length === 11) d = '0' + d; return d; };
const iinValid = i => { if (!/^\d{12}$/.test(i || '')) return false; const d = [...i].map(Number); const sum = w => w.reduce((a, x, k) => a + x * d[k], 0) % 11; let c = sum([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]); if (c === 10) { c = sum([3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2]); if (c === 10) return false; } return c === d[11]; };
const normFio = s => String(s || '').trim().replace(/\s+/g, ' ');
const TYPES = ['Вводный', 'Первичный', 'Повторный', 'Внеплановый', 'Целевой'];
const needReason = t => t === 'Внеплановый' || t === 'Целевой';

/* ---------- хранение ---------- */
let db = { records: [], staff: [], settings: { instructor: { fio: '', position: '', iin: '' }, demo: false, pinHash: '', lastInstr: {} }, exported: {}, server: { url: '', token: '', user: null, synced: {}, rejected: {}, staffUpdated: '', lastOk: '', lastErr: '' } };
try { const s = localStorage.getItem(KEY); if (s) { const d = JSON.parse(s); db = { ...db, ...d, settings: { ...db.settings, ...(d.settings || {}) }, server: { ...db.server, ...(d.server || {}) } }; } } catch (e) { }
if (!db.server.url && location.protocol === 'https:' && !/github\.io$/.test(location.hostname)) db.server.url = location.origin;
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { toast('Не удалось сохранить. Выгрузите записи в файл.'); } };
const toast = t => { const el = $('#toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 3200); };
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });

/* ---------- PIN (защита от случайного просмотра, не шифрование) ---------- */
const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(x => x.toString(16).padStart(2, '0')).join('');
const lock = () => { if (!db.settings.pinHash) return; $('#lock').hidden = false; $('#pin-in').value = ''; setTimeout(() => $('#pin-in').focus(), 50); };
$('#pin-ok').addEventListener('click', async () => {
  if (await sha('kto:' + $('#pin-in').value) === db.settings.pinHash) { $('#lock').hidden = true; $('#pin-err').textContent = ''; }
  else $('#pin-err').textContent = 'Неверный PIN';
});
$('#pin-in').addEventListener('keydown', e => { if (e.key === 'Enter') $('#pin-ok').click(); });
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => { if (document.hidden) hiddenAt = Date.now(); else if (hiddenAt && Date.now() - hiddenAt > 120000) lock(); });

/* ---------- навигация ---------- */
let stack = [{ v: 'home' }];
const cur = () => stack[stack.length - 1];
const go = (v, p = {}) => { stack.push({ v, ...p }); history.pushState({ n: stack.length }, ''); render(); };
const back = () => { if (stack.length > 1) history.back(); };
window.addEventListener('popstate', () => { if (stack.length > 1) { cancelSign(); stack.pop(); render(); } });
$('#back').addEventListener('click', back);
$('#menu').addEventListener('click', () => go('settings'));

const setBar = html => { const b = $('#bar'); b.innerHTML = html || ''; b.hidden = !html; };
const render = () => {
  const s = cur();
  $('#back').hidden = stack.length <= 1;
  $('#menu').hidden = s.v !== 'home';
  $('#demo-flag').hidden = !db.settings.demo;
  const v0 = $('#view'); v0.replaceWith(v0.cloneNode(false));
  window.scrollTo(0, 0);
  (VIEWS[s.v] || VIEWS.home)(s);
};
const title = t => { $('#title').textContent = t; document.title = t + ' · Инструктаж КарНУ'; };

/* ---------- сверка подписанта ---------- */
const check = (person, signer) => {
  if (!signer.iin && !signer.cn) return 'warn';
  if (person.iin) return person.iin === signer.iin ? 'ok' : 'bad';
  const p = normFio(person.fio).toLowerCase().split(' ');
  const c = normFio(signer.cn).toLowerCase().split(' ');
  if (!p[0] || !c[0]) return 'warn';
  if (p[0] !== c[0]) return 'warn';
  return p[1] && c[1] && p[1] === c[1] ? 'name' : 'warn';
};
const CHECK_TXT = { ok: 'ИИН совпадает', name: 'сверено по фамилии и имени', warn: 'требует ручной сверки', bad: 'не совпадает с работником' };
const sigTag = s => !s ? '<span class="tag">не подписано</span>'
  : `<span class="tag ${s.demo ? 'warn' : s.check === 'ok' || s.check === 'name' ? 'ok' : s.check}">${s.demo ? 'демо, без ЭЦП' : 'ЭЦП: ' + esc(CHECK_TXT[s.check] || s.check)}</span>`;

/* ---------- тексты подписываемых документов (как в журнале) ---------- */
const head = r => ['АО «КазТрансОйл», Карагандинское нефтепроводное управление',
  (r.type === 'Вводный' ? 'ЖУРНАЛ РЕГИСТРАЦИИ ВВОДНОГО ИНСТРУКТАЖА (Прил. 16 к Правилам № 1019)' : 'ЖУРНАЛ РЕГИСТРАЦИИ ИНСТРУКТАЖЕЙ НА РАБОЧЕМ МЕСТЕ (Прил. 17 к Правилам № 1019)'),
  'Подразделение: ' + r.unit, 'Запись: ' + r.id, 'Дата инструктажа: ' + fmtD(r.date), 'Вид инструктажа: ' + r.type,
  r.reason ? 'Причина проведения: ' + r.reason : '', 'Инструкции: ' + r.instructions,
  'Инструктаж провел: ' + r.instructor.fio + (r.instructor.position ? ', ' + r.instructor.position : '')].filter(Boolean);
const workerDoc = (r, w) => [...head(r), '', 'Инструктируемый: ' + w.fio, w.birthYear ? 'Год рождения: ' + w.birthYear : '', w.profession ? 'Профессия, должность: ' + w.profession : '',
  'Проверка знаний: ' + (w.knowledge ? 'знания проверены' : 'не проводилась'), '',
  'Подписывая настоящий документ своей ЭЦП, подтверждаю, что инструктаж прошел, содержание инструкций мне понятно, обязуюсь их выполнять.'].join('\n');
const hex = async b64 => { try { const b = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const h = await crypto.subtle.digest('SHA-256', b); return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join(''); } catch (e) { return 'н/д'; } };
const instructorDoc = async r => {
  const lines = [...head(r), '', 'Список инструктируемых и их подписей (SHA-256 файла подписи):'];
  for (const [i, w] of r.workers.entries()) lines.push(`${i + 1}. ${w.fio}: ${w.sig ? (w.sig.demo ? 'демо' : await hex(w.sig.cms)) : 'не подписано'}`);
  lines.push('', 'Подписывая настоящий документ своей ЭЦП, подтверждаю проведение инструктажа указанным работникам.'); return lines.join('\n');
};

/* ---------- разбор CMS: кто подписал (как в журнале) ---------- */
const OIDS = { '2.5.4.3': 'cn', '2.5.4.4': 'surname', '2.5.4.42': 'gn', '2.5.4.5': 'serial', '2.5.4.10': 'o', '2.5.4.11': 'ou' };
const tlv = (b, p) => { const tag = b[p]; let len = b[p + 1], hl = 2; if (len === undefined) return null; if (len & 0x80) { const n = len & 0x7f; if (!n || n > 4) return null; len = 0; for (let i = 0; i < n; i++) len = len * 256 + b[p + 2 + i]; hl = 2 + n; } return { tag, s: p + hl, e: p + hl + len }; };
const kids = (b, s, e) => { const out = []; let p = s; while (p < e) { const t = tlv(b, p); if (!t || t.e > e) break; out.push(t); p = t.e; } return out; };
const oid = (b, t) => { const a = b.subarray(t.s, t.e); const r = [Math.floor(a[0] / 40), a[0] % 40]; let v = 0; for (let i = 1; i < a.length; i++) { v = v * 128 + (a[i] & 0x7f); if (!(a[i] & 0x80)) { r.push(v); v = 0; } } return r.join('.'); };
const str = (b, t) => { const a = b.subarray(t.s, t.e); if (t.tag === 0x0c) return new TextDecoder('utf-8').decode(a); if (t.tag === 0x1e) return new TextDecoder('utf-16be').decode(a); return String.fromCharCode(...a); };
const asTime = (b, t) => { const s = str(b, t); const y = t.tag === 0x17 ? (+s.slice(0, 2) < 50 ? 2000 : 1900) + +s.slice(0, 2) : +s.slice(0, 4); const o = t.tag === 0x17 ? 2 : 4; return new Date(Date.UTC(y, +s.slice(o, o + 2) - 1, +s.slice(o + 2, o + 4), +s.slice(o + 4, o + 6), +s.slice(o + 6, o + 8), +s.slice(o + 8, o + 10) || 0)).toISOString(); };
const parseCMS = b64 => {
  const b = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const names = []; let time = null;
  const walk = (s, e, d) => {
    if (d > 40) return; for (const t of kids(b, s, e)) {
      if (t.tag === 0x30) {
        const k = kids(b, t.s, t.e);
        if (k.length && k.every(x => x.tag === 0x31)) { const n = {}; for (const set of k) { const atv = kids(b, set.s, set.e)[0]; if (!atv || atv.tag !== 0x30) continue; const [o, v] = kids(b, atv.s, atv.e); if (o && o.tag === 0x06 && v) { const key = OIDS[oid(b, o)]; if (key) n[key] = str(b, v); } } if (Object.keys(n).length) names.push(n); }
        if (k[0] && k[0].tag === 0x06 && k[1] && k[1].tag === 0x31 && oid(b, k[0]) === '1.2.840.113549.1.9.5') { const tt = kids(b, k[1].s, k[1].e)[0]; if (tt && (tt.tag === 0x17 || tt.tag === 0x18)) try { time = asTime(b, tt); } catch (e) { } }
      }
      if (t.tag & 0x20) walk(t.s, t.e, d + 1);
    }
  };
  try { walk(0, b.length, 0); } catch (e) { }
  const n = names.find(x => /^IIN\d{12}$/.test(x.serial || '')) || {};
  return { cn: n.cn || '', gn: n.gn || '', iin: (n.serial || '').replace('IIN', ''), org: n.o || '', time };
};

/* ---------- подписание через SIGEX ---------- */
let token = 0;
const cancelSign = () => { token++; };
const sign = async (text, names, meta, person, ui) => {
  const my = ++token;
  if (db.settings.demo) {
    ui.status('Демо: имитация подписи...'); await new Promise(r => setTimeout(r, 900)); if (my !== token) return null;
    return { demo: true, cms: '', signer: { cn: person.fio.toUpperCase(), gn: '', iin: person.iin || '', time: null }, at: new Date().toISOString(), check: 'ok', doc: text };
  }
  const c = new QRSigningClientCMS('Журнал инструктажей КарНУ', true);
  await c.addDataToSign(names, new TextEncoder().encode(text).buffer, meta, false);
  ui.status('Регистрация процедуры подписания...');
  const qr = await c.registerQRSinging(); if (my !== token) return null;
  ui.qr(qr, c.getEGovMobileLaunchLink());
  const sigs = await c.getSignatures(() => { if (my !== token) return; ui.qr(null, null); ui.status('Данные переданы на телефон. Проверьте текст и подпишите в eGov Mobile.'); });
  if (my !== token) return null;
  const signer = parseCMS(sigs[0]);
  return { demo: false, cms: sigs[0], signer, at: new Date().toISOString(), check: check(person, signer), doc: text };
};
const failText = e => { const net = e && (e.message || '').includes('Не удалось получить ответа'); return (e.message || String(e)) + (e.details ? '\n' + e.details : '') + (net ? '\n\nНет связи с sigex.kz. Проверьте мобильный интернет.' : ''); };
const putSig = (holder, s) => { if (holder.sig) { holder.sigHistory = holder.sigHistory || []; holder.sigHistory.push({ ...holder.sig, replacedAt: new Date().toISOString() }); } holder.sig = s; };

/* ---------- статус записи ---------- */
const workerOk = w => w.sig && w.sig.check !== 'bad' && (db.settings.demo || !w.sig.demo);
const canClose = r => r.workers.length && r.workers.every(workerOk);
const recStatus = r => r.instructorSig ? (r.demo ? '<span class="tag warn">закрыта (демо)</span>' : '<span class="tag ok">закрыта</span>')
  : `<span class="tag">подписано ${r.workers.filter(w => w.sig).length} из ${r.workers.length}</span>`;

/* ---------- персонал ---------- */
const units = () => [...new Set(db.staff.map(s => s.unit).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
const parseCSV = text => {
  text = text.replace(/^﻿/, ''); const lines = text.split(/\r?\n/).filter(l => l.trim()); if (!lines.length) return [];
  const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  const split = l => { const out = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === sep) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map(x => x.trim()); };
  const hdr = split(lines[0]).map(h => h.toLowerCase());
  const col = (...ks) => hdr.findIndex(h => ks.some(k => h.includes(k)));
  const iF = col('фио', 'ф.и.о'), iI = col('иин'), iT = col('табель'), iP = col('должн', 'професс'), iU = col('подраздел');
  if (iF < 0) throw new Error('В файле нет столбца «ФИО»');
  return lines.slice(1).map(split).filter(r => r[iF]).map(r => {
    const iin = iI >= 0 ? normIIN(r[iI]) : '';
    return { id: uid(), fio: normFio(r[iF]), iin: iinValid(iin) ? iin : '', tab: iT >= 0 ? r[iT] : '', birthYear: byFromIIN(iin), position: iP >= 0 ? r[iP] : '', unit: iU >= 0 ? r[iU] : '' };
  });
};
const mergeStaff = list => {
  let add = 0, upd = 0;
  for (const s of list) {
    const m = db.staff.find(x => (s.iin && x.iin === s.iin) || (s.tab && x.tab === s.tab) || (x.fio.toLowerCase() === s.fio.toLowerCase() && x.unit === s.unit && !(x.tab && s.tab && x.tab !== s.tab)));
    if (m) { for (const k of ['iin', 'tab', 'birthYear', 'position', 'unit']) if (s[k] && !m[k]) m[k] = s[k]; upd++; } else { db.staff.push(s); add++; }
  }
  save(); return { add, upd };
};

/* ---------- выгрузка в журнал ---------- */
const download = (name, data, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800); };
const exportRecords = async (list, viaShare) => {
  if (!list.length) { toast('Нет записей для выгрузки'); return; }
  const data = JSON.stringify({ records: list, staff: [], source: 'mobile', exportedAt: new Date().toISOString() }, null, 1);
  const name = `инструктажи_телефон_${today()}_${list.length}.json`;
  if (viaShare && navigator.canShare) {
    const f = new File([data], name, { type: 'application/json' });
    if (navigator.canShare({ files: [f] })) { try { await navigator.share({ files: [f], title: name }); } catch (e) { if (e.name === 'AbortError') return; download(name, data, 'application/json'); } }
    else download(name, data, 'application/json');
  } else download(name, data, 'application/json');
  const t = new Date().toISOString(); list.forEach(r => { db.exported[r.id] = t; }); save();
  toast('Файл сформирован: ' + list.length + ' запис.');
};

/* ---------- общий сервер журнала: автоматическая отправка закрытых записей ----------
   Закрытая запись ставится в очередь; отправка при закрытии, при запуске, при появлении сети и раз в минуту.
   Демо-записи на сервер не отправляются. */
const srv = db.server;
const srvOn = () => !!(srv.url && srv.token);
const isSynced = r => !!srv.synced[r.id];
const queue = () => db.records.filter(r => r.instructorSig && !r.demo && !srv.synced[r.id] && !srv.rejected[r.id]);
const isOut = r => !!(db.exported[r.id] || srv.synced[r.id]);
const api = async (method, p, body) => {
  let res;
  try { res = await fetch(srv.url.replace(/\/+$/, '') + p, { method, headers: { 'Content-Type': 'application/json', ...(srv.token ? { Authorization: 'Bearer ' + srv.token } : {}) }, body: body ? JSON.stringify(body) : undefined }); }
  catch (e) { const er = new Error('Нет связи с сервером'); er.net = true; throw er; }
  const j = await res.json().catch(() => ({}));
  if (res.status === 401 && p !== '/api/login') { srv.token = ''; save(); }
  if (!res.ok) { const e = new Error(j.error || ('Ошибка сервера ' + res.status)); e.body = j; throw e; }
  return j;
};
let syncing = null;
const syncNow = (loud) => {
  if (!srvOn()) return Promise.resolve();
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      const list = queue();
      for (let i = 0; i < list.length; i += 20) {
        const part = list.slice(i, i + 20);
        const res = await api('POST', '/api/records', { records: part });
        const t = new Date().toISOString();
        for (const x of res.results) {
          if (['added', 'updated', 'same'].includes(x.status)) srv.synced[x.id] = t;
          else srv.rejected[x.id] = x.status;
        }
        save();
      }
      if (!srv.staffChecked || Date.now() - Date.parse(srv.staffChecked) > 6 * 3600000) await staffFromServer(false);
      srv.lastOk = new Date().toISOString(); srv.lastErr = ''; save();
      if (list.length) toast('На сервер отправлено записей: ' + list.length);
      else if (loud) toast('Очередь пуста, всё отправлено');
    } catch (e) {
      srv.lastErr = e.message; save();
      if (loud || !e.net) toast('Сервер: ' + e.message);
    } finally { syncing = null; if (['home', 'record'].includes(cur().v) || (loud && cur().v === 'settings')) render(); }
  })();
  return syncing;
};
const staffFromServer = async loud => {
  const j = await api('GET', '/api/staff');
  srv.staffChecked = new Date().toISOString();
  if (!j.staff.length) { if (loud) toast('На сервере списка персонала пока нет'); save(); return; }
  if (j.updated === srv.staffUpdated && !loud) { save(); return; }
  const r = mergeStaff(j.staff.filter(x => x && x.fio).map(x => ({ id: String(x.id || uid()), fio: normFio(x.fio), iin: String(x.iin || ''), tab: String(x.tab || ''), birthYear: String(x.birthYear || ''), position: String(x.position || ''), unit: String(x.unit || '') })));
  srv.staffUpdated = j.updated; save();
  toast(`Список персонала с сервера: добавлено ${r.add}, обновлено ${r.upd}`);
};
window.addEventListener('online', () => syncNow(false));
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(false); });
setInterval(() => { if (queue().length) syncNow(false); }, 60000);
const srvLine = r => {
  if (!r.instructorSig) return '';
  if (r.demo) return 'Демо-запись: на сервер не отправляется.';
  if (srv.synced[r.id]) return 'Отправлено на сервер ' + fmtDT(srv.synced[r.id]);
  if (srv.rejected[r.id]) return 'Сервер не принял запись (' + ({ conflict: 'на сервере другая версия', forbidden: 'запись другого инструктирующего', invalid: 'ошибка формата' }[srv.rejected[r.id]] || srv.rejected[r.id]) + '). Выгрузите файл и передайте инженеру ОТОС.';
  if (srvOn()) return 'Ждет отправки на сервер' + (srv.lastErr ? ' (' + srv.lastErr.toLowerCase() + ', повторим автоматически)' : '');
  return db.exported[r.id] ? 'Выгружено в файл ' + fmtDT(db.exported[r.id]) : 'Ещё не передано в журнал';
};

/* ================= ЭКРАНЫ ================= */
const VIEWS = {};

VIEWS.home = () => {
  title('Инструктажи');
  const ins = db.settings.instructor;
  let h = '';
  if (!ins.fio) h += `<div class="card"><h3>Начните с настроек</h3><div class="sub">Укажите свои ФИО и должность как инструктирующего и загрузите список персонала.</div><div style="margin-top:10px"><button class="btn block" data-go="settings">Открыть настройки</button></div></div>`;
  const notExp = db.records.filter(r => r.instructorSig && !isOut(r));
  const q = queue();
  if (srvOn() && q.length) h += `<div class="card"><h3>Ждут отправки на сервер: ${q.length}</h3><div class="sub">${srv.lastErr ? esc(srv.lastErr) + '. ' : ''}Отправятся сами, когда появится интернет.</div><div class="row" style="margin-top:10px"><button class="btn" id="sync-now" style="flex:1">Отправить сейчас</button></div></div>`;
  else if (!srvOn() && notExp.length) h += `<div class="card"><h3>Не выгружено в журнал: ${notExp.length}</h3><div class="sub">Закрытые записи нужно передать в журнал на компьютере. Чтобы они уходили сами, войдите на общий сервер в настройках.</div><div class="row" style="margin-top:10px"><button class="btn" id="exp-new" style="flex:1">Выгрузить</button></div></div>`;
  if (!db.records.length) h += `<div class="empty">Записей пока нет.<br>Нажмите «Новый инструктаж».</div>`;
  else h += `<div class="card"><ul class="list">${db.records.map(r => `<li data-rec="${esc(r.id)}"><div class="grow"><b>${esc(fmtD(r.date))}, ${esc(r.type.toLowerCase())}</b><div class="sub">${esc(r.unit)} · ${r.workers.length} чел.${r.instructorSig && srvOn() && !r.demo ? (isSynced(r) ? ' · на сервере' : ' · ждет отправки') : ''}</div></div>${recStatus(r)}</li>`).join('')}</ul></div>`;
  $('#view').innerHTML = h;
  setBar(`<button class="btn" id="new-btn">＋ Новый инструктаж</button>`);
  $('#new-btn').onclick = () => { if (!db.settings.instructor.fio) { toast('Сначала укажите свои ФИО в настройках'); go('settings'); return; } go('new', { draft: null }); };
  const eb = $('#exp-new'); if (eb) eb.onclick = () => exportRecords(notExp, true);
  const sb = $('#sync-now'); if (sb) sb.onclick = () => { sb.disabled = true; sb.textContent = 'Отправка...'; syncNow(true); };
};

VIEWS.new = s => {
  title('Новый инструктаж');
  const d = s.draft || (s.draft = { unit: db.settings.lastUnit || '', date: today(), type: 'Первичный', reason: '', instructions: '', sel: [], extra: [] });
  const ul = units();
  $('#view').innerHTML = `<div class="card">
    <label for="f-unit">Подразделение</label><input id="f-unit" list="u-list" value="${esc(d.unit)}"><datalist id="u-list">${ul.map(u => `<option value="${esc(u)}">`).join('')}</datalist>
    <label for="f-type">Вид инструктажа</label><select id="f-type">${TYPES.map(t => `<option ${t === d.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <div id="reason-box"><label for="f-reason">Причина проведения</label><input id="f-reason" value="${esc(d.reason)}"></div>
    <label for="f-date">Дата</label><input id="f-date" type="date" value="${esc(d.date)}">
    <label for="f-instr">Инструкции (номера и названия)</label><textarea id="f-instr">${esc(d.instructions)}</textarea>
    <div class="note">Инструктирующий: ${esc(db.settings.instructor.fio)}${db.settings.instructor.position ? ', ' + esc(db.settings.instructor.position) : ''}</div></div>
    <div class="err" id="f-err"></div>`;
  const sync = () => { d.unit = $('#f-unit').value.trim(); d.type = $('#f-type').value; d.reason = $('#f-reason').value.trim(); d.date = $('#f-date').value; d.instructions = $('#f-instr').value.trim(); $('#reason-box').hidden = !needReason(d.type); };
  $('#view').addEventListener('input', sync); $('#view').addEventListener('change', sync); sync();
  $('#f-unit').addEventListener('change', () => { const li = db.settings.lastInstr[d.unit]; if (li && !$('#f-instr').value.trim()) { $('#f-instr').value = li; sync(); } });
  if (!d.instructions && db.settings.lastInstr[d.unit]) { $('#f-instr').value = db.settings.lastInstr[d.unit]; sync(); }
  setBar(`<button class="btn" id="next">Далее: кто присутствует →</button>`);
  $('#next').onclick = () => {
    sync(); const miss = [];
    if (!d.unit) miss.push('подразделение'); if (!d.date) miss.push('дата'); if (!d.instructions) miss.push('инструкции'); if (needReason(d.type) && !d.reason) miss.push('причина');
    if (miss.length) { $('#f-err').textContent = 'Заполните: ' + miss.join(', '); return; }
    go('pick', { draft: d, unit: ul.includes(d.unit) ? d.unit : '', q: '' });
  };
};

VIEWS.pick = s => {
  const d = s.draft; title('Кто присутствует');
  const ul = units();
  const draw = () => {
    const q = s.q.toLowerCase();
    const shown = db.staff.filter(x => (!s.unit || x.unit === s.unit) && (!q || x.fio.toLowerCase().includes(q) || (x.tab || '').includes(q)));
    const selSet = new Set(d.sel);
    $('#plist').innerHTML = shown.length ? shown.slice(0, 300).map(x => `<li><input type="checkbox" data-sid="${esc(x.id)}" ${selSet.has(x.id) ? 'checked' : ''} aria-label="${esc(x.fio)}"><label class="grow" data-for="${esc(x.id)}" style="margin:0;color:var(--ink);font-size:16px"><b>${esc(x.fio)}</b><div class="sub">${esc([x.position, x.tab ? 'таб. ' + x.tab : ''].filter(Boolean).join(', '))}</div></label></li>`).join('')
      : `<li class="empty">${db.staff.length ? 'Никого не найдено' : 'Список персонала не загружен. Добавьте людей вручную или загрузите штатку в настройках.'}</li>`;
    $('#extra').innerHTML = d.extra.map((x, i) => `<li><div class="grow"><b>${esc(x.fio)}</b><div class="sub">${esc([x.position, maskIIN(x.iin)].filter(Boolean).join(', '))}</div></div><button class="btn ghost" data-rm="${i}" aria-label="Убрать">✕</button></li>`).join('');
    $('#cnt').textContent = d.sel.length + d.extra.length;
  };
  $('#view').innerHTML = `
    <div class="card"><label for="p-unit" style="margin-top:0">Подразделение</label><select id="p-unit"><option value="">Все (${db.staff.length})</option>${ul.map(u => `<option value="${esc(u)}" ${u === s.unit ? 'selected' : ''}>${esc(u)} (${db.staff.filter(x => x.unit === u).length})</option>`).join('')}</select>
    <label for="p-q">Поиск по ФИО или табельному номеру</label><input id="p-q" type="search" value="${esc(s.q)}">
    <div class="row" style="margin-top:10px"><button class="btn ghost" id="all" style="flex:1">Отметить всех</button><button class="btn ghost" id="none" style="flex:1">Снять</button></div></div>
    <div class="card"><ul class="list" id="plist"></ul></div>
    <div class="card"><h3>Нет в списке</h3><ul class="list" id="extra"></ul>
      <label for="x-fio">ФИО</label><input id="x-fio" autocomplete="off">
      <label for="x-pos">Должность</label><input id="x-pos">
      <label for="x-iin">ИИН (если известен)</label><input id="x-iin" inputmode="numeric" maxlength="12">
      <div style="margin-top:10px"><button class="btn ghost block" id="x-add">Добавить человека</button></div>
      <div class="note">Если ИИН не указан, он будет взят из сертификата ЭЦП при подписи.</div></div>
    <div class="err" id="p-err"></div>`;
  setBar(`<button class="btn" id="create"><span>Создать запись (<span id="cnt">0</span>)</span></button>`);
  draw();
  $('#p-unit').onchange = e => { s.unit = e.target.value; draw(); };
  $('#p-q').oninput = e => { s.q = e.target.value; draw(); };
  $('#plist').addEventListener('change', e => { const id = e.target.dataset.sid; if (!id) return; if (e.target.checked) { if (!d.sel.includes(id)) d.sel.push(id); } else d.sel = d.sel.filter(x => x !== id); $('#cnt').textContent = d.sel.length + d.extra.length; });
  $('#plist').addEventListener('click', e => { const l = e.target.closest('[data-for]'); if (!l) return; const cb = $(`[data-sid="${CSS.escape(l.dataset.for)}"]`); cb.checked = !cb.checked; cb.dispatchEvent(new Event('change', { bubbles: true })); });
  $('#all').onclick = () => { document.querySelectorAll('#plist [data-sid]').forEach(cb => { if (!d.sel.includes(cb.dataset.sid)) d.sel.push(cb.dataset.sid); }); draw(); };
  $('#none').onclick = () => { d.sel = []; draw(); };
  $('#extra').addEventListener('click', e => { const i = e.target.dataset.rm; if (i !== undefined) { d.extra.splice(+i, 1); draw(); } });
  $('#x-add').onclick = () => {
    const fio = normFio($('#x-fio').value), iin = normIIN($('#x-iin').value);
    if (!fio) { $('#p-err').textContent = 'Укажите ФИО'; return; }
    if (iin && !iinValid(iin)) { $('#p-err').textContent = 'ИИН неверный: должен быть из 12 цифр с правильной контрольной цифрой'; return; }
    d.extra.push({ fio, position: $('#x-pos').value.trim(), iin }); $('#p-err').textContent = '';
    $('#x-fio').value = $('#x-pos').value = $('#x-iin').value = ''; draw();
  };
  $('#create').onclick = () => {
    const people = [...d.sel.map(id => db.staff.find(x => x.id === id)).filter(Boolean).map(x => ({ fio: x.fio, iin: x.iin, birthYear: x.birthYear || byFromIIN(x.iin), profession: x.position, sid: x.id })),
      ...d.extra.map(x => ({ fio: x.fio, iin: x.iin, birthYear: byFromIIN(x.iin), profession: x.position, sid: '' }))];
    if (!people.length) { $('#p-err').textContent = 'Отметьте хотя бы одного работника'; return; }
    const ins = db.settings.instructor;
    const r = { id: uid(), created: new Date().toISOString(), unit: d.unit, date: d.date, type: d.type, reason: needReason(d.type) ? d.reason : '', instructions: d.instructions,
      instructor: { fio: ins.fio, position: ins.position, iin: ins.iin }, workers: people.map(p => ({ id: uid(), knowledge: true, sig: null, ...p })), instructorSig: null, source: 'mobile' };
    db.records.unshift(r); db.settings.lastUnit = d.unit; db.settings.lastInstr[d.unit] = d.instructions; save();
    stack = [{ v: 'home' }, { v: 'record', id: r.id }]; history.replaceState({ n: 2 }, ''); render();
    toast('Запись создана. Работники подписывают по очереди.');
  };
};

VIEWS.record = s => {
  const r = db.records.find(x => x.id === s.id); if (!r) { stack = [{ v: 'home' }]; render(); return; }
  title(fmtD(r.date) + ', ' + r.type.toLowerCase());
  const closed = !!r.instructorSig;
  const nextW = r.workers.find(w => !w.sig);
  $('#view').innerHTML = `<div class="card"><h3>${esc(r.unit)}</h3><div class="sub">${esc(r.instructions)}</div>${r.reason ? `<div class="sub">Причина: ${esc(r.reason)}</div>` : ''}<div class="sub">Провел: ${esc(r.instructor.fio)}</div><div style="margin-top:6px">${recStatus(r)}</div></div>
    <div class="card"><ul class="list">${r.workers.map(w => `<li><div class="grow"><b>${esc(w.fio)}</b><div class="sub">${esc(w.profession || '')}${w.sig && w.sig.signer && w.sig.signer.cn ? '<br>Подписал: ' + esc(w.sig.signer.cn + ' ' + w.sig.signer.gn) + ' ' + esc(maskIIN(w.sig.signer.iin)) : ''}</div>${sigTag(w.sig)}
      ${closed ? '' : `<label class="row" style="margin:6px 0 0;color:var(--ink);font-size:14px"><input type="checkbox" data-kn="${esc(w.id)}" ${w.knowledge ? 'checked' : ''} ${w.sig ? 'disabled' : ''} style="width:22px;min-height:22px;height:22px"> знания проверены</label>`}</div>
      ${closed ? '' : w.sig && workerOk(w) ? '' : `<button class="btn ${w.sig ? 'ghost' : ''}" data-sw="${esc(w.id)}">${w.sig ? 'Заново' : 'Подписать'}</button>`}</li>`).join('')}</ul></div>
    ${closed ? `<div class="card"><h3>Запись закрыта</h3><div class="sub">Подпись инструктирующего: ${esc(r.instructorSig.signer.cn || r.instructor.fio)}, ${esc(fmtDT(r.instructorSig.signer.time || r.instructorSig.at))}</div><div class="sub">${esc(srvLine(r))}</div></div>` : ''}
    ${!closed && !r.workers.some(w => w.sig) ? `<button class="btn danger block" id="del">Удалить черновик</button>` : ''}`;
  $('#view').addEventListener('change', e => { const id = e.target.dataset.kn; if (!id) return; const w = r.workers.find(x => x.id === id); w.knowledge = e.target.checked; save(); });
  $('#view').addEventListener('click', e => { const id = e.target.dataset.sw; if (id) go('sign', { id: r.id, wid: id }); });
  const del = $('#del'); if (del) del.onclick = () => { if (confirm('Удалить черновик записи?')) { db.records = db.records.filter(x => x.id !== r.id); save(); back(); } };
  if (closed) setBar(`<button class="btn ${srvOn() ? 'ghost' : ''}" id="exp">Выгрузить в файл</button>`), $('#exp').onclick = () => exportRecords([r], true);
  else if (canClose(r)) setBar(`<button class="btn" id="close">Подписать и закрыть запись</button>`), $('#close').onclick = () => go('sign', { id: r.id, wid: 'instr' });
  else if (nextW) setBar(`<button class="btn" id="go-next">Подписать: ${esc(nextW.fio.split(' ').slice(0, 2).join(' '))}</button>`), $('#go-next').onclick = () => go('sign', { id: r.id, wid: nextW.id });
  else setBar('');
};

VIEWS.sign = async s => {
  const r = db.records.find(x => x.id === s.id); if (!r) { back(); return; }
  const isInstr = s.wid === 'instr';
  const w = isInstr ? null : r.workers.find(x => x.id === s.wid);
  const person = isInstr ? r.instructor : w;
  title(isInstr ? 'Подпись инструктирующего' : 'Подпись работника');
  $('#view').innerHTML = `<div class="who">${esc(person.fio)}</div><div class="sub" style="text-align:center">${isInstr ? 'Подпишите своей ЭЦП в eGov Mobile на этом телефоне' : 'Передайте телефон работнику: он сканирует QR в своём eGov Mobile («eGov QR»)'}</div>
    <div class="qrbox" id="qr"></div><div class="status" id="st"></div><div class="err" id="er"></div>
    ${isInstr ? '' : `<details class="card" style="margin-top:12px"><summary>Текст, который подписывает работник</summary><pre style="white-space:pre-wrap;font:14px/1.4 inherit">${esc(workerDoc(r, w))}</pre></details>`}`;
  setBar(`<button class="btn ghost" id="cancel">Отмена</button><a class="btn" id="launch" hidden>Открыть eGov Mobile</a>`);
  $('#cancel').onclick = back;
  const ui = {
    status: t => { $('#st').textContent = t; },
    qr: (img, link) => {
      $('#qr').innerHTML = img ? `<img alt="QR-код для eGov Mobile" src="data:image/gif;base64,${esc(img)}">` : '';
      const a = $('#launch'); if (link && isInstr) { a.href = link; a.hidden = false; } else a.hidden = true;
      if (img) ui.status(isInstr ? 'Нажмите «Открыть eGov Mobile» или отсканируйте QR с другого устройства.' : 'Откройте eGov Mobile, нажмите «eGov QR» и отсканируйте код.');
    }
  };
  try {
    const sig = isInstr
      ? await sign(await instructorDoc(r), [`Инструктаж провел: ${r.instructor.fio}, ${fmtD(r.date)}`], [{ name: 'Вид инструктажа', value: r.type }, { name: 'Работников', value: String(r.workers.length) }], r.instructor, ui)
      : await sign(workerDoc(r, w), [`Инструктаж: ${w.fio}, ${fmtD(r.date)}`, `Нұсқама: ${w.fio}, ${fmtD(r.date)}`], [{ name: 'Вид инструктажа', value: r.type }, { name: 'Дата', value: fmtD(r.date) }, { name: 'Инструктирующий', value: r.instructor.fio }], w, ui);
    if (!sig || cur().v !== 'sign') return;
    if (isInstr) {
      if (sig.check === 'bad') { $('#er').textContent = 'Подпись не принята: ЭЦП принадлежит другому человеку (' + sig.signer.cn + ').'; ui.qr(null); return; }
      r.instructorSig = sig; if (r.workers.some(x => x.sig && x.sig.demo) || sig.demo) r.demo = true;
      if (!r.instructor.iin && sig.signer.iin) r.instructor.iin = sig.signer.iin;
      if (!db.settings.instructor.iin && sig.signer.iin && !sig.demo) db.settings.instructor.iin = sig.signer.iin;
      setTimeout(() => syncNow(false), 300);
    } else {
      putSig(w, sig); r.instructorSig = null;
      if (!w.iin && sig.signer.iin && sig.check === 'name' && !sig.demo) { w.iin = sig.signer.iin; if (!w.birthYear) w.birthYear = byFromIIN(w.iin); }
    }
    save();
    const msg = { ok: 'Подпись принята.', name: 'Подпись принята. ИИН взят из сертификата, ФИО сверено по фамилии и имени.', warn: 'Подпись принята, но ФИО в сертификате не совпало или не удалось сверить. Проверьте вручную.', bad: 'ВНИМАНИЕ: ЭЦП не принадлежит этому работнику. Подпись помечена как ошибочная.' }[sig.check];
    ui.qr(null); ui.status(msg + (sig.signer.cn ? ` Подписал: ${sig.signer.cn} ${sig.signer.gn} ${maskIIN(sig.signer.iin)}` : ''));
    const nw = isInstr ? null : r.workers.find(x => !x.sig);
    setBar(nw ? `<button class="btn ghost" id="to-rec">К записи</button><button class="btn" id="to-next">Следующий</button>` : `<button class="btn" id="to-rec">К записи</button>`);
    $('#to-rec').onclick = back;
    if (nw) $('#to-next').onclick = () => { stack[stack.length - 1] = { v: 'sign', id: r.id, wid: nw.id }; render(); };
  } catch (e) { if (cur().v === 'sign') { ui.qr(null); ui.status(''); $('#er').textContent = failText(e); } }
};

VIEWS.settings = () => {
  title('Настройки'); setBar('');
  const ins = db.settings.instructor;
  $('#view').innerHTML = `
    <div class="card"><h3>Инструктирующий</h3>
      <label for="s-fio">ФИО</label><input id="s-fio" value="${esc(ins.fio)}">
      <label for="s-pos">Должность</label><input id="s-pos" value="${esc(ins.position)}">
      <label for="s-iin">ИИН (заполнится из ЭЦП при первой подписи)</label><input id="s-iin" inputmode="numeric" maxlength="12" value="${esc(ins.iin)}">
      <div style="margin-top:10px"><button class="btn block" id="s-save">Сохранить</button></div></div>
    <div class="card"><h3>Список персонала</h3><div class="sub">Сейчас: ${db.staff.length} чел., подразделений: ${units().length}.</div>
      <div class="note">CSV из штатки (ФИО; ИИН; Табельный номер; Должность; Подразделение) или архив .json журнала.</div>
      <label class="btn ghost block" style="margin-top:6px;color:var(--acc)">Загрузить файл<input type="file" id="s-staff" accept=".csv,.txt,.json,text/csv,application/json" hidden></label>
      ${db.staff.length ? '<div style="margin-top:10px"><button class="btn danger block" id="s-staff-clr">Очистить список</button></div>' : ''}</div>
    <div class="card"><h3>Общий сервер журнала</h3>${srvOn() ? `
      <div class="sub">Вход: <b>${esc((srv.user && (srv.user.fio || srv.user.login)) || '')}</b>, сервер ${esc(srv.url)}.<br>${srv.lastOk ? 'Последняя связь: ' + esc(fmtDT(srv.lastOk)) : 'Связи еще не было'}${srv.lastErr ? '<br>Ошибка: ' + esc(srv.lastErr) : ''}<br>Ждут отправки: ${queue().length}.</div>
      <div class="row" style="margin-top:10px"><button class="btn" id="srv-sync" style="flex:1">Отправить сейчас</button></div>
      <div class="row" style="margin-top:10px"><button class="btn ghost" id="srv-staff" style="flex:1">Обновить список персонала</button></div>
      <div class="row" style="margin-top:10px"><button class="btn danger" id="srv-out" style="flex:1">Выйти</button></div>
      <div class="note">Закрытые записи отправляются сами. Без интернета они ждут в очереди на телефоне.</div>` : `
      <div class="note">Логин и пароль выдает администратор журнала. После входа закрытые записи уходят в журнал сами, без файлов.</div>
      <label for="srv-url">Адрес сервера</label><input id="srv-url" inputmode="url" autocomplete="url" placeholder="https://journal.example.kz" value="${esc(srv.url)}">
      <label for="srv-login">Логин</label><input id="srv-login" autocomplete="username" autocapitalize="off" value="${esc((srv.user && srv.user.login) || '')}">
      <label for="srv-pass">Пароль</label><input id="srv-pass" type="password" autocomplete="current-password">
      <div id="srv-new-box" hidden><label for="srv-new">Придумайте новый пароль (не короче 8 символов)</label><input id="srv-new" type="password" autocomplete="new-password"></div>
      <div style="margin-top:10px"><button class="btn block" id="srv-in">Войти</button></div><div class="err" id="srv-err"></div>`}</div>
    <div class="card"><h3>Выгрузка в файл</h3><div class="sub">Записей на телефоне: ${db.records.length}, закрытых: ${db.records.filter(r => r.instructorSig).length}.</div>
      <div style="margin-top:10px" class="row"><button class="btn" id="s-exp-all" style="flex:1">Все записи в файл</button></div>
      <div class="note">Запасной способ без сервера: файл открывается в журнале на компьютере кнопкой «Загрузить архив».</div></div>
    <div class="card"><h3>Защита</h3><div class="sub">${db.settings.pinHash ? 'PIN установлен.' : 'PIN не установлен.'} Приложение блокируется через 2 минуты в фоне. PIN защищает от случайного просмотра, но не шифрует данные.</div>
      <label for="s-pin">Новый PIN (4–8 цифр, пусто = убрать)</label><input id="s-pin" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password">
      <div style="margin-top:10px"><button class="btn ghost block" id="s-pin-set">Сохранить PIN</button></div></div>
    <div class="card"><h3>Демо-режим</h3><label class="row" style="color:var(--ink);font-size:16px"><input type="checkbox" id="s-demo" ${db.settings.demo ? 'checked' : ''} style="width:24px;min-height:24px;height:24px"> Подпись без eGov, для обучения</label>
      <div class="note">Демо-записи помечаются и не имеют юридической силы.</div></div>
    <div class="card"><h3>Очистка</h3><div class="sub">Удаляет закрытые записи, уже отправленные на сервер или выгруженные в файл, чтобы ИИН не хранились на телефоне.</div>
      <div style="margin-top:10px"><button class="btn danger block" id="s-clean">Удалить выгруженные записи</button></div></div>
    <div class="sub" style="text-align:center">Версия 0.2</div>`;
  const si = $('#srv-in'); if (si) si.onclick = async () => {
    $('#srv-err').textContent = ''; let url = $('#srv-url').value.trim().replace(/\/+$/, ''); if (url && !/^https?:\/\//.test(url)) url = 'https://' + url;
    if (!url) { $('#srv-err').textContent = 'Укажите адрес сервера'; return; }
    srv.url = url; si.disabled = true;
    try {
      const j = await api('POST', '/api/login', { login: $('#srv-login').value, password: $('#srv-pass').value, newPassword: ($('#srv-new').value || undefined), device: 'телефон: ' + navigator.userAgent.slice(0, 80) });
      srv.token = j.token; srv.user = j.user; srv.lastErr = ''; save();
      if (!db.settings.instructor.fio && j.user.fio) db.settings.instructor.fio = j.user.fio;
      toast('Вход выполнен'); await staffFromServer(false).catch(() => { }); await syncNow(false); render();
    } catch (e) { si.disabled = false; if (e.body && e.body.mustChange) $('#srv-new-box').hidden = false; $('#srv-err').textContent = e.message; }
  };
  const ss = $('#srv-sync'); if (ss) ss.onclick = () => syncNow(true);
  const sst = $('#srv-staff'); if (sst) sst.onclick = () => staffFromServer(true).then(render).catch(e => toast('Сервер: ' + e.message));
  const so = $('#srv-out'); if (so) so.onclick = async () => {
    const q = queue().length; if (q && !confirm(`На телефоне ${q} неотправленных записей. Они останутся на телефоне и уйдут после следующего входа. Выйти?`)) return;
    try { await api('POST', '/api/logout'); } catch (e) { } srv.token = ''; save(); render();
  };
  $('#s-save').onclick = () => {
    const iin = normIIN($('#s-iin').value); if (iin && !iinValid(iin)) { toast('ИИН неверный (12 цифр, контрольная цифра)'); return; }
    db.settings.instructor = { fio: normFio($('#s-fio').value), position: $('#s-pos').value.trim(), iin }; save(); toast('Сохранено');
  };
  $('#s-staff').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const t = await f.text(); let list;
      if (/\.json$/i.test(f.name) || t.trim().startsWith('{')) { const d = JSON.parse(t); if (!Array.isArray(d.staff)) throw new Error('В архиве нет списка персонала'); list = d.staff.filter(x => x && x.fio).map(x => ({ id: String(x.id || uid()), fio: normFio(x.fio), iin: String(x.iin || ''), tab: String(x.tab || ''), birthYear: String(x.birthYear || ''), position: String(x.position || ''), unit: String(x.unit || '') })); }
      else list = parseCSV(t);
      const r = mergeStaff(list); toast(`Добавлено: ${r.add}, обновлено: ${r.upd}`); render();
    } catch (err) { toast(err.message || 'Не удалось прочитать файл'); }
  };
  const clr = $('#s-staff-clr'); if (clr) clr.onclick = () => { if (confirm('Очистить список персонала на телефоне?')) { db.staff = []; save(); render(); } };
  $('#s-exp-all').onclick = () => exportRecords(db.records, true);
  $('#s-pin-set').onclick = async () => {
    const p = $('#s-pin').value; if (p && !/^\d{4,8}$/.test(p)) { toast('PIN: от 4 до 8 цифр'); return; }
    db.settings.pinHash = p ? await sha('kto:' + p) : ''; save(); toast(p ? 'PIN установлен' : 'PIN убран'); render();
  };
  $('#s-demo').onchange = e => { db.settings.demo = e.target.checked; save(); render(); };
  $('#s-clean').onclick = () => {
    const n = db.records.filter(r => r.instructorSig && isOut(r)).length; if (!n) { toast('Нет отправленных или выгруженных закрытых записей'); return; }
    if (confirm(`Удалить с телефона ${n} закрытых записей, которые уже на сервере или выгружены в файл?`)) { db.records = db.records.filter(r => !(r.instructorSig && isOut(r))); save(); render(); toast('Удалено: ' + n); }
  };
};

document.addEventListener('click', e => { const g = e.target.closest('[data-go]'); if (g) go(g.dataset.go); const rec = e.target.closest('[data-rec]'); if (rec) go('record', { id: rec.dataset.rec }); });

history.replaceState({ n: 1 }, '');
lock();
render();
syncNow(false);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
