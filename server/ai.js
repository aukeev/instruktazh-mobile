/* ИИ-помощник журнала: маршруты /api/ai/*.
   Персональные данные не покидают сервер КТО: до вызова ИИ ФИО и ИИН заменяются кодами «Работник-N»
   (ai/core.js), пакет проверяется на остатки ИИН и фамилий, в ответе коды заменяются обратно на ФИО.
   Ключ Anthropic хранится только на сервере (переменная ANTHROPIC_API_KEY). Без ключа работает тестовый режим. */
'use strict';
const path = require('node:path');

const AI_DIR = process.env.AI_DIR || path.join(__dirname, '..', 'ai');
const core = require(path.join(AI_DIR, 'core.js'));
const demo = require(path.join(AI_DIR, 'demo-data.js'));
const KB_FILE = path.join(AI_DIR, 'knowledge.js');

const AI = {
  model: process.env.AI_MODEL || 'claude-opus-5-5',
  effort: process.env.AI_EFFORT || 'medium',
  perDay: +(process.env.AI_LIMIT_PER_DAY || 100),
  enabled: process.env.AI_ENABLED !== '0',
};
const hasKey = () => !!process.env.ANTHROPIC_API_KEY;

const SYSTEM = `Ты помощник специалиста по безопасности и охране труда АО «КазТрансОйл» в электронном журнале регистрации инструктажей.

Работники в данных обозначены кодами «Работник-N». Настоящих ФИО и ИИН у тебя нет, и они не нужны: сервер сам подставит ФИО вместо кодов. Называй людей именно этими кодами и не склоняй их (пиши «Работник-17», не «Работнику-17»). Не пытайся угадать, кто стоит за кодом.

Что в данных:
- people: работники. section — участок, pos — должность, group — main (основное производство), aux (вспомогательные работы), season (сезонные). lastPovt — дата последнего повторного (или первичного) инструктажа, next — срок следующего, days — дней до срока (меньше нуля — просрочен), state — over (просрочен), soon (скоро истекает), ok (в норме), none (нет данных), season (сезонные). Сроки уже посчитаны журналом по правилу из поля rule, бери их из данных.
- records: записи журнала. kind — vvod (вводный), perv (первичный), povt (повторный), vnep (внеплановый), cel (целевой). person — инструктируемый, instr — инструктирующий, result pass/fail.
- programs: программы инструктажей подразделения.
- today: сегодняшняя дата.

Нормативные вопросы решай только по пунктам из базы знаний ниже и называй пункт. Если ответа в базе нет, так и скажи и посоветуй проверить официальный текст Правил на adilet.zan.kz. Номера пунктов не придумывай. Пункты с пометкой «не сверено» — это краткие изложения: если ответ опирается на них, добавь, что формулировку нужно сверить с официальным текстом.

Черновики инструктажей и других текстов составляй под конкретную работу, без персональных данных, и в конце напомни, что текст проверяет и утверждает ответственный.

Пиши по-русски, просто и коротко: пользователь не программист. Без таблиц и заголовков: обычный текст и нумерованные списки. Списки людей давай с участком, должностью и датами.`;

function kbText() {
  delete require.cache[require.resolve(KB_FILE)]; // правки базы знаний подхватываются без перезапуска
  const kb = require(KB_FILE);
  return { kb, text: kb.map(k => `### ${k.title}${k.checked ? '' : ' (не сверено с официальным текстом)'}\n${k.text}\nИсточник: ${k.source}`).join('\n\n') };
}

// история чата -> сообщения API: начинается с user, роли чередуются
function toMessages(history, lastUser) {
  const out = [];
  for (const m of [...history, { role: 'user', text: lastUser }]) {
    if (!m.text) continue;
    if (!out.length && m.role !== 'user') continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content += '\n\n' + m.text; else out.push({ role: m.role, content: m.text });
  }
  return out;
}

let client = null;
function getClient() {
  if (!client) {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic({ timeout: 120000, maxRetries: 2 });
  }
  return client;
}

