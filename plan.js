/*
 * «Потратить весь баланс»: подбор событий, которые вместе съедают
 * остаток карты почти целиком.
 *
 * Отдельным файлом и без DOM, как format.js: перебор можно проверить в Node.
 *
 * Кошельков два, и каждый тратится только на своё: кино — из «Кино»
 * (до 2000 ₽), остальное — из «Остального». Цель — остаток не больше SLACK по
 * тем кошелькам, на которые в выдаче вообще есть события: если кино под
 * фильтры не попало, его деньги потратить нечем, и в «остаток» они не идут.
 *
 * Событий 2–3, а с кино — до 5: сеанс стоит 400–800 ₽, и в три карточки
 * пять тысяч на двух кошельках не уложить.
 *
 * Полный перебор пятёрок из двух сотен событий невозможен, поэтому кошельки
 * перебираются по отдельности (они друг от друга не зависят): для каждого —
 * случайный обход с отсечением по сумме, который собирает наборы с маленьким
 * остатком. Потом наборы двух кошельков склеиваются. Случайный порядок
 * обхода и даёт разные подборки от нажатия к нажатию.
 */

var PLAN_SLACK = 200;
var PLAN_MAX = 3;
var PLAN_MAX_CINEMA = 5;
// Сколько наборов одного размера хватит для выбора и сколько шагов обхода не жалко.
var PLAN_ENOUGH = 150;
var PLAN_STEPS = 40000;
var PLAN_WALLETS = ['CINEMA', 'OTHER'];

/**
 * opts:
 *   items    — кандидаты (цена > 0, уже под фильтрами)
 *   left     — { CINEMA: ₽, OTHER: ₽ } — сколько осталось в кошельках
 *   walletOf — категория → кошелёк
 *   keep     — события, которые остаются в подборке (замена части карточек)
 *   avoid    — { eventId: true } — уже показанное; берётся, только если без него никак
 *   prefer   — сколько новых карточек ждём (замена N отмеченных)
 *   random   — источник случайности, по умолчанию Math.random
 *
 * Возвращает { items, spent, budget, rest, ok } или null, если не собрать ничего.
 */
function buildPlan(opts) {
  var keep = opts.keep || [];
  var random = opts.random || Math.random;
  var keepIds = {};
  keep.forEach(function (e) { keepIds[e.eventId] = true; });

  var base = { CINEMA: 0, OTHER: 0 };
  keep.forEach(function (e) { base[opts.walletOf(e.category)] += e.priceRub; });

  var pool = opts.items.filter(function (e) {
    var w = opts.walletOf(e.category);
    return !keepIds[e.eventId] && e.priceRub > 0 && base[w] + e.priceRub <= opts.left[w];
  });

  // Сначала без уже показанного: «собрать заново» должно давать новое. Но
  // если из нового в допуск не уложиться, повтор лучше большого остатка.
  var fresh = pool.filter(function (e) { return !(opts.avoid && opts.avoid[e.eventId]); });
  var first = pick(fresh);
  if (first && first.ok) { return first; }
  var all = fresh.length < pool.length ? pick(pool) : null;
  if (!first || (all && all.rest < first.rest)) { return all; }
  return first;

  function pick(cands) {
    var byWallet = { CINEMA: [], OTHER: [] };
    cands.forEach(function (e) { byWallet[opts.walletOf(e.category)].push(e); });
    // Кошелёк в деле, если на него есть что купить или что-то уже лежит в подборке.
    var usable = {};
    PLAN_WALLETS.forEach(function (w) { usable[w] = byWallet[w].length > 0 || base[w] > 0; });
    var budget = PLAN_WALLETS.reduce(function (s, w) { return usable[w] ? s + opts.left[w] : s; }, 0);

    var max = (usable.CINEMA ? PLAN_MAX_CINEMA : PLAN_MAX) - keep.length;
    if (max < 1) { return null; }

    var sets = {};
    PLAN_WALLETS.forEach(function (w) {
      sets[w] = usable[w] ? subsets(byWallet[w], opts.left[w] - base[w], max) : [{ list: [], rest: 0 }];
    });

    // Пары наборов запоминаются без склейки списков: их сотни тысяч, а
    // нужны только те, что близки к лучшему остатку.
    var found = [];
    var bestRest = Infinity;
    sets.CINEMA.forEach(function (a) {
      sets.OTHER.forEach(function (b) {
        var n = a.list.length + b.list.length;
        if (n < 1 || n > max || n + keep.length < 2) { return; }
        var rest = a.rest + b.rest;
        if (rest > Math.max(PLAN_SLACK, bestRest + 100)) { return; }
        found.push({ a: a, b: b, n: n, rest: rest });
        if (rest < bestRest) { bestRest = rest; }
      });
    });
    if (!found.length) { return null; }

    // В допуск укладываемся — выбираем среди всех таких. Нет — среди
    // ближайших к цели, чтобы и «худший» вариант менялся от нажатия к нажатию.
    var limit = bestRest <= PLAN_SLACK ? PLAN_SLACK : bestRest + 100;
    var good = found.filter(function (f) { return f.rest <= limit; });
    if (opts.prefer) {
      var exact = good.filter(function (f) { return f.n === opts.prefer; });
      if (exact.length) { good = exact; }
    }
    var choice = good[Math.floor(random() * good.length)];
    var items = keep.concat(choice.a.list, choice.b.list);
    return { items: items, spent: planSum(items), budget: budget, rest: choice.rest, ok: choice.rest <= PLAN_SLACK };
  }

  /* Наборы одного кошелька до maxK событий в сумме не больше cap. Каждый
   * размер перебирается отдельно и со своим запасом шагов: обход в глубину
   * иначе тонет в тройках и не доходит до редких пар, а без пар кино и
   * остальное вместе в пять карточек не влезают. Возвращает наборы с
   * остатком не больше SLACK, пустой набор и самые близкие из остальных. */
  function subsets(items, cap, maxK) {
    var order = shuffle(items.slice());
    var good = [];
    var near = [];
    for (var size = 1; size <= maxK; size++) {
      var found = 0;
      var steps = 0;
      (function walk(start, chosen, spent) {
        for (var i = start; i < order.length; i++) {
          if (++steps > PLAN_STEPS || found >= PLAN_ENOUGH) { return; }
          var s = spent + order[i].priceRub;
          if (s > cap) { continue; }
          chosen.push(order[i]);
          if (chosen.length < size) {
            walk(i + 1, chosen, s);
          } else if (cap - s <= PLAN_SLACK) {
            good.push({ list: chosen.slice(), rest: cap - s });
            found++;
          } else {
            near.push({ list: chosen.slice(), rest: cap - s });
          }
          chosen.pop();
        }
      })(0, [], 0);
    }
    near.sort(function (a, b) { return a.rest - b.rest; });
    return good.concat(near.slice(0, 40), [{ list: [], rest: cap }]);
  }

  function shuffle(list) {
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(random() * (i + 1));
      var t = list[i]; list[i] = list[j]; list[j] = t;
    }
    return list;
  }
}

function planSum(list) {
  return list.reduce(function (s, e) { return s + e.priceRub; }, 0);
}

const Plan = { build: buildPlan, SLACK: PLAN_SLACK };

if (typeof module !== 'undefined') { module.exports = Plan; }
