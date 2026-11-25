/* Встраивает ИИ-помощника в файл ЭЖИ v3.4 отдельным блоком <script> перед </body>.
   Остальной файл ЭЖИ не меняется. Повторный запуск заменяет прежний блок помощника.
   Запуск: node ai/embed-in-ezhi.js "ЭЖИ_v3.4.html" "ЭЖИ_v3.4_с_ИИ.html" */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('Укажите исходный файл ЭЖИ и имя нового файла'); process.exit(1); }
const START = '<!-- ИИ-ПОМОЩНИК: начало -->', END = '<!-- ИИ-ПОМОЩНИК: конец -->';
let html = fs.readFileSync(src, 'utf8');
const a = html.indexOf(START);
if (a >= 0) html = html.slice(0, a) + html.slice(html.indexOf(END) + END.length + 1);
const parts = ['core.js', 'knowledge.js', 'demo-data.js', 'chat.js', 'module-ezhi.js']
  .map(f => `/* ---- ai/${f} ---- */\n` + fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/<\/script/gi, '<\\/script'));
const block = `${START}\n<script>\n${parts.join('\n')}\n</script>\n${END}\n`;
const i = html.lastIndexOf('</body>');
if (i < 0) { console.error('В файле нет </body>'); process.exit(1); }
fs.writeFileSync(out, html.slice(0, i) + block + html.slice(i));
console.log('Готово:', out);