async function askClaude(p, kbt) {
  const Anthropic = require('@anthropic-ai/sdk');
  const userText = `Данные журнала (обезличены):\n<data>\n${JSON.stringify(p.data)}\n</data>\n\nВопрос: ${p.question}`;
  try {
    const msg = await getClient().beta.messages.stream({
      model: AI.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // если модель откажется отвечать, API само повторит запрос на запасной модели
      output_config: { effort: AI.effort },
      system: [
        { type: 'text', text: SYSTEM },
        { type: 'text', text: 'База знаний:\n\n' + kbt.text, cache_control: { type: 'ephemeral' } },
      ],
      messages: toMessages(p.history, userText),
    }).finalMessage();
    if (msg.stop_reason === 'refusal') return { text: 'ИИ отказался отвечать на этот вопрос. Переформулируйте его.', model: msg.model, usage: msg.usage };
    let text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (msg.stop_reason === 'max_tokens') text += '\n\n(Ответ обрезан: слишком длинный.)';
    return { text: text || 'ИИ не дал ответа.', model: msg.model, usage: msg.usage };
  } catch (e) {
    const err = (code, m) => Object.assign(new Error(m), { httpCode: code });
    if (e instanceof Anthropic.AuthenticationError) throw err(502, 'Ключ ИИ не принят. Проверьте ANTHROPIC_API_KEY на сервере.');
    if (e instanceof Anthropic.PermissionDeniedError) throw err(502, 'У ключа ИИ нет доступа к модели ' + AI.model + '.');
    if (e instanceof Anthropic.RateLimitError) throw err(503, 'ИИ перегружен или исчерпан лимит. Попробуйте через минуту.');
    if (e instanceof Anthropic.BadRequestError) throw err(502, 'ИИ не принял запрос: ' + e.message);
    if (e instanceof Anthropic.APIConnectionError) throw err(502, 'Нет связи с api.anthropic.com. Нужен доступ сервера в интернет к этому адресу.');
    if (e instanceof Anthropic.APIError) throw err(502, `Ошибка ИИ (${e.status}).`);
    throw e;
  }
}

module.exports = function aiRoutes({ store, db, auth, readJson, HttpError, log }) {
  const used = new Map(); // login -> {day, n}
  const take = login => {
    const day = new Date().toISOString().slice(0, 10); const u = used.get(login);
    if (!u || u.day !== day) { used.set(login, { day, n: 1 }); return; }
    if (u.n >= AI.perDay) throw new HttpError(429, `Лимит вопросов ИИ на сегодня исчерпан (${AI.perDay}).`);
    u.n++;
  };

  return {
    'GET /api/ai/status': req => { auth(req); return { enabled: AI.enabled, mode: hasKey() ? 'claude' : 'test', model: hasKey() ? AI.model : null, perDay: AI.perDay }; },

    'POST /api/ai/chat': async req => {
      const u = auth(req);
      if (!AI.enabled) throw new HttpError(403, 'ИИ-помощник отключен на сервере');
      const b = await readJson(req);
      const question = String(b.question || '').trim().slice(0, 4000);
      if (!question) throw new HttpError(400, 'Пустой вопрос');
      const history = Array.isArray(b.history) ? b.history.filter(m => m && typeof m.text === 'string').map(m => ({ role: m.role, text: m.text.slice(0, 8000) })) : [];
      const useDemo = !!b.demo || !b.context;
      const ctx = useDemo ? demo.build() : b.context;
      if (!Array.isArray(ctx.people)) throw new HttpError(400, 'Нужен context.people');
      if (ctx.people.length > 5000 || (ctx.records || []).length > 20000) throw new HttpError(413, 'Слишком много данных для одного вопроса');

      // обезличивание; при малейшем подозрении на ПДн — не отправляем
      const p = core.pseudonymize(ctx, question, history);
      if (p.leaks.length) {
        store.audit(db, u.login, u.ip, 'ai.blocked', p.leaks.join(', '));
        throw new HttpError(422, 'Запрос не отправлен: после обезличивания в нем остались персональные данные (' + p.leaks.join(', ') + '). Уберите их из вопроса.');
      }
      const kbt = kbText();
      const sent = { question: p.question, history: p.history, data: p.data, knowledge: kbt.kb.map(k => k.title) };

      take(u.login);
      let mode, raw, model = null, usage = null;
      if (hasKey()) {
        try { const r = await askClaude(p, kbt); raw = r.text; model = r.model; usage = r.usage; mode = 'claude'; }
        catch (e) { if (e.httpCode) throw new HttpError(e.httpCode, e.message, { sent }); throw e; }
      } else { raw = core.demoAnswer(p.data, p.question, kbt.kb); mode = 'test'; }

      store.audit(db, u.login, u.ip, 'ai.ask', `${mode}${useDemo ? ' demo' : ''} q=${question.length} people=${ctx.people.length}` + (usage ? ` in=${usage.input_tokens} out=${usage.output_tokens}` : ''));
      return { answer: p.pseudo.restore(raw), mode, demo: useDemo, model, sent, raw };
    },
  };
};
module.exports.SYSTEM = SYSTEM;
module.exports.toMessages = toMessages;
