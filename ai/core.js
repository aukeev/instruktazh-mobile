/* ИИ-помощник журнала инструктажей: общее ядро для сервера (Node.js) и браузера (ЭЖИ, тестовая страница).
   1) Обезличивание: ФИО и ИИН заменяются кодами «Работник-N» до отправки во внешний ИИ.
   2) Проверка утечки: если в готовом пакете остался ИИН или фамилия, пакет не отправляется.
   3) Обратная замена кодов на ФИО в ответе.
   4) Тестовый ответчик без ИИ: просрочки, поиск по Правилам, черновик целевого инструктажа.
   Файл не меняет данные журнала и ничего не отправляет сам. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AI_CORE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const CODE = 'Работник';
  const IIN_RE = /(?<!\d)\d{12}(?!\d)/g;
  const L = '\\p{L}';

  const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"“”]/g, '').replace(/\s+/g, ' ').trim();
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // буква е/ё в шаблоне совпадает с обеими
  const pat = s => escRe(s).replace(/[её]/gi, c => (c === c.toLowerCase() ? '[её]' : '[ЕЁ]'));
  const word = p => new RegExp(`(?<![${L}])(?:${p})(?![${L}])`, 'giu');

  /* ---------- таблица кодов ---------- */
  class Pseudo {
    constructor() { this.byKey = new Map(); this.list = []; }
    // человек: {iin, fio}; возвращает код «Работник-N»
    code(p) {
      if (!p) return '';
      const iin = String(p.iin || '').replace(/\D/g, '');
      const fio = String(p.fio || '').trim().replace(/\s+/g, ' ');
      if (!iin && !fio) return '';
      const keys = [iin && 'i:' + iin, fio && 'f:' + norm(fio)].filter(Boolean);
      for (const k of keys) if (this.byKey.has(k)) { const e = this.byKey.get(k); if (!e.fio && fio) e.fio = fio; if (!e.iin && iin) e.iin = iin; keys.forEach(x => this.byKey.set(x, e)); return e.code; }
      const e = { code: `${CODE}-${this.list.length + 1}`, fio, iin };
      this.list.push(e); keys.forEach(k => this.byKey.set(k, e));
      return e.code;
    }
    // варианты написания ФИО для поиска в свободном тексте (длинные раньше коротких)
    patterns() {
      if (this._pats) return this._pats;
      const out = [];
      for (const e of this.list) {
        const parts = e.fio.split(' ').filter(Boolean);
        if (!parts.length) continue;
        const [f, i, o] = parts; const v = [];
        // фамилия с падежными окончаниями: Иванов, Иванова, Иванову, Ивановым; Петрова -> Петровой
        const base = f.length >= 5 ? f.replace(/(ий|ой|ая|ый|а|я|ь|й)$/i, '') : f;
        const sp = base.length >= 4 && base !== f ? `${pat(base)}[${L}]{0,4}` : f.length >= 4 ? `${pat(f)}[${L}]{0,3}` : pat(f);
        if (parts.length > 1) v.push(parts.map(pat).join('\\s+'));
        if (i) {
          const ini = pat(i[0]) + '\\.?\\s?' + (o ? pat(o[0]) + '\\.?' : '');
          const ip = i.length >= 4 ? `${pat(i.slice(0, -1))}[${L}]{0,4}` : pat(i);
          const op = o && o.length >= 4 ? `${pat(o.slice(0, -2))}[${L}]{0,5}` : o ? pat(o) : '';
          if (op) v.push(`(?:${sp})\\s+${ip}\\s+${op}`, `${ip}\\s+${op}\\s+(?:${sp})`);
          v.push(`(?:${sp})\\s+${ini}`, `${ini}\\s?(?:${sp})`, `(?:${sp})\\s+${ip}`, `${ip}\\s+(?:${sp})`);
        }
        v.push(sp);
        out.push({ code: e.code, re: word(v.join('|')), len: e.fio.length });
      }
      return (this._pats = out.sort((a, b) => b.len - a.len));
    }
    // замена ФИО и ИИН в свободном тексте
    scrub(text) {
      let t = String(text || '');
      if (!t) return t;
      for (const e of this.list) if (e.iin) t = t.split(e.iin).join(e.code);
      t = t.replace(IIN_RE, '[ИИН скрыт]');
      this._pats = null;
      for (const p of this.patterns()) t = t.replace(p.re, p.code);
      return t;
    }
    // обратная замена: «Работник-17», «Работнику‑17», «работника 17» -> ФИО
    restore(text) {
      const by = new Map(this.list.map(e => [e.code.split('-')[1], e]));
      return String(text || '').replace(/Работник[а-яё]{0,3}[\s ]?[-‑–—]?[\s ]?(\d{1,5})(?!\d)/giu, (m, n) => { const e = by.get(n); return e ? (e.fio || m) : m; });
    }
    // остались ли персональные данные в тексте пакета
    leaks(text) {
      const t = String(text || ''); const found = [];
      const m = t.match(IIN_RE); if (m) found.push('ИИН (12 цифр)');
      for (const e of this.list) {
        const f = e.fio.split(' ')[0];
        if (f && f.length >= 3 && word(pat(f)).test(t)) found.push('фамилия ' + f[0] + '…');
        if (e.iin && t.includes(e.iin)) found.push('ИИН');
      }
      return [...new Set(found)];
    }
  }

  /* ---------- обезличивание контекста журнала ----------
     ctx = { org, unit, today, rule, people:[{iin,fio,pos,section,type,group,lastPovt,next,state,days,vvodDate}],
             records:[{no,date,kind,journal,section,person:{iin,fio},instr:{iin,fio},result,status,topic,cause}],
             programs:[{code,title,kind,ver}] } */
  function pseudonymize(ctx, question, history) {
    const P = new Pseudo(); ctx = ctx || {};
    const people = (ctx.people || []).map(p => ({
      code: P.code(p), pos: p.pos || '', section: p.section || '', type: p.type || 'staff', group: p.group || '',
      lastPovt: p.lastPovt || '', next: p.next || '', state: p.state || '', days: p.days ?? null, vvodDate: p.vvodDate || '',
    }));
    // сначала регистрируем всех людей, потом чистим тексты (чтобы ловились все фамилии)
    (ctx.records || []).forEach(r => { P.code(r.person); P.code(r.instr); });
    const records = (ctx.records || []).map(r => ({
      no: r.no || '', date: r.date || '', kind: r.kind || '', journal: r.journal || '', section: r.section || '',
      person: P.code(r.person), instr: P.code(r.instr), result: r.result || '', status: r.status || '',
      topic: P.scrub(r.topic), cause: P.scrub(r.cause),
    }));
    const data = {
      org: ctx.org || '', unit: ctx.unit || '', today: ctx.today || '', rule: ctx.rule || '',
      people, records, programs: (ctx.programs || []).map(p => ({ code: p.code || '', title: P.scrub(p.title || ''), kind: p.kind || '', ver: p.ver || '' })),
    };
    const q = P.scrub(question);
    const h = (history || []).slice(-10).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: P.scrub(m.text) }));
    const leaks = P.leaks(JSON.stringify({ data, q, h }));
    return { data, question: q, history: h, pseudo: P, leaks };
  }

  /* ---------- база знаний: выбор подходящих пунктов ---------- */
  const STOP = new Set('и в во не на с со по за из к о об от до для при как что кто это или ли же бы а но у то так же какой какие каких когда сколько нужно надо можно ли мне по'.split(' '));
  const stem = w => w.length > 5 ? w.slice(0, w.length - 2) : w;
  const terms = s => norm(s).split(/[^\p{L}\d]+/u).filter(w => w.length > 2 && !STOP.has(w)).map(stem);
  function searchKnowledge(kb, question, n = 4) {
    const qt = terms(question); if (!qt.length) return [];
    return (kb || []).map(k => {
      const body = terms(k.title + ' ' + k.text + ' ' + (k.tags || ''));
      let s = 0; for (const t of qt) { const c = body.filter(b => b.startsWith(t) || t.startsWith(b)).length; if (c) s += 1 + Math.min(c, 4) * 0.2; }
      if (/п\.?\s*(\d+)/i.test(question)) { const num = question.match(/п\.?\s*(\d+)/i)[1]; if (new RegExp(`п\\.\\s*${num}(?!\\d)`).test(k.title)) s += 5; }
      return { k, s };
    }).filter(x => x.s >= 1).sort((a, b) => b.s - a.s).slice(0, n).map(x => x.k);
  }

  /* ---------- тестовый ответчик (без ИИ) ---------- */
  const KIND_RU = { vvod: 'вводный', perv: 'первичный', povt: 'повторный', vnep: 'внеплановый', cel: 'целевой' };
  const fmt = iso => iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4) : '—';
  function matchSection(q, sections) {
    const nq = norm(q);
    let best = null, bs = 0;
    for (const s of sections) {
      const ws = norm(s).split(/[^\p{L}\d]+/u).filter(w => w.length > 3 && !['гнпс', 'нпс', 'участок', 'служба', 'цех'].includes(w));
      const sc = ws.filter(w => nq.includes(w.slice(0, Math.max(4, w.length - 2)))).length;
      if (sc > bs) { bs = sc; best = s; }
    }
    return best;
  }
  function demoAnswer(data, question, kb) {
    const q = norm(question);
    const sections = [...new Set(data.people.map(p => p.section).filter(Boolean))];
    if (/просроч|срок|истек|не прошел|не прошли|когда следующ|скоро|ближайш/.test(q)) {
      const sec = matchSection(question, sections);
      const soon = /скоро|ближайш|истека|в этом месяце|на неделе/.test(q);
      const states = soon ? ['over', 'soon'] : ['over'];
      const list = data.people.filter(p => states.includes(p.state) && (!sec || p.section === sec)).sort((a, b) => (a.days ?? 0) - (b.days ?? 0));
      const where = sec ? `на участке ${sec}` : "по всему журналу";
      if (!list.length) return `${soon ? 'Просроченных и истекающих' : 'Просроченных'} повторных инструктажей ${where} нет (на ${fmt(data.today)}).`;
      return `${soon ? 'Просрочен или скоро истекает' : 'Просрочен'} повторный инструктаж ${where}: ${list.length} чел. (на ${fmt(data.today)}).\n\n` +
        list.map((p, i) => `${i + 1}. ${p.code}, ${p.pos || 'должность не указана'}${sec ? '' : ', ' + (p.section || '—')}: последний ${fmt(p.lastPovt)}, срок ${fmt(p.next)}` + (p.days != null ? (p.days < 0 ? `, просрочен на ${-p.days} дн.` : `, осталось ${p.days} дн.`) : '')).join('\n') +
        '\n\nРаботник с просроченным инструктажем к работе не допускается (п. 6.5 Порядка).';
    }
    if (/целев|черновик|текст инструктаж|программ[ауы]? инструктаж|наряд/.test(q)) {
      const work = (question.match(/(?:на|для|по)\s+([^.?!]{6,120})/i) || [])[1] || 'выполнение разовой работы';
      return `Черновик текста целевого инструктажа (проверьте и дополните перед проведением):\n\n` +
        `Вид инструктажа: целевой.\nРабота: ${work.trim()}.\nОснование: разовая работа / работа по наряду-допуску (Правила № 1019, пункт о целевом инструктаже).\n\n` +
        `1. Содержание и порядок выполнения работы, состав бригады, ответственный руководитель работ.\n` +
        `2. Опасные и вредные производственные факторы на месте работ.\n` +
        `3. Меры безопасности: ограждение места работ, отключение и блокировка оборудования, контроль газовоздушной среды при работах на объектах трубопровода.\n` +
        `4. Средства индивидуальной защиты и их проверка перед началом работы.\n` +
        `5. Безопасные приемы работы с инструментом и приспособлениями.\n` +
        `6. Действия при аварии, пожаре, несчастном случае; аптечка, связь, пути эвакуации.\n` +
        `7. Проверка знаний устным опросом, запись в журнал на рабочем месте.\n\n` +
        `Это шаблон тестового режима. С подключенным ИИ текст будет составлен под конкретную работу.`;
    }
    const hits = searchKnowledge(kb, question, 3);
    if (hits.length) return 'Что сказано в документах (тестовый режим ищет по словам, без ИИ):\n\n' + hits.map(k => `${k.title}\n${k.text}${k.source ? `\nИсточник: ${k.source}` : ''}`).join('\n\n');
    return 'В тестовом режиме я понимаю три вида вопросов:\n' +
      '1. Сроки: «кто на Атасу просрочил повторный», «у кого скоро истекает повторный».\n' +
      '2. Правила: «как часто проводить повторный инструктаж», «когда нужен внеплановый».\n' +
      '3. Черновик: «черновик целевого инструктажа на очистку резервуара».\n' +
      'С подключенным ИИ можно спрашивать своими словами о чем угодно по журналу и Правилам.';
  }

  /* ---------- сроки повторного (для демо-данных; в ЭЖИ сроки считает сам ЭЖИ) ---------- */
  function addMonths(iso, m) { const [y, mo, d] = iso.split('-').map(Number); const dt = new Date(Date.UTC(y, mo - 1 + m, d)); if (dt.getUTCDate() !== d) dt.setUTCDate(0); return dt.toISOString().slice(0, 10); }
  function dueState(p, today, months = { main: 3, aux: 6 }, warn = 14) {
    const mm = p.group === 'season' ? null : months[p.group || 'main'];
    const next = p.lastPovt && mm ? addMonths(p.lastPovt, mm) : '';
    const days = next ? Math.round((Date.parse(next) - Date.parse(today)) / 864e5) : null;
    const state = !mm ? 'season' : !next ? 'none' : days < 0 ? 'over' : days <= warn ? 'soon' : 'ok';
    return { ...p, next, days, state };
  }

  return { Pseudo, pseudonymize, searchKnowledge, demoAnswer, dueState, KIND_RU, IIN_RE };
});
