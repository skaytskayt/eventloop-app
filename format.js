/*
 * Форматтеры карточки.
 *
 * Вынесены отдельным файлом намеренно: это единственная часть Mini App
 * без обращений к DOM, поэтому её можно загрузить в Node и проверить
 * автотестом. Поведение повторяет CardRenderer — бот и Mini App обязаны
 * называть цену, расстояние и дату одинаково.
 */

var RUB = new Intl.NumberFormat('ru-RU');
var NBSP = ' ';

var WHEN = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  weekday: 'long',
  hour: '2-digit',
  minute: '2-digit',
  // Пояс задан явно: в вебвью с другим системным поясом время уехало бы.
  timeZone: 'Europe/Moscow'
});

/** Цена билета. Ноль — это «бесплатно», а не «0 ₽»: иначе читается как сбой. */
function money(rub) {
  if (rub === 0) {
    return 'бесплатно';
  }
  if (rub === null || rub === undefined || isNaN(rub)) {
    return 'цена уточняется';
  }
  return RUB.format(rub) + NBSP + '₽';
}

/** Расстояние по прямой. До километра — в метрах, так понятнее «дойду пешком». */
function distance(km) {
  if (km === null || km === undefined || isNaN(km)) {
    return 'расстояние неизвестно';
  }
  if (km < 1) {
    return Math.round(km * 1000) + ' м';
  }
  return km.toFixed(1).replace('.', ',') + ' км';
}

/** Дата сеанса в московском поясе. */
function date(iso) {
  var parsed = new Date(iso);
  if (isNaN(parsed.getTime())) {
    return 'дата уточняется';
  }
  return WHEN.format(parsed);
}

/** Русские падежи после числа. Порт CardRenderer.plural один в один. */
function plural(n, one, few, many) {
  var mod100 = n % 100;
  var mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) {
    return many;
  }
  if (mod10 === 1) {
    return one;
  }
  if (mod10 >= 2 && mod10 <= 4) {
    return few;
  }
  return many;
}

const Fmt = { money: money, distance: distance, date: date, plural: plural };

if (typeof module !== 'undefined') { module.exports = Fmt; }
