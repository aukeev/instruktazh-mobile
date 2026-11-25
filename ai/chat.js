/* Окно чата ИИ-помощника (браузер). Нужны ai/core.js и ai/knowledge.js (AI_CORE, AI_KNOWLEDGE).
   AI_CHAT.mount({ el, floating, getContext, getServer, hasRealData, note })
     getContext(): данные журнала (с ФИО/ИИН — они обезличиваются здесь или на сервере);
     getServer(): { url, token } или null — без сервера работает тестовый режим прямо в браузере,
                  и ничего никуда не отправляется. */
(function (root) {
  'use strict';
  const CSS = `
.aic-fab{position:fixed;left:18px;bottom:18px;z-index:25;background:#163b6b;color:#fff;border:none;border-radius:999px;padding:11px 16px;font:600 14px Arial,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer}
.aic-wrap{font:14px/1.45 Arial,"Helvetica Neue",sans-serif;color:#1b2330;background:#fff;display:flex;flex-direction:column;min-height:0}
.aic-pop{position:fixed;left:18px;bottom:70px;z-index:26;width:min(460px,calc(100vw - 36px));height:min(640px,calc(100vh - 100px));border:1px solid #d5dae2;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden}
.aic-head{background:#163b6b;color:#fff;padding:10px 14px;display:flex;align-items:center;gap:8px}
.aic-head b{font-size:15px}.aic-head .aic-x{margin-left:auto;background:none;border:none;color:#fff;font-size:22px;cursor:pointer;line-height:1}
.aic-mode{font-size:11.5px;padding:2px 8px;border-radius:999px;background:#fdf2dc;color:#7a4d00}.aic-mode.on{background:#e5f4ea;color:#1d7a46}
.aic-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 14px;border-bottom:1px solid #e3e7ee;font-size:12.5px;color:#5b6575}
.aic-bar label{display:flex;gap:5px;align-items:center;cursor:pointer}
.aic-log{flex:1;overflow:auto;padding:12px 14px;background:#f6f8fb;min-height:120px}
.aic-m{margin:0 0 10px;max-width:92%;padding:9px 12px;border-radius:10px;white-space:pre-wrap;word-wrap:break-word}
.aic-m.u{margin-left:auto;background:#163b6b;color:#fff}.aic-m.a{background:#fff;border:1px solid #e0e5ec}.aic-m.e{background:#fdecea;color:#b3261e;border:1px solid #f2c3bf}
.aic-m .aic-src{display:block;margin-top:6px;font-size:11.5px;color:#5b6575}
.aic-m details{margin-top:8px;font-size:12px;color:#3b4656}.aic-m details summary{cursor:pointer;color:#163b6b}
.aic-m details pre{white-space:pre-wrap;background:#f3f5f8;border:1px solid #e0e5ec;border-radius:6px;padding:6px 8px;max-height:220px;overflow:auto;font:11.5px Consolas,monospace}
.aic-chips{display:flex;gap:6px;flex-wrap:wrap;padding:8px 14px 0}
.aic-chips button{font:12px Arial,sans-serif;border:1px solid #c4cbd6;background:#fff;border-radius:999px;padding:4px 10px;cursor:pointer;color:#163b6b}
.aic-in{display:flex;gap:8px;padding:10px 14px;border-top:1px solid #e3e7ee}
.aic-in textarea{flex:1;font:14px Arial,sans-serif;padding:8px;border:1px solid #c4cbd6;border-radius:8px;resize:none;height:58px}
.aic-in button{background:#163b6b;color:#fff;border:none;border-radius:8px;padding:0 16px;font:600 14px Arial,sans-serif;cursor:pointer}
.aic-in button:disabled{opacity:.5;cursor:default}
.aic-note{font-size:11.5px;color:#5b6575;padding:0 14px 8px}
@media print{.aic-fab,.aic-pop{display:none!important}}`;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CHIPS = ['Кто на Атасу просрочил повторный?', 'У кого в ближайшие две недели истекает повторный?', 'Как часто проводить повторный инструктаж?', 'Черновик целевого инструктажа на очистку резервуара'];

  function mount(o) {
    if (!document.getElementById('aic-css')) { const st = document.createElement('style'); st.id = 'aic-css'; st.textContent = CSS; document.head.appendChild(st); }
    const box = document.createElement('div'); box.className = 'aic-wrap' + (o.floating ? ' aic-pop' : '');
    box.innerHTML = `<div class="aic-head"><b>ИИ-помощник</b><span class="aic-mode" data-r="mode">тестовый режим</span>${o.floating ? '<button class="aic-x" title="Закрыть">×</button>' : ''}</div>
      <div class="aic-bar"><label><input type="checkbox" data-r="demo"> Демо-данные (вымышленные работники)</label><span data-r="srv"></span></div>
      <div class="aic-log" data-r="log"></div>
      <div class="aic-chips" data-r="chips">${CHIPS.map(c => `<button type="button">${esc(c)}</button>`).join('')}</div>
      <div class="aic-in"><textarea data-r="q" placeholder="Вопрос по журналу или по Правилам № 1019"></textarea><button data-r="send">Спросить</button></div>
      <div class="aic-note">${esc(o.note || 'ФИО и ИИН заменяются кодами «Работник-N» до отправки в ИИ. Ответ ИИ проверяйте: решения принимает ответственный.')}</div>`;
    const $ = r => box.querySelector(`[data-r="${r}"]`);
    const history = []; let busy = false;
    const demoBox = $('demo'); let touched = false; demoBox.onchange = () => { touched = true; };
    // hasRealData: true/false или функция; пока пользователь сам не переключил, демо включено только при пустом журнале
    const syncDemo = async () => { if (!touched) demoBox.checked = !(typeof o.hasRealData === 'function' ? await o.hasRealData() : o.hasRealData); };
    syncDemo();

    let fab = null;
    if (o.floating) {
      fab = document.createElement('button'); fab.className = 'aic-fab noprint'; fab.textContent = 'ИИ-помощник'; fab.type = 'button';
      document.body.appendChild(fab); box.style.display = 'none'; document.body.appendChild(box);
      fab.onclick = () => { const on = box.style.display === 'none'; box.style.display = on ? 'flex' : 'none'; if (on) { refresh(); $('q').focus(); } };
      box.querySelector('.aic-x').onclick = () => { box.style.display = 'none'; };
    } else (o.el || document.body).appendChild(box);

    async function refresh() {
      await syncDemo();
      const s = o.getServer ? await o.getServer() : null;
      const m = $('mode');
      if (!s) { m.textContent = 'тестовый режим, без ИИ'; m.classList.remove('on'); $('srv').textContent = 'Сервер не подключен: ответы считаются здесь, ничего не отправляется.'; return; }
      try {
        const r = await fetch(s.url.replace(/\/+$/, '') + '/api/ai/status', { headers: { Authorization: 'Bearer ' + s.token } });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
        m.textContent = j.mode === 'claude' ? 'ИИ подключен' : 'тестовый режим сервера'; m.classList.toggle('on', j.mode === 'claude');
        $('srv').textContent = j.mode === 'claude' ? `Сервер: ${s.url}` : `Сервер ${s.url} без ключа ИИ: ответы тестового режима.`;
      } catch (e) { m.textContent = 'нет связи с сервером'; m.classList.remove('on'); $('srv').textContent = e.message; }
    }

    function add(cls, html) { const d = document.createElement('div'); d.className = 'aic-m ' + cls; d.innerHTML = html; $('log').appendChild(d); $('log').scrollTop = 1e9; return d; }
    function sentHtml(sent, raw) {
      if (!sent) return '';
      const d = sent.data || {};
      const sample = JSON.stringify({ ...d, people: (d.people || []).slice(0, 3), records: (d.records || []).slice(0, 2) }, null, 1);
      return `<details><summary>Что ушло в ИИ</summary>Вопрос: <pre>${esc(sent.question)}</pre>Данные: ${(d.people || []).length} работников и ${(d.records || []).length} записей, вместо ФИО и ИИН коды. Первые строки:<pre>${esc(sample)}</pre>Пункты документов: ${esc((sent.knowledge || []).length)}.${raw ? `<br>Ответ ИИ до подстановки ФИО:<pre>${esc(raw)}</pre>` : ''}</details>`;
    }

    async function ask(question) {
      if (busy || !question.trim()) return;
      busy = true; $('send').disabled = true; $('q').value = '';
      add('u', esc(question)); $('chips').style.display = 'none';
      const wait = add('a', 'Думаю…');
      const demo = demoBox.checked;
      try {
        const s = o.getServer ? await o.getServer() : null;
        let res;
        if (s) {
          const body = { question, history, demo };
          if (!demo) body.context = await o.getContext();
          const r = await fetch(s.url.replace(/\/+$/, '') + '/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.token }, body: JSON.stringify(body) });
          res = await r.json().catch(() => ({}));
          if (!r.ok) throw Object.assign(new Error(res.error || 'HTTP ' + r.status), { sent: res.sent });
        } else {
          const ctx = demo ? root.AI_DEMO.build() : await o.getContext();
          const p = root.AI_CORE.pseudonymize(ctx, question, history);
          if (p.leaks.length) throw new Error('Вопрос не обработан: после обезличивания остались персональные данные (' + p.leaks.join(', ') + ').');
          const raw = root.AI_CORE.demoAnswer(p.data, p.question, root.AI_KNOWLEDGE);
          res = { answer: p.pseudo.restore(raw), mode: 'local', demo, raw, sent: { question: p.question, data: p.data, knowledge: root.AI_KNOWLEDGE.map(k => k.title) } };
        }
        const src = res.mode === 'claude' ? 'Ответ ИИ' : 'Тестовый режим, без ИИ';
        wait.innerHTML = esc(res.answer) + `<span class="aic-src">${src}${res.demo ? ', демо-данные' : ', данные журнала'}</span>` + sentHtml(res.sent, res.mode === 'claude' ? res.raw : '');
        history.push({ role: 'user', text: question }, { role: 'assistant', text: res.answer });
        if (history.length > 20) history.splice(0, history.length - 20);
      } catch (e) { wait.className = 'aic-m e'; wait.innerHTML = esc(e.message) + sentHtml(e.sent); }
      busy = false; $('send').disabled = false;
    }
    $('send').onclick = () => ask($('q').value);
    $('q').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask($('q').value); } };
    $('chips').querySelectorAll('button').forEach(b => b.onclick = () => ask(b.textContent));
    if (!o.floating) refresh();
    add('a', esc('Здравствуйте! Спросите про сроки инструктажей, про Правила № 1019 или попросите черновик текста инструктажа.'));
    return { box, fab, refresh, ask };
  }
  root.AI_CHAT = { mount };
})(typeof self !== 'undefined' ? self : this);
