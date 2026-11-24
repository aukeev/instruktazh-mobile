/* Команды обслуживания:
   node cli.js create-admin <логин> ["ФИО"]   — создать администратора, выводит временный пароль
   node cli.js reset-password <логин>         — выдать новый временный пароль
   node cli.js users                          — список пользователей
   node cli.js backup                         — резервная копия сейчас */
'use strict';
process.removeAllListeners('warning');
const path = require('node:path');
const store = require('./store');
const db = store.open(process.env.DB_FILE || path.join(__dirname, 'data', 'journal.sqlite'));
const [cmd, login0, fio] = process.argv.slice(2);
const login = String(login0 || '').trim().toLowerCase();
const out = s => process.stdout.write(s + '\n');
const fail = s => { process.stderr.write(s + '\n'); process.exit(1); };

if (cmd === 'create-admin') {
  if (!/^[a-z0-9._-]{3,40}$/.test(login)) fail('Укажите логин латиницей: node cli.js create-admin admin');
  if (db.prepare('SELECT 1 FROM users WHERE login=?').get(login)) fail('Такой логин уже есть. Для нового пароля: node cli.js reset-password ' + login);
  const pass = store.genPass();
  db.prepare('INSERT INTO users(login,fio,role,unit,pass,created) VALUES(?,?,?,?,?,?)').run(login, fio || '', 'admin', '', store.hashPass(pass), store.now());
  store.audit(db, 'cli', null, 'user.add', `${login} admin`);
  out(`Администратор создан.\nЛогин:  ${login}\nПароль: ${pass}\nПри первом входе система попросит задать свой пароль.`);
} else if (cmd === 'reset-password') {
  if (!db.prepare('SELECT 1 FROM users WHERE login=?').get(login)) fail('Нет такого пользователя');
  const pass = store.genPass();
  db.prepare('UPDATE users SET pass=?, must_change=1, active=1 WHERE login=?').run(store.hashPass(pass), login);
  db.prepare('DELETE FROM sessions WHERE login=?').run(login);
  store.audit(db, 'cli', null, 'user.reset', login);
  out(`Новый временный пароль для ${login}: ${pass}`);
} else if (cmd === 'users') {
  for (const u of db.prepare('SELECT login, role, fio, active FROM users ORDER BY role, login').all()) out(`${u.active ? ' ' : 'x'} ${u.login.padEnd(20)} ${u.role.padEnd(10)} ${u.fio}`);
} else if (cmd === 'backup') {
  out('Готово: ' + store.backup(db, process.env.BACKUP_DIR || path.join(__dirname, 'backups'), +(process.env.BACKUP_KEEP_DAYS || 30)));
} else {
  out('Команды: create-admin <логин> ["ФИО"] | reset-password <логин> | users | backup');
}
db.close();
