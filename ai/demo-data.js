/* Демо-данные для тестового режима ИИ-помощника. Все ФИО и ИИН вымышленные.
   Даты считаются от сегодняшнего дня, чтобы всегда были просроченные, истекающие и в норме. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core'));
  else root.AI_DEMO = factory(root.AI_CORE);
})(typeof self !== 'undefined' ? self : this, function (core) {
  'use strict';
  const SURN = ['Ахметов', 'Бекова', 'Валиев', 'Галимова', 'Дюсенов', 'Ержанова', 'Жумабаев', 'Закирова', 'Исаев', 'Касымова', 'Лукин', 'Мусина', 'Нуров', 'Оспанова', 'Петренко', 'Рахимова', 'Сейтказин', 'Тулегенова', 'Умаров', 'Федорова', 'Хасенов', 'Цой', 'Шарипова', 'Ыбыраев', 'Юсупова', 'Ярков', 'Абдиев', 'Байжанова', 'Глебов', 'Есенова'];
  const NAME_M = ['Арман', 'Ерлан', 'Канат', 'Марат', 'Олег', 'Руслан', 'Тимур', 'Фарид'], NAME_F = ['Динара', 'Жанна', 'Лаура', 'Назира', 'Перизат', 'Сауле', 'Ульяна'];
  const PATR_M = ['Серикович', 'Маратович', 'Игоревич', 'Нурланович'], PATR_F = ['Болатовна', 'Ерлановна', 'Кайратовна', 'Сергеевна'];
  const SECT = [['ГНПС «Атасу»', 12], ['НПС «Каракойын»', 8], ['ЛПДС «Шагырлы»', 5], ['Аппарат управления', 5]];
  const POS = { 'ГНПС «Атасу»': ['Оператор НПС', 'Машинист технологических насосов', 'Электромонтер по ремонту и обслуживанию электрооборудования', 'Слесарь-ремонтник', 'Мастер', 'Лаборант химического анализа'], 'НПС «Каракойын»': ['Оператор НПС', 'Электрогазосварщик', 'Слесарь КИПиА', 'Водитель автомобиля'], 'ЛПДС «Шагырлы»': ['Линейный трубопроводчик', 'Машинист экскаватора', 'Мастер'], 'Аппарат управления': ['Инженер', 'Экономист', 'Специалист по кадрам'] };
  // сдвиг последнего повторного от сегодня (в днях) — по кругу дает разные статусы
  const SHIFT = [-30, -100, -85, -200, -60, -95, -10, -150, -80, -120, -45, -91];

  function build(today) {
    today = today || new Date().toISOString().slice(0, 10);
    const day = (n) => new Date(Date.parse(today) + n * 864e5).toISOString().slice(0, 10);
    const people = []; let k = 0;
    for (const [section, n] of SECT) for (let i = 0; i < n; i++, k++) {
      const female = /а$/.test(SURN[k % SURN.length]);
      const names = female ? NAME_F : NAME_M, patrs = female ? PATR_F : PATR_M;
      const fio = `${SURN[k % SURN.length]} ${names[(k * 3) % names.length]} ${patrs[(k * 5) % patrs.length]}`;
      const iin = String(800000000000 + k * 7919 + 101).slice(0, 12);
      const group = section === 'Аппарат управления' ? 'aux' : (i === 3 ? 'aux' : 'main');
      people.push(core.dueState({ iin, fio, pos: POS[section][i % POS[section].length], section, type: 'staff', group, lastPovt: day(SHIFT[k % SHIFT.length]), vvodDate: day(-400 - k * 13) }, today));
    }
    people.push({ iin: '870101400222', fio: 'Сапаров Алмас Бекович', pos: 'Монтажник (ТОО «Подрядчик-Демо»)', section: 'ГНПС «Атасу»', type: 'contractor', group: '', lastPovt: '', next: '', days: null, state: 'none', vvodDate: day(-5) });
    const master = people.find(p => p.section === 'ГНПС «Атасу»' && p.pos === 'Мастер');
    const records = people.filter(p => p.lastPovt).map((p, i) => ({
      no: `Ж2-${String(i + 1).padStart(4, '0')}`, date: p.lastPovt, kind: 'povt', journal: 'БПО-Ж2', section: p.section,
      person: { iin: p.iin, fio: p.fio }, instr: p === master ? { iin: '780505300111', fio: 'Кенжебаев Нурлан Асетович' } : { iin: master.iin, fio: master.fio },
      result: 'pass', status: 'closed', topic: 'Инструкция по БиОТ для профессии', cause: '',
    }));
    records.push({ no: 'Ж2-0100', date: day(-3), kind: 'vnep', journal: 'БПО-Ж2', section: 'ГНПС «Атасу»', person: { iin: people[1].iin, fio: people[1].fio }, instr: { iin: master.iin, fio: master.fio }, result: 'pass', status: 'closed', topic: 'Молния о происшествии', cause: 'Ознакомление с информационным письмом / молнией (п. 8.3.30)' });
    return {
      org: 'Карагандинское нефтепроводное управление АО «КазТрансОйл» (демо)', unit: 'Демо-подразделение', today,
      rule: 'Повторный: основное производство — раз в 3 мес., вспомогательные работы — раз в 6 мес. (п. 8.3.25 СТ КТО-2.007-2025)',
      people, records, programs: [{ code: 'ПИ-01', title: 'Программа первичного инструктажа на рабочем месте оператора НПС', kind: 'perv', ver: '1' }, { code: 'ПИ-02', title: 'Программа целевого инструктажа при работах по наряду-допуску', kind: 'cel', ver: '1' }],
    };
  }
  return { build };
});
