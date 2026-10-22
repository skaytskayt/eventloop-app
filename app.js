/*
 * Поведение Mini App: подборка, свайп, избранное, подробная карточка.
 *
 * Разметка строится узлами через DOM API. HTML-строки не используются осознанно:
 * на следующем шаге в эти же поля приедут данные с сервера, и склейка строк
 * стала бы дырой. Состояние живёт в localStorage, а при открытии из MAX ещё и
 * на сервере — тогда источник истины сервер, а localStorage только кеш.
 */
(function () {
  'use strict';

  var KEY = 'eventloop.miniapp.v2';
  // Адрес бэкенда из meta eventloop-api. Пусто — тот же адрес, что у приложения.
  var API = (function () {
    var m = document.querySelector('meta[name="eventloop-api"]');
    return m ? (m.getAttribute('content') || '').replace(/\/+$/, '') : '';
  })();
  // Подписанный initData есть, только когда приложение открыто внутри MAX.
  // Без него сервер не узнает, чьи это отметки, и в /api не уходит ничего.
  var INIT = (function () {
    try {
      var d = window.WebApp && window.WebApp.initData;
      if (typeof d === 'string' && d) { return d; }
    } catch (e) { /* моста нет — открыто не из MAX */ }
    return '';
  })();
  var SVG = 'http://www.w3.org/2000/svg';
  var XLINK = 'http://www.w3.org/1999/xlink';

  var SCREENS = ['screen-welcome', 'screen-feed', 'screen-swipe', 'screen-favorites', 'screen-detail', 'screen-profile', 'screen-stats', 'screen-register'];
  var DARK = { 'screen-swipe': true };
  var NO_NAV = { 'screen-welcome': true, 'screen-detail': true, 'screen-stats': true, 'screen-register': true };

  // card — сколько на каждом кошельке Пушкинской карты. Приходит из бота
  // ссылкой, до этого считаем от полного номинала.
  // origin — точка отсчёта из бота, {lat, lon}; null — центр Москвы.
  var state = { screen: 'screen-welcome', tab: 'liked', index: 0, detail: null, back: 'screen-feed', liked: [], saved: [], disliked: [], bought: [], pending: null, card: null, cats: [], date: 'ANY', km: 10, open: null, undo: [], spentBase: null, editWallet: null, origin: null };

  /* ---- Мелкие помощники --------------------------------------------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined && text !== null) { n.textContent = String(text); }
    return n;
  }

  function icon(name, size) {
    var svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'ic' + (size ? ' ic--' + size : ''));
    var use = document.createElementNS(SVG, 'use');
    use.setAttribute('href', '#icon-' + name);
    use.setAttributeNS(XLINK, 'xlink:href', '#icon-' + name);
    svg.appendChild(use);
    return svg;
  }

  function photo(item, cls) {
    var box = el('div', cls);
    var img = el('img');
    img.src = item.photo;
    img.alt = '';
    img.loading = 'lazy';
    box.appendChild(img);
    return box;
  }

  /* ---- Короткая дата -------------------------------------------------
   * Fmt.date() собран под карточку бота и выводит день недели
   * («понедельник, 15 апреля, 11:00»), а на макете его нет. Менять format.js
   * нельзя — он синхронизирован с CardRenderer, поэтому короткий вариант здесь.
   */
  var shortDate = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow'
  });

  function whenText(iso) {
    return shortDate.format(new Date(iso)).replace(' в ', ', ');
  }

  /* ---- Состояние ------------------------------------------------------ */

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({
        liked: state.liked, saved: state.saved, disliked: state.disliked,
        bought: state.bought, pending: state.pending, card: state.card,
        spentBase: state.spentBase, undo: state.undo,
        cats: state.cats, date: state.date, km: state.km, origin: state.origin
      })); } catch (e) { /* приватный режим */ }
  }

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) { return; }
      var v = JSON.parse(raw);
      if (v && v.liked instanceof Array) { state.liked = v.liked; }
      if (v && v.saved instanceof Array) { state.saved = v.saved; }
      if (v && v.disliked instanceof Array) { state.disliked = v.disliked; }
      if (v && v.bought instanceof Array) { state.bought = v.bought.filter(validPurchase); }
      if (v && typeof v.pending === 'number') { state.pending = v.pending; }
      if (v && v.card && validAmount(v.card.CINEMA, 'CINEMA') && validAmount(v.card.OTHER, 'OTHER')) {
        state.card = { CINEMA: v.card.CINEMA, OTHER: v.card.OTHER };
      }
      if (v && v.spentBase && validAmount(v.spentBase.CINEMA, 'CINEMA') && validAmount(v.spentBase.OTHER, 'OTHER')) {
        state.spentBase = { CINEMA: v.spentBase.CINEMA, OTHER: v.spentBase.OTHER };
      }
      if (v && v.undo instanceof Array) { state.undo = v.undo.filter(function (id) { return typeof id === 'number'; }); }
      if (v && v.cats instanceof Array) { state.cats = v.cats; }
      if (v && DATES[v.date]) { state.date = v.date; }
      if (v && KMS.indexOf(v.km) >= 0) { state.km = v.km; }
      if (v && v.origin && validOrigin(v.origin.lat, v.origin.lon)) {
        state.origin = { lat: v.origin.lat, lon: v.origin.lon };
      }
    } catch (e) { /* пустое хранилище — не ошибка */ }
  }

  function validOrigin(lat, lon) {
    return typeof lat === 'number' && isFinite(lat) && lat >= -90 && lat <= 90
        && typeof lon === 'number' && isFinite(lon) && lon >= -180 && lon <= 180;
  }

  function validAmount(value, code) {
    return typeof value === 'number' && isFinite(value)
        && value >= 0 && value <= WALLETS[code].share;
  }

  /* Суммы от бота. Кнопка бота открывает приложение внутри MAX и кладёт их
   * в параметр запуска как «1200_2500» (кино_остальное): MAX пропускает туда
   * только латиницу, цифры, «_» и «-». Старый вид ?cinema=1200&other=2500
   * тоже понимаем — для прямой ссылки. Суммы приходят извне, поэтому
   * проверяются как чужой ввод. Свежая ссылка важнее сохранённого — человек
   * мог сходить в бот именно затем, чтобы поправить суммы.
   *
   * Кошельки читаются независимо: если бот передал только один параметр,
   * второй остаётся прежним, а не обнуляется.
   *
   * С точкой отсчёта бот шлёт четыре части: «1200_2500_557961_491064» —
   * суммы те же, координаты разбирает readOriginFromLink. */
  function startParam(params) {
    try {
      var p = window.WebApp && window.WebApp.initDataUnsafe && window.WebApp.initDataUnsafe.start_param;
      if (typeof p === 'string' && p) { return p; }
    } catch (e) { /* моста нет — открыто не из MAX */ }
    return params.get('WebAppStartParam') || '';
  }

  // Параметр кнопки статистики из команды /stats. Пара к Screens.STATS_PAYLOAD;
  // синхронность проверяет ScreensMiniAppTest.
  var STATS_PARAM = 'stats';

  function openedForStats() {
    try {
      return startParam(new URLSearchParams(location.search)) === STATS_PARAM;
    } catch (e) {
      return false;
    }
  }

  // Кнопка бота после анкеты кладёт в параметр суммы — значит, анкета пройдена.
  function openedFromBot() {
    try {
      return /^\d+_\d+/.test(startParam(new URLSearchParams(location.search)));
    } catch (e) {
      return false;
    }
  }

  /* Без анкеты в боте у приложения нет ни баланса, ни точки, и подборка была
   * бы чужой. Открыли не кнопкой бота — спрашиваем сервер, прошёл ли человек
   * анкету. Сеть или сервер подвели — не запираем: лучше подборка по умолчанию,
   * чем пустой экран. */
  function checkRegistered() {
    if (!INIT) { return; }
    try {
      fetch(API + '/api/me', { headers: { 'X-Init-Data': INIT } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (me) {
          if (me && me.registered === false) { closeAsk(); go('screen-register'); }
        })
        .catch(function () { /* нет связи — пускаем как есть */ });
    } catch (e) { /* WebView без fetch */ }
  }

  // Внутри MAX ссылку на бота открывает мост, иначе — обычный переход.
  function openBot(e) {
    var url = e.currentTarget.href;
    try {
      if (window.WebApp && typeof window.WebApp.openMaxLink === 'function') {
        e.preventDefault();
        window.WebApp.openMaxLink(url);
      }
    } catch (err) { /* остаётся обычная ссылка */ }
  }

  function readBalanceFromLink() {
    var params;
    try {
      params = new URLSearchParams(location.search);
    } catch (e) {
      return;
    }
    var fromBot = /^(\d+)_(\d+)(?:_-?\d{1,7}_-?\d{1,7})?$/.exec(startParam(params));
    var amounts = fromBot ? { cinema: fromBot[1], other: fromBot[2] } : {};
    var changed = false;
    [['cinema', 'CINEMA'], ['other', 'OTHER']].forEach(function (pair) {
      var raw = pair[0] in amounts ? amounts[pair[0]] : params.get(pair[0]);
      if (raw === null || raw.trim() === '') { return; }
      var value = Math.round(Number(raw));
      if (!validAmount(value, pair[1])) { return; }
      state.card[pair[1]] = value;
      state.spentBase[pair[1]] = spentIn(pair[1]);
      changed = true;
    });
    if (changed) { save(); }
  }

  /* Точка отсчёта от бота: широта и долгота, умноженные на 10000, — целыми,
   * потому что точку и кириллицу MAX в параметр не пропускает. Ссылка без
   * координат пришла из старой кнопки без точки — свежая ссылка важнее сохранённого,
   * как с суммами. Прямая ссылка без параметра сохранённое не трогает. */
  function readOriginFromLink() {
    var params;
    try {
      params = new URLSearchParams(location.search);
    } catch (e) {
      return;
    }
    var m = /^\d+_\d+(?:_(-?\d{1,7})_(-?\d{1,7}))?$/.exec(startParam(params));
    if (!m) { return; }
    if (m[1] === undefined) {
      state.origin = null;
    } else {
      var lat = Number(m[1]) / 10000;
      var lon = Number(m[2]) / 10000;
      if (!validOrigin(lat, lon)) { return; }
      state.origin = { lat: lat, lon: lon };
    }
    save();
  }

  /* Записи о покупках правят баланс, поэтому из хранилища берём только
   * целые: кошелёк из известных, цена числом. Битая запись молча уронила бы
   * арифметику всей карты. */
  function validPurchase(b) {
    return b && typeof b.eventId === 'number' && typeof b.priceRub === 'number' && !!WALLETS[b.wallet];
  }

  /* ---- Точка отсчёта и город ленты -------------------------------------
   * Расстояние считается здесь, а не лежит в data.js: оно зависит от точки,
   * выбранной в боте. Город ленты — тот, чей центр ближе к точке.
   */
  var CITIES = {
    moscow: { title: 'Москва', lat: 55.7558, lon: 37.6173 },
    kazan: { title: 'Казань', lat: 55.7961, lon: 49.1064 }
  };

  // Та же формула и тот же радиус, что geo/Haversine.java.
  function haversineKm(lat1, lon1, lat2, lon2) {
    var rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad;
    var dLon = (lon2 - lon1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function originPoint() {
    return state.origin || CITIES.moscow;
  }

  function cityCode() {
    var p = originPoint();
    var best = null;
    var bestKm = Infinity;
    Object.keys(CITIES).forEach(function (code) {
      var km = haversineKm(p.lat, p.lon, CITIES[code].lat, CITIES[code].lon);
      if (km < bestKm) { bestKm = km; best = code; }
    });
    return best;
  }

  function originLabel() {
    if (!state.origin) { return 'Москва · центр'; }
    // Названия точки payload не несёт: только координаты, по ним — город.
    return CITIES[cityCode()].title + ' · по вашей точке';
  }

  /* Лента и счётчики — только своего города. Избранное, купленное и якоря
   * вкуса ищутся по всей афише (MOCK_EVENTS): смена города не должна их терять. */
  var FEED = [];

  function prepareFeed() {
    var p = originPoint();
    var city = cityCode();
    MOCK_EVENTS.forEach(function (e) {
      e.distanceKm = Math.round(haversineKm(p.lat, p.lon, e.venueLat, e.venueLon) * 10) / 10;
    });
    FEED = MOCK_EVENTS.filter(function (e) { return e.city === city; });
  }

  function loadFeed() { return FEED; }

  function marked(id) {
    return state.liked.indexOf(id) >= 0 || state.saved.indexOf(id) >= 0
      || state.disliked.indexOf(id) >= 0 || isBought(id);
  }

  /* ---- Кошельки Пушкинской карты --------------------------------------
   * Номинал разделён на два счёта: кино оплачивается только из своего,
   * всё остальное — из общего. Списывает подтверждённая покупка, а не
   * отметка «Пойду»: отметка ничего не стоит и её можно снять.
   *
   * В боте (BalanceService) та же карта посчитана иначе: 5000 ₽ общих, из
   * которых на кино доступно не больше 2000 ₽. При склейке Mini App с
   * сервером одну из двух моделей придётся выбрать.
   */
  var WALLETS = {
    CINEMA: { share: 2000, title: 'Кино' },
    OTHER: { share: 3000, title: 'Остальное' }
  };

  var WALLET_ORDER = ['CINEMA', 'OTHER'];

  // Пока бот не сказал иного, считаем карту полной. Номиналы берутся отсюда же,
  // чтобы 2000 и 3000 не разъехались по двум местам.
  state.card = { CINEMA: WALLETS.CINEMA.share, OTHER: WALLETS.OTHER.share };
  state.spentBase = { CINEMA: 0, OTHER: 0 };

  /* Сколько на каждом кошельке. Бот узнаёт обе суммы и передаёт их в параметре
   * запуска кнопки (1200_2500). Без параметров считаем от полного
   * номинала: приложение должно открываться и по прямой ссылке, без бота. */
  function limitOf(code) {
    return state.card[code];
  }

  function walletOf(category) { return category === 'CINEMA' ? 'CINEMA' : 'OTHER'; }

  function spentIn(wallet) {
    return state.bought.reduce(function (sum, b) {
      return b.wallet === wallet ? sum + b.priceRub : sum;
    }, 0);
  }

  /* Введённый вручную баланс — это остаток «здесь и сейчас», поэтому билеты,
   * купленные до правки, второй раз не вычитаются. spentBase помнит, сколько
   * было потрачено на момент ввода; вычитается только то, что потрачено после. */
  function spentSince(wallet) {
    return Math.max(0, spentIn(wallet) - state.spentBase[wallet]);
  }

  function leftIn(wallet) {
    return Math.max(0, limitOf(wallet) - spentSince(wallet));
  }

  function isBought(eventId) {
    return state.bought.some(function (b) { return b.eventId === eventId; });
  }

  /* Fmt.money(0) отдаёт «бесплатно», и для цены билета это верно. Для остатка
   * на карте — нет: пустой кошелёк это ноль рублей, а не бесплатный вход.
   * Пробел неразрывный, как в Fmt.money. */
  function rub(amount) {
    return amount === 0 ? '0 ₽' : Fmt.money(amount);
  }

  /* Неоценённое — без оглядки на фильтры. По нему решается, дошёл ли человек
   * до конца подборки: пустая колода под фильтром это другой случай.
   * Прошедшие сеансы не в счёт: колода их не показывает, оценить их нельзя,
   * и без этой проверки подборка никогда не считалась бы разобранной. */
  function unseen() {
    var now = Date.now();
    return loadFeed().filter(function (e) {
      return new Date(e.startsAt).getTime() >= now && !marked(e.eventId);
    });
  }

  /* Всё, что подходит под фильтры, вместе с уже оценённым: по нему считается
   * «сколько из скольких», иначе счётчик показывал бы дробь от всей афиши. */
  function pool() {
    return loadFeed().filter(fits);
  }

  /* Колода по вкусу: сверху то, что похоже на уже отмеченное. Без истории —
   * исходный порядок, иначе первая же подборка выглядела бы случайной. */
  function deck() {
    var list = pool().filter(function (e) { return !marked(e.eventId); });
    var refs = anchors();
    if (!refs.length) { return list; }
    var scored = list.map(function (e, i) { return { item: e, i: i, score: taste(e, refs).score }; });
    // Равные — по исходному индексу явно: стабильность sort в старых
    // WebView не гарантирована.
    scored.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
    return scored.map(function (s) { return s.item; });
  }

  // За что кандидат похож на опорное событие. Категория весит больше всего:
  // кто лайкнул три спектакля, хочет театр, а не просто что-то рядом.
  var TASTE = { category: 3, venue: 2, price: 1, distance: 1 };
  // Вклад опорного события: «Пойду» и покупка — явный вкус, отложенное —
  // полусогласие, дизлайк тянет похожее вниз.
  var WEIGHT = { liked: 1, bought: 1, saved: 0.5, disliked: -1 };

  function anchors() {
    var out = [];
    function add(ids, kind) {
      ids.forEach(function (id) {
        var e = byEventId(id);
        if (e) { out.push({ item: e, kind: kind, weight: WEIGHT[kind] }); }
      });
    }
    add(state.liked, 'liked');
    add(state.bought.map(function (b) { return b.eventId; }), 'bought');
    add(state.saved, 'saved');
    add(state.disliked, 'disliked');
    return out;
  }

  function likeness(a, b) {
    var s = 0;
    if (a.category === b.category) { s += TASTE.category; }
    if (a.venueName === b.venueName) { s += TASTE.venue; }
    if (Math.abs(a.priceRub - b.priceRub) <= 0.3 * b.priceRub) { s += TASTE.price; }
    if (Math.abs(a.distanceKm - b.distanceKm) <= 2) { s += TASTE.distance; }
    return s;
  }

  /* Счёт кандидата и событие, которое внесло в него больше всего. Объяснять
   * выбор можно только тем, что человеку понравилось, поэтому because —
   * только из «Пойду» и купленного. */
  function taste(item, refs) {
    var score = 0, best = 0, because = null;
    (refs || anchors()).forEach(function (r) {
      var part = r.weight * likeness(item, r.item);
      score += part;
      if ((r.kind === 'liked' || r.kind === 'bought') && part > best) {
        best = part;
        because = r.item;
      }
    });
    return { score: score, because: because };
  }

  function becauseLine(item) {
    var t = taste(item);
    if (t.score <= 0 || !t.because) { return null; }
    return el('p', 'because', reason(item, t.because));
  }

  /* Подпись называет, чем именно похоже: «понравилось» звучало натянуто —
   * человек отметил «Пойду», а не рассказал, что ему нравится. Площадка
   * важнее категории: «там же» конкретнее, чем «тоже театр». */
  var ALSO = { THEATRE: 'Тоже театр', CINEMA: 'Тоже кино', MUSEUM: 'Тоже выставка', CONCERT: 'Тоже концерт', EXCURSION: 'Тоже экскурсия' };

  function reason(item, ref) {
    var name = ref.title.length > 40 ? ref.title.slice(0, 39).trim() + '…' : ref.title;
    if (item.venueName === ref.venueName) { return 'Там же, где «' + name + '»'; }
    if (item.category === ref.category && ALSO[item.category]) { return ALSO[item.category] + ', как «' + name + '»'; }
    return 'Похоже на «' + name + '»';
  }

  function fits(e) {
    if (state.cats.length && state.cats.indexOf(e.category) < 0) { return false; }
    if (e.distanceKm > state.km) { return false; }
    var b = bounds(state.date, Date.now());
    var t = new Date(e.startsAt).getTime();
    return t >= b.from && (b.until === null || t < b.until);
  }

  /* Границы дат считаются в московском времени, как DateFilter в боте:
   * смещение +03:00 постоянное, перевода часов в России нет. Нижняя граница
   * всегда «сейчас» — прошедший сеанс не показываем ни под каким фильтром. */
  var MSK = 3 * 3600000;

  function dayStart(ms, plusDays) {
    var d = new Date(ms + MSK);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (plusDays || 0)) - MSK;
  }

  function bounds(kind, now) {
    var dow = new Date(now + MSK).getUTCDay();
    var toSunday = dow === 0 ? 0 : 7 - dow;
    switch (kind) {
      case 'TODAY': return { from: now, until: dayStart(now, 1) };
      case 'TOMORROW': return { from: dayStart(now, 1), until: dayStart(now, 2) };
      case 'WEEKEND': {
        var toSaturday = dow === 6 || dow === 0 ? 0 : 6 - dow;
        return { from: Math.max(now, dayStart(now, toSaturday)), until: dayStart(now, toSunday + 1) };
      }
      // «На этой неделе» — до конца воскресенья, а не семь дней вперёд.
      case 'WEEK': return { from: now, until: dayStart(now, toSunday + 1) };
      default: return { from: now, until: null };
    }
  }

  function listOf(kind) {
    var ids = kind === 'liked' ? state.liked : state.saved;
    return MOCK_EVENTS.filter(function (e) { return ids.indexOf(e.eventId) >= 0; });
  }

  function mark(item, kind) {
    forget(item.eventId);
    state[kind].push(item.eventId);
    save();
  }

  // Было drop(), но ниже объявлена одноимённая drop() для кнопки фильтра, и
  // она перекрывала эту: отметки не снимались вовсе.
  function forget(id) {
    state.liked = state.liked.filter(function (x) { return x !== id; });
    state.saved = state.saved.filter(function (x) { return x !== id; });
    state.disliked = state.disliked.filter(function (x) { return x !== id; });
    save();
  }

  /* ---- Синхронизация с сервером ----------------------------------------
   * Только при открытии из MAX: без подписанного initData ни одного запроса
   * к /api не уходит. Ответа интерфейс не ждёт — сеть может отвалиться,
   * а свайп должен оставаться мгновенным. */
  var NEUTRAL = { VIEW: true, CLICK_BUY: true, PURCHASE_NO: true };
  // Было ли с запуска действие, меняющее отметки. Тогда ответ pull() уже
  // устарел и применять его нельзя — откатил бы только что сделанную оценку.
  var touched = false;
  var seen = {};

  function send(action, eventId) {
    if (!INIT) { return; }
    var item = byEventId(eventId);
    if (!item) { return; }
    if (!NEUTRAL[action]) { touched = true; }
    try {
      fetch(API + '/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Init-Data': INIT },
        body: JSON.stringify({ eventId: item.eventId, action: action, priceRub: item.priceRub, category: item.category, city: item.city }),
        // «Купить билет» уводит на сайт кассы — запрос должен это пережить.
        keepalive: true
      }).catch(function () { /* сеть — не повод мешать свайпу */ });
    } catch (e) { /* WebView без fetch — работаем на localStorage */ }
  }

  // Просмотр считается один раз за сессию: перерисовки не должны раздувать воронку.
  function viewed(item) {
    if (seen[item.eventId]) { return; }
    seen[item.eventId] = true;
    send('VIEW', item.eventId);
  }

  function pull() {
    if (!INIT) { return; }
    try {
      fetch(API + '/api/me/reactions', { headers: { 'X-Init-Data': INIT } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(applyServer)
        .catch(function () { /* нет связи — остаётся локальное */ });
    } catch (e) { /* WebView без fetch */ }
  }

  /* Сервер — источник истины, но пустой ответ локальное не стирает: первый
   * запуск после обновления не должен терять прежнюю историю браузера.
   * Ответ — внешние данные, поэтому битые записи пропускаются. Ожидающий
   * вопрос о покупке, фильтры, кошельки и стопка undo остаются как были. */
  function applyServer(list) {
    if (!Array.isArray(list) || !list.length || touched) { return; }
    var lists = { LIKED: 'liked', SAVED: 'saved', DISLIKED: 'disliked' };
    var fresh = { liked: [], saved: [], disliked: [], bought: [] };
    list.forEach(function (r) {
      if (!r || typeof r.eventId !== 'number') { return; }
      if (lists[r.kind]) {
        fresh[lists[r.kind]].push(r.eventId);
      } else if (r.kind === 'BOUGHT') {
        var b = { eventId: r.eventId, priceRub: r.priceRub, wallet: walletOf(r.category), at: r.at };
        if (validPurchase(b)) { fresh.bought.push(b); }
      }
    });
    state.liked = fresh.liked;
    state.saved = fresh.saved;
    state.disliked = fresh.disliked;
    state.bought = fresh.bought;
    save();
    render();
  }

  function go(screen) {
    var from = state.screen;
    var leaving = from === 'screen-welcome' && screen !== from ? document.getElementById(from) : null;
    state.screen = screen;
    render();
    if (leaving && !reducedMotion()) { slideAway(leaving, document.getElementById(state.screen)); }
  }

  function reducedMotion() {
    return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* Переход с главного экрана — перелистывание: главный уезжает влево
   * с того места, куда его дотянули, а следующий экран едет вплотную за ним
   * справа. Оба движутся одной анимацией, между ними нет пустоты. */
  function slideAway(leaving, entering) {
    var W = document.querySelector('.app').offsetWidth;
    var m = /translateX\((-?[\d.]+)px\)/.exec(leaving.style.transform || '');
    var dx = m ? parseFloat(m[1]) : 0;
    [leaving, entering].forEach(function (el) {
      if (el.getAnimations) { el.getAnimations().forEach(function (a) { a.cancel(); }); }
    });
    leaving.style.top = entering.offsetTop + 'px';
    leaving.classList.add('is-leaving');
    entering.classList.remove('is-peek');
    entering.style.transform = '';
    entering.style.top = '';
    var opts = { duration: 420, easing: 'cubic-bezier(.22, .8, .24, 1)' };
    var out = leaving.animate([{ transform: 'translateX(' + dx + 'px)' }, { transform: 'translateX(' + (-W) + 'px)' }], opts);
    entering.animate([{ transform: 'translateX(' + (dx + W) + 'px)' }, { transform: 'translateX(0)' }], opts);
    leaving.style.transform = '';
    out.onfinish = function () {
      leaving.classList.remove('is-leaving');
      leaving.style.top = '';
    };
  }

  /* ---- Сборка кусков карточки ---------------------------------------- */

  function metaRow(name, text) {
    var row = el('div', 'meta');
    row.appendChild(icon(name, 14));
    row.appendChild(el('span', null, text));
    return row;
  }

  function priceBlock(item, withFrom) {
    var p = el('div', 'price');
    if (withFrom) { p.appendChild(el('span', 'price__from', 'от')); }
    p.appendChild(el('span', 'price__value', Fmt.money(item.priceRub)));
    p.appendChild(el('span', 'price__note', 'по Пушкинской карте'));
    return p;
  }

  /* В ряду стоит пара решений — «да» и «нет». «Отложить» это не решение,
   * а откладывание решения, поэтому она ушла отдельной кнопкой ниже. */
  function actions(item) {
    var box = el('div', 'actions');

    var like = el('button', 'btn btn--like');
    like.type = 'button';
    like.appendChild(icon('heart-fill', 18));
    like.appendChild(el('span', null, 'Пойду'));
    like.addEventListener('click', function () { react(item, 'liked'); });

    var no = el('button', 'btn btn--no');
    no.type = 'button';
    no.appendChild(icon('close', 18));
    no.appendChild(el('span', null, 'Не нравится'));
    no.addEventListener('click', function () { react(item, 'disliked'); });

    box.appendChild(no);
    box.appendChild(like);
    return box;
  }

  var REACTED = {
    liked: 'Добавили в «Пойду»',
    saved: 'Отложили в избранное',
    disliked: 'Скрыли из подборки'
  };

  var ACTION = { liked: 'LIKE', saved: 'SAVE', disliked: 'DISLIKE' };

  function react(item, kind) {
    state.undo.push(item.eventId);
    if (state.undo.length > 30) { state.undo.shift(); }
    mark(item, kind);
    send(ACTION[kind], item.eventId);
    if (state.index >= deck().length) { state.index = 0; }
    if (state.screen === 'screen-detail') {
      // Открытая карточка — единственное место, где оценка ничего не меняла на
      // экране: подборка листает дальше, а здесь та же карточка оставалась
      // висеть, хотя событие уже уехало в другой список. Решение принято,
      // поэтому карточка закрывается, а подсказка говорит куда.
      go(state.back);
      toast(REACTED[kind]);
      return;
    }
    // Экран не меняем: раньше первая же оценка перебрасывала со светлой подборки
    // на тёмный экран свайпа, и это читалось как сбой, а не как продолжение.
    // Подсказка здесь не нужна — колода листается дальше, это и есть ответ.
    render();
  }

  /* Карточка открывается нажатием в любом месте, кроме кнопок и ссылок:
   * попадать в фотографию неудобно, особенно на телефоне. */
  function openOnTap(host, item, from) {
    host.addEventListener('click', function (e) {
      if (host.dragged) { return; }
      if (e.target.closest('button, a')) { return; }
      openDetail(item, from);
    });
  }

  function openDetail(item, from) {
    state.detail = item.sessionId;
    state.back = state.screen;
    state.opening = true;
    // Откуда открыли. Карточка подборки переезжает на место карточки
    // мероприятия, а не появляется заново.
    state.fromRect = from ? from.getBoundingClientRect() : null;
    state.flyBack = !!from;
    go('screen-detail');
  }

  /* ---- Фильтры --------------------------------------------------------- */

  function renderFilters(hostId) {
    var host = document.getElementById(hostId);
    host.replaceChildren();

    var row = el('div', 'drops');
    row.appendChild(drop('date', DATES[state.date], state.date !== 'ANY'));
    row.appendChild(drop('cats', catsLabel(), state.cats.length > 0));
    row.appendChild(drop('km', 'До ' + state.km + ' км', state.km !== DEFAULT_KM));
    host.appendChild(row);

    if (state.open) { host.appendChild(menu(state.open)); }
  }

  /* Кнопка ряда подсвечивается, когда фильтр отличается от значения по
   * умолчанию: так видно, что выдача сужена, даже при закрытом списке. */
  function drop(kind, text, on) {
    var b = el('button', 'drop' + (on ? ' drop--on' : '') + (state.open === kind ? ' drop--open' : ''));
    b.type = 'button';
    b.appendChild(el('span', 'drop__text', text));
    b.appendChild(el('span', 'drop__caret'));
    b.addEventListener('click', function () {
      state.open = state.open === kind ? null : kind;
      render();
    });
    return b;
  }

  // Дата и радиус — один вариант, список закрывается сразу. Категорий можно
  // отметить несколько, поэтому их список остаётся открытым.
  function menu(kind) {
    var box = el('div', 'menu');
    if (kind === 'date') {
      Object.keys(DATES).forEach(function (code) {
        box.appendChild(option(DATES[code], state.date === code, function () { state.date = code; applyFilters(true); }));
      });
    } else if (kind === 'km') {
      KMS.forEach(function (km) {
        box.appendChild(option('До ' + km + ' км', state.km === km, function () { state.km = km; applyFilters(true); }));
      });
    } else {
      box.appendChild(option('Все категории', !state.cats.length, function () { state.cats = []; applyFilters(false); }));
      CATS.forEach(function (code) {
        var on = state.cats.indexOf(code) >= 0;
        box.appendChild(option(Cat.title(code), on, function () {
          state.cats = on
            ? state.cats.filter(function (c) { return c !== code; })
            : state.cats.concat([code]);
          applyFilters(false);
        }));
      });
    }
    return box;
  }

  function option(text, on, onClick) {
    var b = el('button', 'menu__item' + (on ? ' menu__item--on' : ''), text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function applyFilters(close) {
    if (close) { state.open = null; }
    state.index = 0;
    save();
    render();
  }

  function resetFilters() {
    state.date = 'ANY';
    state.cats = [];
    state.km = DEFAULT_KM;
    state.open = null;
    state.index = 0;
    save();
  }

  /* Подборка пуста — вместо карточки блок с картинкой, прямо в подборке:
   * заголовок и фильтры остаются над ним, их можно сразу поменять.
   * Два случая: под фильтрами всё уже оценено — или под них вообще
   * не подходит ни одно событие. */
  function emptyBanner() {
    var box = el('div', 'done done--inline');
    var img = el('img', 'done__art');
    img.src = 'assets/pushkin-card-3d.png';
    img.alt = '';
    box.appendChild(img);

    if (!unseen().length) {
      // Оценено всё, что вообще можно показать.
      var title = el('h2', 'done__title', 'Вы просмотрели');
      title.appendChild(el('br'));
      title.appendChild(document.createTextNode('все события'));
      box.appendChild(title);
      box.appendChild(el('p', 'done__sub', 'Но это не повод расстраиваться! Вы можете перейти в понравившееся мероприятие и добавить его в избранное.'));
      var fav = el('button', 'btn btn--primary done__btn');
      fav.type = 'button';
      fav.appendChild(icon('bookmark', 18));
      fav.appendChild(el('span', null, 'Перейти в избранное'));
      var arrow = icon('back', 18);
      arrow.classList.add('ic--flip');
      fav.appendChild(arrow);
      fav.addEventListener('click', function () {
        state.tab = 'liked';
        go('screen-favorites');
      });
      box.appendChild(fav);
    } else if (pool().length) {
      // Подборка разобрана до конца, но за границами фильтра осталось
      // неоценённое. Это успех, а не пустой поиск, и говорить об этом
      // надо соответственно: человек всё сделал, просто хочет ещё.
      var rest = unseen().length;
      box.appendChild(el('h2', 'done__title', 'Подборка закончилась'));
      box.appendChild(el('p', 'done__sub', 'Ты разобрал всё, что подходит под фильтры. За их границами ждёт ещё '
        + rest + ' ' + Fmt.plural(rest, 'событие', 'события', 'событий')
        + ': расширь радиус или смени дату.'));
      box.appendChild(bannerButton('Показать остальные'));
    } else {
      // Под фильтры не подходит вообще ничего — вот это и есть пустой поиск.
      box.appendChild(el('h2', 'done__title', 'Ничего не нашлось'));
      box.appendChild(el('p', 'done__sub', 'Под выбранные фильтры событий нет. Попробуй другую дату, категорию или радиус.'));
      box.appendChild(bannerButton('Сбросить фильтры'));
    }
    return box;
  }

  function bannerButton(text) {
    var b = el('button', 'btn btn--ghost done__btn', text);
    b.type = 'button';
    b.addEventListener('click', function () {
      resetFilters();
      render();
    });
    return b;
  }

  function catsLabel() {
    if (!state.cats.length) { return 'Категории'; }
    var first = Cat.title(state.cats[0]);
    return state.cats.length === 1 ? first : first + ' +' + (state.cats.length - 1);
  }

  /* ---- Экран 1: подборка ---------------------------------------------- */

  function renderFeed() {
    var slot = document.getElementById('feed-card');
    slot.replaceChildren();
    document.getElementById('feed-back').hidden = !state.undo.length;

    var list = deck();
    if (!list.length) {
      document.getElementById('feed-counter').textContent = '';
      document.getElementById('feed-bar').style.width = '0';
      slot.appendChild(emptyBanner());
      return;
    }

    // Счётчик и полоса прямо на входе: без них непонятно, что это лента,
    // а не единственное предложение.
    if (state.index >= list.length) { state.index = 0; }
    var total = pool().length;
    var shown = total - list.length + state.index + 1;
    document.getElementById('feed-counter').textContent = shown + '/' + total;
    document.getElementById('feed-bar').style.width = Math.round(shown / total * 100) + '%';

    var item = list[state.index];
    // render() рисует подборку и под приветствием — просмотр только на её экране.
    if (state.screen === 'screen-feed') { viewed(item); }
    var card = el('article', 'bigcard');

    var ph = photo(item, 'bigcard__photo');
    ph.appendChild(el('span', 'counter', shown + '/' + total));
    card.appendChild(ph);

    var body = el('div', 'bigcard__body');
    body.appendChild(el('span', 'badge', Cat.title(item.category)));
    body.appendChild(el('h2', 'card__title', item.title));
    var why = becauseLine(item);
    if (why) { body.appendChild(why); }
    body.appendChild(metaRow('calendar', whenText(item.startsAt)));
    body.appendChild(metaRow('pin', item.venueName + ' · ' + Fmt.distance(item.distanceKm)));
    body.appendChild(priceBlock(item, false));
    body.appendChild(actions(item));
    body.appendChild(saveButton(item));
    card.appendChild(body);

    attachSwipe(card, item);
    slot.appendChild(card);

    // Возврат из карточки мероприятия: карточка подборки стартует с того
    // места, где была открытая карточка. Если событие там уже другое
    // (его оценили внутри), переезд не нужен — ехала бы чужая карточка.
    var from = state.returnRect;
    state.returnRect = null;
    if (from && item.sessionId === state.detail) { flyFrom(card, from); }
  }

  /* «Отложить» — отказ от выбора прямо сейчас, поэтому отдельной строкой
   * под парой «да / нет», а не наравне с ними. */
  function saveButton(item) {
    var b = el('button', 'skip-pill');
    b.type = 'button';
    b.appendChild(icon('star', 16));
    b.appendChild(el('span', null, 'Отложить'));
    b.addEventListener('click', function () { react(item, 'saved'); });
    return b;
  }

  /* Маршрут в Яндекс Картах на общественном транспорте. Без точки из бота
   * старт пустой — Карты сами подставят текущее местоположение. */
  function routeUrl(item) {
    var from = state.origin ? state.origin.lat + ',' + state.origin.lon : '';
    return 'https://yandex.ru/maps/?rtext=' + encodeURIComponent(from + '~' + item.venueLat + ',' + item.venueLon)
      + '&rtt=mt';
  }

  function routeButton(item) {
    var a = el('a', 'btn btn--primary btn--route');
    a.href = routeUrl(item);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.appendChild(icon('map', 18));
    a.appendChild(el('span', null, 'Маршрут'));
    return a;
  }

  /* ---- Экран 2: свайп -------------------------------------------------- */

  function renderDeck() {
    var slot = document.getElementById('swipe-card');
    slot.replaceChildren();

    var list = deck();
    var counter = document.getElementById('swipe-counter');
    var bar = document.getElementById('swipe-bar');

    if (!list.length) {
      counter.textContent = '';
      bar.style.width = '100%';
      slot.appendChild(el('p', 'stub', NOTHING));
      return;
    }

    if (state.index >= list.length) { state.index = 0; }
    var item = list[state.index];
    if (state.screen === 'screen-swipe') { viewed(item); }
    var total = pool().length;
    var shown = total - list.length + state.index + 1;

    counter.textContent = shown + '/' + total;
    bar.style.width = Math.round(shown / total * 100) + '%';

    var card = el('article', 'swipecard');
    var ph = photo(item, 'swipecard__photo');

    // На макете бейдж, заголовок и дата лежат поверх фотографии, а не под ней.
    var over = el('div', 'swipecard__over');
    over.appendChild(el('span', 'badge', Cat.title(item.category)));
    over.appendChild(el('h2', 'card__title', item.title));
    var why = becauseLine(item);
    if (why) { over.appendChild(why); }
    over.appendChild(metaRow('calendar', whenText(item.startsAt)));
    over.appendChild(metaRow('pin', item.venueName + ' · ' + Fmt.distance(item.distanceKm)));
    ph.appendChild(over);
    card.appendChild(ph);

    var body = el('div', 'swipecard__body');
    body.appendChild(priceBlock(item, false));
    body.appendChild(actions(item));
    body.appendChild(saveButton(item));
    card.appendChild(body);

    attachSwipe(card, item);
    slot.appendChild(card);
  }

  /* Свайп по карточке: вправо — «хочу пойти», влево — «не нравится».
   * Карточка тянется за пальцем и наклоняется, иначе жест не читается как жест.
   * Pointer Events покрывают палец и мышь одним обработчиком.
   * Вертикальное движение отдаём прокрутке: иначе страницу не пролистать. */
  function attachSwipe(card, item) {
    var x0 = 0, y0 = 0, dx = 0, active = false, locked = false;

    var hintLike = el('span', 'swipe-hint swipe-hint--like', 'Пойду');
    var hintSkip = el('span', 'swipe-hint swipe-hint--skip', 'Не нравится');
    card.appendChild(hintLike);
    card.appendChild(hintSkip);

    function down(e) {
      active = true; locked = false; dx = 0;
      x0 = e.clientX; y0 = e.clientY;
      card.classList.add('is-dragging');
      if (card.setPointerCapture) { card.setPointerCapture(e.pointerId); }
    }

    function move(e) {
      if (!active) { return; }
      dx = e.clientX - x0;
      var dy = e.clientY - y0;
      if (!locked) {
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { cancel(); return; }
        if (Math.abs(dx) < 6) { return; }
        locked = true;
      }
      card.style.transform = 'translateX(' + dx + 'px) rotate(' + (dx / 24) + 'deg)';
      card.classList.toggle('to-like', dx > 70);
      card.classList.toggle('to-skip', dx < -70);
    }

    function up() {
      if (!active) { return; }
      active = false;
      // После свайпа браузер всё равно пришлёт click — карточку открывать
      // не надо, человек листал, а не нажимал.
      if (locked) {
        card.dragged = true;
        setTimeout(function () { card.dragged = false; }, 0);
      }
      card.classList.remove('is-dragging', 'to-like', 'to-skip');
      if (dx > 90) { fly(1, function () { react(item, 'liked'); }); }
      else if (dx < -90) { fly(-1, function () { react(item, 'disliked'); }); }
      else { card.style.transform = ''; }
    }

    function cancel() {
      active = false;
      card.classList.remove('is-dragging', 'to-like', 'to-skip');
      card.style.transform = '';
    }

    function fly(dir, done) {
      card.style.transform = 'translateX(' + (dir * 480) + 'px) rotate(' + (dir * 18) + 'deg)';
      card.style.opacity = '0';
      setTimeout(done, 180);
    }

    card.addEventListener('pointerdown', down);
    card.addEventListener('pointermove', move);
    card.addEventListener('pointerup', up);
    card.addEventListener('pointercancel', cancel);
  }

  /* Вернуть предыдущую карточку: снимает последнюю оценку и ставит колоду на
   * это же событие. Промах пальцем по «Не нравится» иначе не исправить —
   * событие молча уезжало из подборки. Стопка сохраняется вместе с отметками:
   * MAX перезагружает свёрнутое приложение, и без этого стрелка пропадала
   * посреди подборки — оценённое до перезагрузки было уже не вернуть. */
  function undoLast() {
    var id = state.undo.pop();
    if (id === undefined) { return; }
    forget(id);
    send('UNDO', id);
    var list = deck();
    for (var i = 0; i < list.length; i++) {
      if (list[i].eventId === id) { state.index = i; break; }
    }
    if (state.screen === 'screen-empty') { state.screen = 'screen-feed'; }
    render();
  }

  function next() {
    var list = deck();
    if (!list.length) { return; }
    state.index = (state.index + 1) % list.length;
    render();
  }

  /* ---- Экран 3 и 4: избранное ----------------------------------------- */

  function renderFavorites() {
    var box = document.getElementById('fav-list');
    box.replaceChildren();

    document.getElementById('tab-liked-count').textContent = String(state.liked.length);
    document.getElementById('tab-saved-count').textContent = String(state.saved.length);
    document.getElementById('tab-liked').classList.toggle('is-on', state.tab === 'liked');
    document.getElementById('tab-saved').classList.toggle('is-on', state.tab === 'saved');

    var list = listOf(state.tab);
    if (!list.length) {
      box.appendChild(el('p', 'stub', state.tab === 'liked'
        ? 'Пока ничего не отмечено. Вернись в подборку.'
        : 'Отложенного пока нет.'));
      return;
    }

    list.forEach(function (item) {
      var liked = state.tab === 'liked';
      var row = el('article', 'row' + (liked ? '' : ' row--small'));

      var ph = photo(item, 'row__photo');
      openOnTap(row, item, null);
      row.appendChild(ph);

      var main = el('div', 'row__main');
      main.appendChild(el('span', 'badge', Cat.title(item.category)));
      main.appendChild(el('h3', 'row__title', item.title));
      main.appendChild(metaRow('calendar', whenText(item.startsAt)));
      main.appendChild(metaRow('pin', item.venueName));
      main.appendChild(priceBlock(item, true));
      // Главное, что человек хочет знать в избранном: хватит ли карты.
      // Считаем по тому кошельку, из которого этот билет и оплачивается.
      var w = walletOf(item.category);
      main.appendChild(el('p', 'row__left', item.priceRub > leftIn(w)
        ? 'Не хватает ' + rub(item.priceRub - leftIn(w)) + ' на «' + WALLETS[w].title + '»'
        : 'Останется ' + rub(leftIn(w) - item.priceRub) + ' на «' + WALLETS[w].title + '»'));

      if (liked) {
        var buy = el('a', 'btn btn--buy');
        buy.href = item.ticketUrl;
        buy.target = '_blank';
        buy.rel = 'noopener noreferrer';
        buy.textContent = 'Купить билет';
        // Касса открывается в новой вкладке, и вернётся человек уже сюда.
        // Запоминаем, за чем он ушёл, чтобы спросить про покупку на возврате.
        buy.addEventListener('click', function () {
          state.pending = item.eventId;
          save();
          send('CLICK_BUY', item.eventId);
        });
        main.appendChild(buy);
      }
      row.appendChild(main);

      // На «Пойду» сердце уже залито, и нажатие снимает отметку.
      // На «Отложено» оно пустое — это приглашение решиться, поэтому
      // нажатие переносит событие в «Пойду», а не стирает его.
      var heart = el('button', 'row__heart' + (liked ? '' : ' row__heart--off'));
      heart.type = 'button';
      heart.setAttribute('aria-label', liked ? 'Убрать из избранного' : 'Пойду');
      heart.appendChild(icon(liked ? 'heart-fill' : 'heart', 20));
      heart.addEventListener('click', function (e) {
        // Иконка ниже заменяется прямо в этом обработчике, и строка уже не
        // узнала бы в выкинутом из DOM узле кнопку — открыла бы карточку.
        e.stopPropagation();
        if (heart.classList.contains('is-liking') || heart.classList.contains('is-unliking')) { return; }
        if (liked) {
          heart.classList.add('row__heart--off', 'is-unliking');
          heart.replaceChildren(icon('heart', 20));
        } else {
          heart.classList.remove('row__heart--off');
          heart.classList.add('is-liking');
          heart.replaceChildren(icon('heart-fill', 20));
        }
        row.classList.add('is-leaving');
        setTimeout(function () {
          if (liked) {
            forget(item.eventId);
            send('UNDO', item.eventId);
          } else {
            mark(item, 'liked');
            send('LIKE', item.eventId);
          }
          render();
          // Карточка уезжает с текущей вкладки, а появляется на соседней,
          // и переключать вкладку под человеком во время разбора списка
          // незачем. Без этой подсказки нажатие выглядит так, будто
          // событие просто пропало.
          toast(liked ? 'Убрали из избранного' : 'Перенесли в «Пойду»');
        }, 440);
      });
      row.appendChild(heart);

      box.appendChild(row);
    });
  }

  /* ---- Профиль --------------------------------------------------------- */

  function renderProfile() {
    var left = leftIn('CINEMA') + leftIn('OTHER');
    var count = state.bought.length;
    document.getElementById('profile-balance').textContent = rub(left);
    document.getElementById('profile-note').textContent = count
      ? 'Осталось после ' + count + ' ' + Fmt.plural(count, 'покупки', 'покупок', 'покупок')
      : 'Баланс карты';
    document.getElementById('profile-origin').textContent =
      originLabel() + ' — от этой точки считается расстояние. Сменить можно в боте.';

    renderWallets();
    renderBought();
  }

  /* Два счёта наглядно: сколько выбрано и сколько осталось. Полоса важнее
   * цифры — по ней сразу видно, что кино почти закончилось, а театры нет. */
  function renderWallets() {
    var box = document.getElementById('wallets');
    box.replaceChildren();
    WALLET_ORDER.forEach(function (code) {
      var w = WALLETS[code];
      var limit = limitOf(code);
      var left = leftIn(code);
      var row = el('div', 'wallet');

      var head = el('div', 'wallet__head');
      head.appendChild(el('span', 'wallet__name', w.title));
      head.appendChild(el('span', 'wallet__left', rub(left)));
      row.appendChild(head);

      var track = el('div', 'wallet__track');
      var fill = el('i', 'wallet__fill' + (left === 0 ? ' wallet__fill--empty' : ''));
      fill.style.width = (limit ? Math.round(left / limit * 100) : 0) + '%';
      track.appendChild(fill);
      row.appendChild(track);

      row.appendChild(el('p', 'wallet__note', 'из ' + rub(limit)));
      row.appendChild(walletEdit(code, left));
      box.appendChild(row);
    });
  }

  /* Баланс кошелька руками. Бот присылает суммы ссылкой, но на демо ссылки
   * может не быть, да и проверить «а если денег меньше» иначе нечем.
   * Событие change, а не input: перерисовка на каждой набранной цифре
   * вырывала бы поле из-под пальца. */
  function walletEdit(code, left) {
    if (state.editWallet === code) { return walletField(code, left); }

    var pencil = el('button', 'wallet__pencil');
    pencil.type = 'button';
    pencil.title = 'Изменить баланс';
    pencil.setAttribute('aria-label', 'Изменить баланс: ' + WALLETS[code].title);
    pencil.appendChild(icon('pencil', 14));
    // Поле подставляется на место карандаша, а фокус берётся прямо в
    // обработчике нажатия: focus() после перерисовки или из setTimeout
    // мобильные браузеры игнорируют и клавиатуру не показывают.
    pencil.addEventListener('click', function () {
      state.editWallet = code;
      var field = walletField(code, left);
      pencil.replaceWith(field);
      var input = field.querySelector('input');
      input.focus();
      input.select();
    });
    return pencil;
  }

  function walletField(code, left) {
    var box = el('label', 'wallet__edit');
    var input = el('input', 'wallet__input');
    input.type = 'number';
    input.min = '0';
    input.max = String(WALLETS[code].share);
    input.step = '100';
    input.inputMode = 'numeric';
    input.value = String(left);
    // change, а не input: перерисовка на каждой цифре вырывала бы поле
    // из-под пальца. Esc закрывает без правки.
    input.addEventListener('change', function () { apply(input.value); });
    input.addEventListener('blur', function () { apply(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { state.editWallet = null; render(); }
    });
    box.appendChild(input);
    box.appendChild(el('span', 'wallet__edit-cur', '₽'));
    return box;

    function apply(raw) {
      if (state.editWallet !== code) { return; }
      var v = Math.round(Number(raw));
      state.editWallet = null;
      if (isFinite(v)) {
        state.card[code] = Math.min(Math.max(v, 0), WALLETS[code].share);
        // Всё, что куплено раньше, уже учтено во введённой сумме.
        state.spentBase[code] = spentIn(code);
        save();
      }
      render();
    }
  }

  function renderBought() {
    var box = document.getElementById('bought-list');
    box.replaceChildren();
    if (!state.bought.length) {
      box.appendChild(el('p', 'stub', 'Купленных билетов пока нет. Они появятся здесь, когда подтвердишь покупку.'));
      return;
    }
    // Последняя покупка сверху: к ней и возвращаются, если нажали «Да» зря.
    state.bought.slice().reverse().forEach(function (b) {
      var item = byEventId(b.eventId);
      var row = el('article', 'row row--small');
      if (item) {
        row.appendChild(photo(item, 'row__photo'));
        openOnTap(row, item, null);
      }

      var main = el('div', 'row__main');
      main.appendChild(el('span', 'badge', WALLETS[b.wallet].title));
      main.appendChild(el('h3', 'row__title', item ? item.title : 'Мероприятие'));
      if (item) { main.appendChild(metaRow('calendar', whenText(item.startsAt))); }
      main.appendChild(el('p', 'row__left', 'Списано ' + Fmt.money(b.priceRub)));

      var undo = el('button', 'row__undo', 'Отменить покупку');
      undo.type = 'button';
      undo.addEventListener('click', function (e) {
        // Карточка целиком открывает мероприятие, поэтому клик по кнопке
        // нельзя отдавать наверх.
        e.stopPropagation();
        cancelPurchase(b.eventId);
      });
      main.appendChild(undo);

      row.appendChild(main);
      box.appendChild(row);
    });
  }

  function byEventId(id) {
    return MOCK_EVENTS.filter(function (e) { return e.eventId === id; })[0] || null;
  }

  /* ---- Подтверждение покупки -------------------------------------------
   * Касса живёт на чужом сайте, и узнать оттуда о покупке нечем. Поэтому
   * спрашиваем сами: человек ушёл по кнопке «Купить билет», вернулся во
   * вкладку — показываем вопрос. Пока он не ответил, state.pending лежит в
   * localStorage, так что вопрос переживает и закрытие приложения.
   */

  function askPurchase() {
    if (state.pending === null) { return; }
    var item = byEventId(state.pending);
    if (!item || isBought(item.eventId)) { clearPending(); return; }

    var w = walletOf(item.category);
    var short = Math.max(0, item.priceRub - leftIn(w));

    document.getElementById('ask-event').textContent = item.title + ' · ' + item.venueName;
    document.getElementById('ask-note').textContent = short
      ? Fmt.money(item.priceRub) + ' · в кошельке «' + WALLETS[w].title + '» не хватает ' + Fmt.money(short)
      : Fmt.money(item.priceRub) + ' · спишем с «' + WALLETS[w].title + '»';

    var box = document.getElementById('ask');
    box.hidden = false;
    document.getElementById('ask-yes').focus();
  }

  function closeAsk() {
    document.getElementById('ask').hidden = true;
  }

  function clearPending() {
    state.pending = null;
    save();
    closeAsk();
  }

  // «Ещё нет» — ответ для воронки. clearPending() зовут и там, где это не
  // отказ (вопрос не к месту, покупка подтверждена), поэтому отдельно.
  function declinePurchase() {
    if (state.pending !== null) { send('PURCHASE_NO', state.pending); }
    clearPending();
  }

  function confirmPurchase() {
    var item = state.pending === null ? null : byEventId(state.pending);
    if (!item) { clearPending(); return; }
    var w = walletOf(item.category);
    state.bought.push({ eventId: item.eventId, priceRub: item.priceRub, wallet: w, at: Date.now() });
    send('PURCHASE_YES', item.eventId);
    // Купленное уходит из «Пойду» в «Куплено»: в двух местах сразу
    // оно выглядело бы как два разных дела.
    forget(item.eventId);
    clearPending();
    toast('Списано ' + Fmt.money(item.priceRub) + ' с «' + WALLETS[w].title + '»');
    render();
  }

  /* Отмена ошибочного «Да»: деньги возвращаются, событие едет обратно в
   * «Пойду» — оттуда оно и ушло, и туда же человек полезет его искать. */
  function cancelPurchase(eventId) {
    var before = state.bought.length;
    state.bought = state.bought.filter(function (b) { return b.eventId !== eventId; });
    if (state.bought.length === before) { return; }
    send('PURCHASE_CANCEL', eventId);
    if (state.liked.indexOf(eventId) < 0) { state.liked.push(eventId); }
    save();
    toast('Покупка отменена');
    render();
  }

  /* ---- Экран 5: подробная карточка ------------------------------------ */

  function renderDetail() {
    var box = document.getElementById('detail-body');
    box.replaceChildren();
    if (state.screen !== 'screen-detail') { return; }

    // По всей афише: подробную карточку открывают и из избранного другого города.
    var item = MOCK_EVENTS.filter(function (e) { return e.sessionId === state.detail; })[0];
    if (!item) { return; }

    var wrap = el('div', 'detail');

    // Такая же карточка, как в подборке: фото уходит к низу в тёмно-синий,
    // поверх и ниже на тёмном — всё остальное.
    // Анимация только при открытии: renderDetail зовётся на каждый render(),
    // и без флага карточка вздрагивала бы после любого нажатия на ней.
    // Из подборки карточка переезжает, из избранного — проявляется.
    var opening = state.opening;
    var fromRect = state.fromRect;
    state.opening = false;
    state.fromRect = null;
    var card = el('article', 'bigcard detail__card' + (opening && !fromRect ? ' is-opening' : ''));
    var ph = photo(item, 'bigcard__photo');
    var back = el('button', 'round round--back');
    back.type = 'button';
    back.setAttribute('aria-label', 'Назад');
    back.appendChild(icon('back', 18));
    back.addEventListener('click', function () {
      // В подборку карточка возвращается тем же переездом, только обратно.
      if (state.flyBack && state.back === 'screen-feed') { state.returnRect = card.getBoundingClientRect(); }
      go(state.back);
    });
    var share = el('button', 'round round--share');
    share.type = 'button';
    share.setAttribute('aria-label', 'Поделиться');
    share.appendChild(icon('share', 18));
    share.addEventListener('click', function () { shareEvent(item); });
    ph.appendChild(back);
    ph.appendChild(share);
    card.appendChild(ph);

    var head = el('div', 'bigcard__body');
    head.appendChild(el('span', 'badge', Cat.title(item.category)));
    head.appendChild(el('h1', 'card__title detail__title', item.title));

    // Рейтинг показываем, только если он есть: источник афиши оценок не
    // отдаёт, а рисовать выдуманные звёзды рядом с настоящей ценой нельзя.
    if (item.rating) {
      var rate = el('div', 'rating');
      rate.appendChild(icon('star-fill', 14));
      rate.appendChild(document.createTextNode(String(item.rating)));
      rate.appendChild(el('span', null, '(' + item.reviewCount + ' '
        + Fmt.plural(item.reviewCount, 'отзыв', 'отзыва', 'отзывов') + ')'));
      head.appendChild(rate);
    }

    head.appendChild(metaRow('calendar', whenText(item.startsAt)));
    head.appendChild(metaRow('pin', item.venueName + ' · ' + Fmt.distance(item.distanceKm)));
    head.appendChild(metaRow('map', item.venueAddress));

    var price = priceBlock(item, false);
    price.className = 'price detail__price';
    head.appendChild(price);

    // Описание и кнопки тоже на карточке — всё про событие в одном месте.
    head.appendChild(el('h2', 'detail__h2', 'О мероприятии'));
    head.appendChild(el('p', 'detail__text', item.summary));
    head.appendChild(actions(item));
    head.appendChild(saveButton(item));
    head.appendChild(routeButton(item));
    card.appendChild(head);

    wrap.appendChild(card);
    box.appendChild(wrap);
    if (opening && fromRect) { flyFrom(card, fromRect); }
  }

  /* Приём FLIP: ставим карточку туда, где на экране была карточка подборки,
   * и отпускаем на её собственное место. Мерить можно только после вставки
   * в DOM, поэтому зовётся в конце renderDetail. */
  function flyFrom(card, from) {
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) { return; }
    var to = card.getBoundingClientRect();
    card.style.transformOrigin = '0 0';
    card.style.transition = 'none';
    card.style.transform = 'translate(' + (from.left - to.left) + 'px, ' + (from.top - to.top) + 'px) scale(' + (from.width / to.width) + ')';
    card.getBoundingClientRect();
    card.style.transition = 'transform .45s cubic-bezier(.2, .8, .2, 1)';
    card.style.transform = '';
    card.addEventListener('transitionend', function () {
      card.style.transition = '';
      card.style.transformOrigin = '';
    }, { once: true });
  }

  /* «Поделиться»: системное меню, где оно есть (телефоны). Где его нет,
   * ссылка на мероприятие копируется в буфер обмена. */
  function shareEvent(item) {
    var url = item.eventUrl || item.ticketUrl;
    if (navigator.share) {
      navigator.share({ title: item.title, text: item.title + ' — ' + item.venueName, url: url })
        .catch(function () { /* человек закрыл меню — не ошибка */ });
      return;
    }
    copyText(url).then(
      function () { toast('Ссылка скопирована'); },
      function () { toast('Не получилось скопировать ссылку'); });
  }

  // Clipboard API есть не везде и может отказать без разрешения —
  // тогда копируем по-старому, через выделенное текстовое поле.
  function copyText(text) {
    var legacy = function () {
      var t = el('textarea');
      t.value = text;
      t.style.position = 'fixed';
      t.style.opacity = '0';
      document.body.appendChild(t);
      t.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      t.remove();
      return ok ? Promise.resolve() : Promise.reject();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(legacy);
    }
    return legacy();
  }

  var toastTimer = null;

  function toast(text) {
    var t = document.getElementById('toast');
    if (!t) {
      t = el('div', 'toast');
      t.id = 'toast';
      document.querySelector('.app').appendChild(t);
    }
    t.textContent = text;
    t.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('is-on'); }, 1800);
  }

  /* ---- Категории ------------------------------------------------------- */

  var CATS = ['THEATRE', 'CINEMA', 'MUSEUM', 'CONCERT', 'EXCURSION'];

  var DATES = {
    ANY: 'Любая дата', TODAY: 'Сегодня', TOMORROW: 'Завтра',
    WEEKEND: 'В выходные', WEEK: 'На этой неделе'
  };

  // Варианты радиуса и значение по умолчанию. 1 и 2 км нужны Казани: все её
  // площадки в трёх километрах от центра, и без мелких шагов фильтр там
  // ничего не менял.
  var KMS = [1, 2, 3, 5, 10, 20, 50];
  var DEFAULT_KM = 10;

  var NOTHING = 'Под выбранные фильтры ничего не нашлось. Смягчи их — и события вернутся.';

  var Cat = {
    titles: { THEATRE: 'Театр', CINEMA: 'Кино', MUSEUM: 'Выставка', CONCERT: 'Концерт', EXCURSION: 'Экскурсия' },
    title: function (code) { return this.titles[code] || 'Событие'; }
  };

  /* ---- Статистика для администраторов -----------------------------------
   * Экран открывает кнопка из команды /stats. Сервер отдаёт данные только по
   * подписи initData администратора, остальным — 401/403, и экран объясняет,
   * откуда его открывать. Опрос идёт цепочкой setTimeout и только пока экран
   * открыт: медленный ответ не накладывается на следующий запрос. */
  var STEPS = {
    OPENED: 'Открыли приложение', LIKED: 'Отметили «Пойду»',
    CLICK_BUY: 'Перешли к покупке', BOUGHT: 'Купили билет'
  };
  var CITY_NAMES = { moscow: 'Москва', kazan: 'Казань' };
  // Пустой знаменатель приходит с сервера как null — вместо 0 % и NaN пишем это.
  var NO_DATA = 'пока нет данных';
  // Ни роли, ни команды не называем: чужому о них знать незачем.
  var DENIED = 'Экран недоступен.';
  var CLOCK = new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Moscow'
  });
  // statsOn — идёт ли опрос. statsGen меняется при каждом старте и остановке:
  // ответ устаревшего опроса не рисуется и не планирует следующий.
  var statsOn = false;
  var statsGen = 0;
  var statsTimer = null;

  /* Форматтеры получают только конечные числа: всё прочее отсекает known(). */
  function known(x) { return x != null && Number.isFinite(x); }
  function count(x) { return known(x) ? x : 0; }
  function fmtNum(x) { return x.toLocaleString('ru-RU', { maximumFractionDigits: 1 }); }
  function fmtRub(x) { return fmtNum(x) + ' ₽'; }
  function fmtPct(x) { return fmtNum(x) + ' %'; }
  function fmtMinutes(m) {
    if (m < 1) { return 'меньше минуты'; }
    if (m < 60) { return Math.floor(m) + ' мин'; }
    if (m < 1440) {
      var h = Math.floor(m / 60);
      var min = Math.floor(m - h * 60);
      return h + ' ч' + (min ? ' ' + min + ' мин' : '');
    }
    var d = Math.floor(m / 1440);
    var hh = Math.floor((m - d * 1440) / 60);
    return d + ' дн' + (hh ? ' ' + hh + ' ч' : '');
  }

  /* Вызывается последней строкой render(): опрос стартует при входе на экран
   * и гаснет при уходе с него, без отдельных хуков в go(). */
  function syncStats() {
    var open = state.screen === 'screen-stats';
    if (open && !statsOn) {
      statsOn = true;
      statsGen++;
      pollStats(statsGen);
    } else if (!open && statsOn) {
      statsOn = false;
      statsGen++;
      clearTimeout(statsTimer);
    }
  }

  function statsStatus(text, off) {
    var s = document.getElementById('stats-status');
    s.textContent = text;
    s.classList.toggle('stats-status--off', !!off);
  }

  function isObj(x) { return !!x && typeof x === 'object'; }

  function statsShape(s) {
    return isObj(s) && isObj(s.swipesToLike) && isObj(s.bought) && isObj(s.likeToBuy) &&
      isObj(s.active) && isObj(s.minutesToPurchase) && isObj(s.returned) &&
      Array.isArray(s.funnel) && Array.isArray(s.topEvents) &&
      Array.isArray(s.categories) && Array.isArray(s.cities);
  }

  function pollStats(gen) {
    if (gen !== statsGen) { return; }
    if (!INIT) { statsDenied(); return; }
    var next = function () {
      if (gen !== statsGen) { return; }
      statsTimer = setTimeout(function () { pollStats(gen); }, 3000);
    };
    // Последние данные остаются на экране, меняется только статус.
    var fail = function () {
      if (gen !== statsGen) { return; }
      statsStatus('нет связи с сервером', true);
      next();
    };
    try {
      fetch(API + '/api/stats', { headers: { 'X-Init-Data': INIT }, cache: 'no-store' })
        .then(function (r) {
          if (gen !== statsGen) { return; }
          // Отказ окончательный: подпись за время открытия экрана не изменится.
          if (r.status === 401 || r.status === 403) { statsDenied(); return; }
          if (!r.ok) { fail(); return; }
          return r.json().then(function (s) {
            if (gen !== statsGen) { return; }
            if (!statsShape(s)) {
              fail();
              return;
            }
            renderStats(s);
            statsStatus('обновлено ' + CLOCK.format(new Date()), false);
            next();
          });
        })
        .catch(fail);
    } catch (e) { fail(); /* WebView без fetch */ }
  }

  function statsDenied() {
    document.getElementById('stats-body').replaceChildren(el('p', 'stub', DENIED));
    statsStatus('', false);
  }

  // Полоса — доля от базы; при нулевой базе пустая, больше 100 % не бывает.
  function statsBar(part, whole) {
    var track = el('span', 'stats-track');
    var fill = el('span', 'stats-fill');
    var w = whole > 0 ? Math.min(100, Math.max(0, part / whole * 100)) : 0;
    fill.style.width = w + '%';
    track.appendChild(fill);
    return track;
  }

  function statsTile(label, value, note) {
    var t = el('div', 'stats-tile');
    t.appendChild(el('div', 'stats-tile__label', label));
    t.appendChild(el('div', 'stats-tile__value', value));
    t.appendChild(el('div', 'stats-tile__note', note));
    return t;
  }

  function statsLine(name, value, extra) {
    var line = el('div', 'stats-line');
    line.appendChild(el('span', 'stats-name', name));
    line.appendChild(el('span', 'stats-count', value));
    if (extra !== undefined) { line.appendChild(el('span', 'stats-pct', extra)); }
    return line;
  }

  function statsSection(parts, title, hint) {
    parts.push(el('h2', 'section-title', title));
    if (hint) { parts.push(el('p', 'stats-hint', hint)); }
    var panel = el('div', 'stats-panel');
    parts.push(panel);
    return panel;
  }

  function statsEmpty(panel) {
    panel.appendChild(el('p', 'stats-empty', NO_DATA));
  }

  // Строка «название + пояснение слева, значение справа».
  function statsMetric(name, hint, value) {
    var row = el('div', 'stats-metric');
    var text = el('div', 'stats-metric__text');
    text.appendChild(el('div', 'stats-metric__name', name));
    text.appendChild(el('div', 'stats-metric__hint', hint));
    row.appendChild(text);
    row.appendChild(el('div', 'stats-metric__value' + (value === NO_DATA ? ' stats-metric__value--none' : ''), value));
    return row;
  }

  function statsKpi(s) {
    var tiles = el('div', 'stats-tiles');

    var swipes = s.swipesToLike.value;
    tiles.appendChild(known(swipes)
      ? statsTile('Свайпов до выбора', fmtNum(swipes),
        'карточек до первого «Пойду» · медиана по ' + count(s.swipesToLike.users) + ' чел.')
      : statsTile('Свайпов до выбора', '—', NO_DATA));

    var b = s.bought;
    tiles.appendChild(count(b.count) > 0
      ? statsTile('₽ доведено до покупки', fmtRub(count(b.rub)),
        (known(b.avgCheckRub) ? 'средний чек ' + fmtRub(b.avgCheckRub) + ' · ' : '') + 'билетов: ' + b.count)
      : statsTile('₽ доведено до покупки', '0 ₽', 'покупок пока нет'));

    var l = s.likeToBuy;
    tiles.appendChild(known(l.percent)
      ? statsTile('Из «Пойду» в покупку', fmtPct(l.percent),
        count(l.part) + ' из ' + count(l.whole) + ' отмеченных купили')
      : statsTile('Из «Пойду» в покупку', '—', NO_DATA));

    var a = s.active;
    tiles.appendChild(count(a.week) > 0
      ? statsTile('Активны', count(a.today) + ' / ' + a.week,
        'сегодня / за 7 дней · новых сегодня: ' + count(a.newToday))
      : statsTile('Активны', '—', NO_DATA));

    return tiles;
  }

  function statsFunnel(parts, s) {
    var panel = statsSection(parts, 'Воронка по людям', 'сколько людей дошли до шага; % — от открывших');
    var first = s.funnel.length ? count(s.funnel[0].users) : 0;
    if (first === 0) { statsEmpty(panel); return; }
    s.funnel.forEach(function (f) {
      var users = count(f.users);
      var row = el('div', 'stats-step');
      row.appendChild(statsLine(STEPS[f.step] || String(f.step), fmtNum(users),
        known(f.percentOfFirst) ? fmtPct(f.percentOfFirst) : '—'));
      row.appendChild(statsBar(users, first));
      panel.appendChild(row);
    });
  }

  function statsEngagement(parts, s) {
    var panel = statsSection(parts, 'Вовлечённость');
    var minutes = s.minutesToPurchase.value;
    panel.appendChild(statsMetric('Время до покупки', 'медиана: от первого действия до первой покупки',
      known(minutes) ? fmtMinutes(minutes) : NO_DATA));
    var r = s.returned;
    panel.appendChild(statsMetric('Вернулись',
      'заходили в 2+ разных дня по МСК' + (count(r.whole) > 0 ? ' · ' + count(r.part) + ' из ' + r.whole : ''),
      known(r.percent) ? fmtPct(r.percent) : NO_DATA));
    panel.appendChild(statsMetric('Карточек на человека', 'в среднем просмотров карточек',
      known(s.cardsPerUser) ? fmtNum(s.cardsPerUser) : NO_DATA));
  }

  function statsTop(parts, s) {
    var panel = statsSection(parts, 'Топ-5 мероприятий', '«Пойду» плюс двойной вес покупок');
    if (!s.topEvents.length) { statsEmpty(panel); return; }
    s.topEvents.forEach(function (t, i) {
      var row = el('div', 'stats-top');
      row.appendChild(el('span', 'stats-top__place', i + 1));
      var text = el('div', 'stats-top__text');
      var item = byEventId(t.eventId);
      text.appendChild(el('div', 'stats-top__title', item ? item.title : 'Событие #' + t.eventId));
      text.appendChild(el('div', 'stats-top__meta',
        '«Пойду»: ' + count(t.likes) + ' · куплено: ' + count(t.purchases)));
      row.appendChild(text);
      panel.appendChild(row);
    });
  }

  function statsCategories(parts, s) {
    var panel = statsSection(parts, 'Категории', 'полоса — доля «Пойду» среди оценок');
    if (!s.categories.length) { statsEmpty(panel); return; }
    s.categories.forEach(function (c) {
      var likes = count(c.likes);
      var dislikes = count(c.dislikes);
      var row = el('div', 'stats-cat');
      var line = el('div', 'stats-line');
      line.appendChild(el('span', 'stats-name', Cat.title(c.category)));
      // Процент тот же, что рисует полоса, — иначе полоса и число спорят.
      line.appendChild(el('span', 'stats-pct',
        known(c.dislikePercent) ? fmtPct(100 - c.dislikePercent) + ' «Пойду»' : '—'));
      row.appendChild(line);
      row.appendChild(el('div', 'stats-meta', likes + ' «Пойду» · ' + dislikes + ' не нравится'));
      row.appendChild(statsBar(likes, likes + dislikes));
      panel.appendChild(row);
    });
  }

  function statsCities(parts, s) {
    var panel = statsSection(parts, 'Города');
    var total = s.cities.reduce(function (sum, c) { return sum + count(c && c.users); }, 0);
    if (total === 0) { statsEmpty(panel); return; }
    var cols = s.cities.filter(function (c) {
      return c && (c.city === 'moscow' || c.city === 'kazan' || c.city == null);
    });
    var grid = el('div', 'stats-cities');
    grid.style.gridTemplateColumns = 'minmax(0, 1.2fr) repeat(' + cols.length + ', minmax(0, 1fr))';
    grid.appendChild(el('span', 'stats-cities__head'));
    cols.forEach(function (c) {
      grid.appendChild(el('span', 'stats-cities__head stats-cities__num',
        c.city == null ? 'Не указан' : CITY_NAMES[c.city]));
    });
    [['Пользователи', 'users'], ['«Пойду»', 'likes'], ['Покупки', 'purchases'], ['₽', 'rub']]
      .forEach(function (r) {
        grid.appendChild(el('span', 'stats-cities__label', r[0]));
        cols.forEach(function (c) {
          grid.appendChild(el('span', 'stats-cities__num', fmtNum(count(c[r[1]]))));
        });
      });
    panel.appendChild(grid);
  }

  /* Ответ — внешние данные (категории и eventId пишет клиент), поэтому только
   * textContent. Шапку и переехавший логотип не трогаем — только #stats-body. */
  function renderStats(s) {
    var parts = [statsKpi(s)];
    statsFunnel(parts, s);
    statsEngagement(parts, s);
    statsTop(parts, s);
    statsCategories(parts, s);
    statsCities(parts, s);
    var body = document.getElementById('stats-body');
    body.replaceChildren.apply(body, parts);
  }

  /* ---- Навигация и отрисовка ------------------------------------------ */

  var nav = document.getElementById('bottom-nav');

  function renderNav() {
    var map = {
      'screen-feed': 'screen-feed', 'screen-swipe': 'screen-feed',
      'screen-favorites': 'screen-favorites', 'screen-profile': 'screen-profile'
    };
    var active = map[state.screen];
    nav.classList.toggle('nav--hidden', !!NO_NAV[state.screen]);
    Array.prototype.forEach.call(nav.querySelectorAll('.nav__item'), function (btn) {
      var on = btn.getAttribute('data-nav') === active;
      btn.classList.toggle('is-on', on);
      // Сердце в этом приложении означает «Пойду» — оно стоит на карточках и
      // на кнопке лайка. В баре у раздела свой знак, звезда.
      var name = { 'screen-feed': 'home', 'screen-favorites': 'bookmark', 'screen-profile': 'user' }[btn.getAttribute('data-nav')];
      btn.replaceChildren(icon(on ? name + '-fill' : name, 22), el('span', null, btn.getAttribute('data-label')));
    });
  }

  /* Логотип уезжает вместе с содержимым, а не висит прибитым сверху.
   * Узел в разметке один, поэтому он переезжает в скролл активного экрана.
   * Подробная карточка — исключение: её тело перерисовывается целиком и
   * снесло бы логотип вместе с остальным. */
  var topbar = document.querySelector('.topbar');
  var appBox = document.querySelector('.app');

  function placeTopbar() {
    var scroll = document.querySelector('#' + state.screen + ' .screen__scroll');
    var host = (scroll && state.screen !== 'screen-detail') ? scroll : appBox;
    if (host.firstChild !== topbar) { host.insertBefore(topbar, host.firstChild); }
  }

  function render() {
    renderFilters('feed-filters');
    renderFilters('swipe-filters');
    SCREENS.forEach(function (id) {
      var s = document.getElementById(id);
      if (s) { s.classList.toggle('is-active', id === state.screen); }
    });
    document.body.classList.toggle('is-dark', !!DARK[state.screen]);
    placeTopbar();
    renderNav();
    renderFeed();
    renderDeck();
    renderFavorites();
    renderProfile();
    renderDetail();
    syncStats();
  }

  /* ---- Запуск ---------------------------------------------------------- */

  Array.prototype.forEach.call(nav.querySelectorAll('.nav__item'), function (btn) {
    btn.setAttribute('data-label', btn.querySelector('span').textContent);
    btn.addEventListener('click', function () { go(btn.getAttribute('data-nav')); });
  });

  // Главный экран: свайп влево или нажатие на подсказку ведут в подборку.
  (function () {
    var welcome = document.getElementById('welcome');
    var x0 = null;
    welcome.addEventListener('pointerdown', function (e) { x0 = e.clientX; });
    welcome.addEventListener('pointerup', function (e) {
      if (x0 !== null && x0 - e.clientX > 60) { go('screen-feed'); }
      x0 = null;
    });
    welcome.addEventListener('pointercancel', function () { x0 = null; });
    document.getElementById('welcome-start').addEventListener('click', function () { go('screen-feed'); });
  })();

  document.getElementById('feed-back').addEventListener('click', undoLast);
  document.getElementById('fav-back').addEventListener('click', function () { go('screen-feed'); });
  document.getElementById('stats-back').addEventListener('click', function () { go('screen-feed'); });
  document.getElementById('swipe-skip').addEventListener('click', next);

  // Главный экран тянется за пальцем, а подборка выглядывает справа и едет
  // вплотную за ним. Засчитан ли свайп, решает обработчик самого экрана;
  // здесь только движение и возврат обоих экранов, если свайп короткий.
  (function () {
    var sec = document.getElementById('screen-welcome');
    if (!sec) { return; }
    var peek = document.getElementById('screen-feed');
    var x0 = null;
    var dx = 0;
    var place = function () {
      sec.style.transform = 'translateX(' + dx + 'px)';
      peek.style.transform = 'translateX(' + (dx + sec.offsetWidth) + 'px)';
    };
    sec.addEventListener('pointerdown', function (e) {
      if (reducedMotion()) { return; }
      x0 = e.clientX;
      dx = 0;
      peek.style.top = sec.offsetTop + 'px';
      peek.classList.add('is-peek');
      place();
    });
    sec.addEventListener('pointermove', function (e) {
      if (x0 === null) { return; }
      dx = Math.min(0, e.clientX - x0);
      place();
    });
    var release = function () {
      if (x0 === null) { return; }
      x0 = null;
      if (state.screen !== 'screen-welcome') { return; }
      var opts = { duration: 260, easing: 'cubic-bezier(.22, .8, .24, 1)' };
      sec.animate([{ transform: sec.style.transform }, { transform: 'translateX(0)' }], opts);
      var back = peek.animate([{ transform: peek.style.transform }, { transform: 'translateX(' + sec.offsetWidth + 'px)' }], opts);
      sec.style.transform = '';
      back.onfinish = function () {
        if (state.screen === 'screen-welcome') {
          peek.classList.remove('is-peek');
          peek.style.transform = '';
          peek.style.top = '';
        }
      };
    };
    sec.addEventListener('pointerup', release);
    sec.addEventListener('pointercancel', release);
  })();

  // Открытый список фильтра закрывается нажатием мимо него. Клики внутри
  // ряда фильтров сюда не доходят: к этому моменту render() уже заменил
  // нажатую кнопку, и проверка «внутри ли клик» по ней не сработала бы.
  ['feed-filters', 'swipe-filters'].forEach(function (id) {
    document.getElementById(id).addEventListener('click', function (e) { e.stopPropagation(); });
  });
  document.addEventListener('click', function () {
    if (state.open) { state.open = null; render(); }
  });


  document.getElementById('tab-liked').addEventListener('click', function () { state.tab = 'liked'; render(); });
  document.getElementById('tab-saved').addEventListener('click', function () { state.tab = 'saved'; render(); });

  document.getElementById('ask-yes').addEventListener('click', confirmPurchase);
  document.getElementById('ask-no').addEventListener('click', declinePurchase);
  // Нажатие мимо окна и Esc считаем за «ещё нет»: молча списать деньги
  // с того, кто закрыл вопрос, нельзя.
  document.getElementById('ask').addEventListener('click', function (e) {
    if (e.target === e.currentTarget) { declinePurchase(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !document.getElementById('ask').hidden) { declinePurchase(); }
  });

  // Спрашиваем только после настоящей отлучки. Без флага вопрос выскочил бы
  // сразу по нажатию «Купить билет», когда касса ещё не открылась.
  var wentAway = false;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { wentAway = true; return; }
    if (wentAway) { wentAway = false; askPurchase(); }
  });

  /* Safari на iOS не слушает user-scalable=no, поэтому щипок и двойное
   * касание гасим руками. passive: false — иначе preventDefault не сработает. */
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (name) {
    document.addEventListener(name, function (e) { e.preventDefault(); });
  });
  document.addEventListener('touchmove', function (e) {
    if (e.touches.length > 1) { e.preventDefault(); }
  }, { passive: false });
  document.addEventListener('dblclick', function (e) { e.preventDefault(); });

  read();
  readBalanceFromLink();
  readOriginFromLink();
  prepareFeed();
  // Кнопка /stats открывает приложение сразу на статистике, минуя главный экран.
  var forStats = openedForStats();
  // Вне MAX сервер не спросить: без кнопки бота сразу просим пройти анкету.
  var unregistered = !forStats && !openedFromBot() && !INIT;
  if (forStats) { state.screen = 'screen-stats'; }
  if (unregistered) { state.screen = 'screen-register'; }
  document.getElementById('register-bot').addEventListener('click', openBot);
  render();
  // Вкладку могли закрыть, не ответив: незаданный вопрос ждёт в хранилище.
  // На статистике не спрашиваем: модальное окно закрыло бы доску на защите,
  // а вопрос останется в хранилище до обычного открытия.
  if (!forStats && !unregistered) { askPurchase(); }
  if (!forStats && !openedFromBot()) { checkRegistered(); }
  // Отметки с сервера — после первой отрисовки: локальный кеш показываем сразу.
  pull();
})();
