/* ====================================================================
   МОДУЛЬ «ИИ-ПОМОЩНИК» (дополнение к ЭЖИ v3.4)
   Кнопка «ИИ-помощник» в левом нижнем углу, видна после входа в ЭЖИ.
   Функции ЭЖИ не меняются: модуль только читает контингент, сроки (dueList),
   записи и программы. Если в «Настройках → Телефоны и общий сервер» подключен
   сервер журнала, вопрос уходит на него: сервер КТО заменяет ФИО и ИИН кодами
   и спрашивает ИИ. Без сервера работает тестовый режим прямо в браузере.
   ==================================================================== */
(function () {
  'use strict';
  const DAYS_BACK = 400; // записи журнала за последние ~13 месяцев
  async function context() {
    const due = await dueList();
    const all = await DB.all('people');
    const inDue = new Set(due.map(x => x.p.iin));
    const people = due.map(x => ({ iin: x.p.iin, fio: x.p.fio, pos: x.p.pos || '', section: x.p.section || '', type: x.p.type || 'staff', group: pGroup(x.p), lastPovt: x.p.lastPovt || '', next: x.next || '', days: x.d, state: x.state, vvodDate: x.p.vvodDate || '' }))
      .concat(all.filter(p => !inDue.has(p.iin)).map(p => ({ iin: p.iin, fio: p.fio, pos: p.pos || '', section: p.type === 'contractor' ? (p.org || '') : (p.section || ''), type: p.type || 'staff', group: '', lastPovt: p.lastPovt || '', next: '', days: null, state: p.type === 'contractor' ? 'contractor' : 'exempt', vvodDate: p.vvodDate || '' })));
    const since = addMonths(todayISO(), -Math.round(DAYS_BACK / 30));
    const records = (await DB.all('records')).filter(r => r.status !== 'draft' && (r.date || '') >= since).sort((a, b) => (a.date || '').localeCompare(b.date || '')).slice(-3000).map(r => {
      const jr = JMAP[r.journalId];
      return { no: r.no || '', date: r.date || '', kind: r.kind || '', journal: jr ? jr.reg : (r.j || ''), section: jr ? (jr.section || '') : '', person: r.person ? { iin: r.person.iin, fio: r.person.fio } : null, instr: r.instr ? { iin: r.instr.iin, fio: r.instr.fio } : null, result: r.result || '', status: r.status || '', topic: r.topic || '', cause: r.cause || '' };
    });
    return { org: S.orgRu || '', unit: S.unit || '', today: todayISO(), rule: PGROUP_RULE_RU, people, records, programs: (S.programs || []).map(p => ({ code: p.code, title: p.titleRu || p.titleKk, kind: p.kind, ver: p.ver })) };
  }
  // тот же сервер, что в модуле «Телефоны и общий сервер»
  async function server() { const c = await kv.get('mobSrv'); return c && c.url && c.token ? { url: c.url, token: c.token } : null; }

  let ui = null;
  async function start() {
    ui = AI_CHAT.mount({ floating: true, getContext: context, getServer: server, hasRealData: async () => (await DB.all('people')).length > 0 });
    ui.fab.style.display = AUTH.user ? '' : 'none';
    setInterval(() => { const on = !!AUTH.user; ui.fab.style.display = on ? '' : 'none'; if (!on) ui.box.style.display = 'none'; }, 1000);
  }
  (function wait() { if (DB.db) start().catch(e => console.error('ИИ-помощник:', e)); else setTimeout(wait, 500); })();
})();
