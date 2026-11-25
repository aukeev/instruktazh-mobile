/* Тексты подписи и разбор сертификата в формате ЭЖИ v3.4.
   Функции docText, parseCert, cmsSignerCert и справочники взяты из ЭЖИ без изменений,
   чтобы текст, подписанный на телефоне, совпадал с текстом, который формирует ЭЖИ. */
'use strict';
const EZ = (() => {
let S = { orgShortKk: '', orgShortRu: '', unit: '' }, JMAP = {};
const fmtD = iso => iso ? iso.slice(8,10)+'.'+iso.slice(5,7)+'.'+iso.slice(0,4) : '';
const fmtDT = iso => { if(!iso) return ''; const d = new Date(iso); const p = n => String(n).padStart(2,'0'); return `${p(d.getDate())}.${p(d.getMonth()+1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; };
function iinYear(iin){
  if (!/^\d{12}$/.test(iin)) return '';
  const yy = +iin.slice(0,2), c = +iin[6];
  const cent = c===1||c===2 ? 1800 : c===3||c===4 ? 1900 : c===5||c===6 ? 2000 : c===0 ? null : 2100;
  return cent ? cent + yy : '';
}
const b64bytes = b64 => { const s = atob(b64.replace(/\s+/g,'')); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
function derRead(buf, pos){
  const start = pos, tag = buf[pos++]; let len = buf[pos++];
  if (len & 0x80){ const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = len * 256 + buf[pos++]; }
  return { tag, start, hlen: pos - start, len, vstart: pos, end: pos + len, cons: !!(tag & 0x20) };
}
function derChildren(buf, node){ const out = []; let p = node.vstart; while (p < node.end){ const c = derRead(buf, p); out.push(c); p = c.end; } return out; }
function derOID(buf, n){ const b = buf.subarray(n.vstart, n.end); const parts = [Math.floor(b[0]/40), b[0]%40]; let v = 0; for (let i = 1; i < b.length; i++){ v = v*128 + (b[i] & 0x7f); if (!(b[i] & 0x80)){ parts.push(v); v = 0; } } return parts.join('.'); }
function derStr(buf, n){ const b = buf.subarray(n.vstart, n.end); if (n.tag === 0x1e){ let s=''; for (let i=0;i<b.length;i+=2) s += String.fromCharCode(b[i]<<8 | b[i+1]); return s; } return new TextDecoder().decode(b); }
function derTime(buf, n){ const s = derStr(buf, n); let y, rest; if (n.tag === 0x17){ y = +s.slice(0,2); y += y < 50 ? 2000 : 1900; rest = s.slice(2); } else { y = +s.slice(0,4); rest = s.slice(4); } return `${y}-${rest.slice(0,2)}-${rest.slice(2,4)}T${rest.slice(4,6)}:${rest.slice(6,8)}:${rest.slice(8,10)||'00'}Z`; }
function derName(buf, n){ const o = {}; for (const set of derChildren(buf, n)) for (const atv of derChildren(buf, set)){ const [oid, val] = derChildren(buf, atv); o[derOID(buf, oid)] = derStr(buf, val); } return o; }
function parseCert(buf, certNode){
  const tbs = derChildren(buf, certNode)[0]; let f = derChildren(buf, tbs); if (f[0].tag === 0xa0) f = f.slice(1);
  const serial = [...buf.subarray(f[0].vstart, f[0].end)].map(b => b.toString(16).padStart(2,'0')).join('').toUpperCase();
  const issuer = derName(buf, f[2]); const [nb, na] = derChildren(buf, f[3]).map(x => derTime(buf, x)); const subject = derName(buf, f[4]);
  const sn = subject['2.5.4.5'] || '';
  const ou = subject['2.5.4.11'] || '';
  return {
    serial, notBefore: nb, notAfter: na,
    iin: (sn.match(/IIN(\d{12})/) || [])[1] || '',
    fio: [subject['2.5.4.4'] || (subject['2.5.4.3']||'').split(' ')[0], (subject['2.5.4.3']||'').split(' ').slice(1).join(' '), subject['2.5.4.42'] || ''].filter(Boolean).join(' ').replace(/\s+/g,' ').trim(),
    cn: subject['2.5.4.3'] || '', org: subject['2.5.4.10'] || '', bin: (ou.match(/BIN(\d{12})/) || [])[1] || '',
    issuer: issuer['2.5.4.3'] || ''
  };
}
function cmsSignerCert(b64){
  const buf = b64bytes(b64); const ci = derRead(buf, 0); const [, ex] = derChildren(buf, ci);
  const sd = derChildren(buf, ex)[0]; const parts = derChildren(buf, sd);
  const certSet = parts.find(p => p.tag === 0xa0); if (!certSet) throw new Error('CMS-те сертификат жоқ / В CMS нет сертификата');
  const certs = derChildren(buf, certSet).map(c => { try { return parseCert(buf, c); } catch(e){ return null; } }).filter(Boolean);
  const leaf = certs.find(c => c.iin) || certs[0]; if (!leaf) throw new Error('Сертификатты оқу мүмкін болмады / Не удалось прочитать сертификат');
  return leaf;
}
const JT = { J1: { kk: 'Кіріспе нұсқаулама тіркеу журналы', ru: 'Журнал регистрации вводного инструктажа', app: '№ 1019 Қағидаларға 16-қосымша / Приложение 16 к Правилам № 1019' },
             J2: { kk: 'Жұмыс орнындағы еңбек қауіпсіздігі және еңбекті қорғау жөніндегі нұсқаманы тіркеу журналы', ru: 'Журнал регистрации инструктажа по безопасности и охране труда на рабочем месте', app: '№ 1019 Қағидаларға 17-қосымша / Приложение 17 к Правилам № 1019' } };
const KIND = { vvod: 'Кіріспе / Вводный', perv: 'Жұмыс орнындағы бастапқы / Первичный на рабочем месте', povt: 'Қайталау / Повторный', vnep: 'Жоспардан тыс / Внеплановый', cel: 'Мақсатты / Целевой' };
const RES = { pass: 'өтіп шықты / прошел(-а)', fail: 'өтіп шықпады / не прошел(-а)' };
function docText(rec, role){
  const p = rec.person, L = [];
  L.push(`${S.orgShortKk} / ${S.orgShortRu} – ${S.unit}`);
  L.push(`${JT[rec.j].kk} / ${JT[rec.j].ru} (${JT[rec.j].app})`);
  const jr = JMAP[rec.journalId];
  L.push(`Журнал: ${jr ? jr.reg : ''}${jr && jr.section ? ' (' + jr.section + ')' : ''}   Жазба № / Запись №: ${rec.no || 'тіркеу кезінде беріледі / присваивается при регистрации'}`);
  L.push(`Күні / Дата: ${fmtD(rec.date)}`);
  L.push(`Нұсқама түрі / Вид инструктажа: ${KIND[rec.kind]}`);
  if (rec.cause) L.push(rec.kind === 'cel' ? `Жұмыс түрі / Вид работ (целевой): ${rec.cause}` : `Өткізу себебі / Причина проведения: ${rec.cause}`);
  if (rec.note) L.push(`Белгі / Отметка (п. 8.3.37 СТ КТО-2.007-2025): ${rec.note}`);
  if (rec.program) L.push(`Бағдарлама / Программа: ${rec.program.code} ${rec.program.titleKk} / ${rec.program.titleRu} (нұсқа / версия ${rec.program.ver})`);
  else L.push('Бағдарлама / Программа: бағдарламасыз, көлемі мен мазмұны себебіне қарай анықталған / без программы, объем и содержание определены причиной (п. 8.3.29 СТ КТО-2.007-2025)');
  if (rec.topic) L.push(`Нұсқама мазмұны / Содержание инструктажа: ${rec.topic}`);
  if (rec.correctionOf) L.push(`Түзету / Исправление записи № ${rec.correctionOfNo}. Себебі / Причина: ${rec.reason}`);
  if (role === 1 && !p.iin) L.push('Нұсқама алушы / Инструктируемый: осы құжатқа ЭЦҚ қойған тұлға / лицо, подписавшее настоящий документ ЭЦП');
  else L.push(`Нұсқама алушы / Инструктируемый: ${p.fio} (ЖСН / ИИН ${p.iin})`);
  if (p.pos) L.push(`Кәсібі, лауазымы / Профессия, должность: ${p.pos}`);
  if (p.place) L.push(`Жұмыс орны / Место работы: ${p.place}`);
  if (rec.instr2) L.push(`Нұсқама берушілер / Инструктирующие: 1) ${rec.instr.fio}, ${rec.instr.pos}; 2) ${rec.instr2.fio}, ${rec.instr2.pos}`);
  else L.push(`Нұсқама беруші / Инструктирующий: ${rec.instr.fio}, ${rec.instr.pos}`);
  L.push(`Білімін тексеру / Проверка знаний: ${RES[rec.result]}`);
  if (role === 1){
    L.push('');
    L.push('Нұсқаманы тыңдадым, сұрақтарға жауап бердім. / Инструктаж прослушал(а), на вопросы ответил(а).');
    L.push('ЖСН мен Т.А.Ә. нұсқамаларды есепке алу үшін өңделуіне келісемін. / Согласен(на) на обработку ИИН и Ф.И.О. для учета инструктажей.');
  } else {
    L.push(`Нұсқама алушының қолы / Подпись инструктируемого: ${rec.sig1.method === 'paper' ? 'қағаз журнал / бумажный журнал ' + rec.sig1.paperRef : 'ЭЦҚ / ЭЦП, сертификат № ' + rec.sig1.cert.serial + ', ' + fmtDT(rec.sig1.at)}`);
    if (rec.sig1.cmsHash) L.push(`CMS SHA-256: ${rec.sig1.cmsHash}`);
    L.push('');
    L.push('Нұсқаманы өткіздім, білімін тексердім. / Инструктаж провел(а), знания проверил(а).');
  }
  return L.join('\n');
}
const sha256hex = async str => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)))].map(b => b.toString(16).padStart(2, '0')).join('');
const KINDS_J2 = ['perv', 'povt', 'vnep', 'cel'];
const TYPE_OF = { vvod: 'Вводный', perv: 'Первичный', povt: 'Повторный', vnep: 'Внеплановый', cel: 'Целевой' };
const CAUSE_REQ = k => k === 'vnep', CAUSE_SHOW = k => k === 'vnep' || k === 'cel', PROG_OPT = k => k === 'vnep' || k === 'cel';
const jOpen = (jr, date) => jr && jr.start && (!date || date >= jr.start) && (!jr.end || !date || date <= jr.end) && !jr.closed;
const jTitle = jr => jr ? `${jr.type === 'J1' ? 'Ж-1' : 'Ж-2'} · ${jr.reg}${jr.section ? ' · ' + jr.section : ''}` : '—';
let CFG = null;
const set = cfg => { CFG = cfg && cfg.journals ? cfg : null; S = (CFG && CFG.org) || { orgShortKk: '', orgShortRu: '', unit: '' }; JMAP = Object.fromEntries(((CFG && CFG.journals) || []).map(j => [j.id, j])); };
// текст для записи со своим снимком реквизитов и журнала (на случай, если реестр потом изменится)
const docFor = (rec, role, jr, org) => { const s0 = S, j0 = JMAP; try { S = org || S; JMAP = { ...JMAP, ...(jr ? { [jr.id]: jr } : {}) }; return docText(rec, role); } finally { S = s0; JMAP = j0; } };
return { set, docFor, get cfg() { return CFG; }, journal: id => JMAP[id], docText, cmsSignerCert, sha256hex, iinYear, fmtDT, KIND, KINDS_J2, TYPE_OF, RES, CAUSE_REQ, CAUSE_SHOW, PROG_OPT, jOpen, jTitle };
})();
