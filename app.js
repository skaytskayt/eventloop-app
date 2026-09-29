/*
 * Поведение Mini App: подборка, свайп, избранное, подробная карточка.
 *
 * Разметка строится узлами через DOM API. HTML-строки не используются осознанно:
 * на следующем шаге в эти же поля приедут данные с сервера, и склейка строк
 * стала бы дырой. Состояние живёт в localStorage до появления серверной синхронизации.
 */
(function () {
  'use strict';

  var KEY = 'eventloop.miniapp.v2';
  var SVG = 'http://www.w3.org/2000/svg';
  var XLINK = 'http://www.w3.org/1999/xlink';

  var SCREENS = ['screen-welcome', 'screen-feed', 'screen-swipe', 'screen-favorites', 'screen-detail', 'screen-profile'];
  var DARK = { 'screen-swipe': true };
  var NO_NAV = { 'screen-welcome': true, 'screen-detail': true };

  // card — сколько на каждом кошельке Пушкинской карты. Приходит из бота
  // ссылкой, до этого считаем от полного номинала.
  var state = { screen: 'screen-welcome', tab: 'liked', index: 0, detail: null, back: 'screen-feed', liked: [], saved: [], disliked: [], bought: [], pending: null, card: null, cats: [], date: 'ANY', km: 10, open: null, undo: [], spentBase: null, editWallet: null };

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
        spentBase: state.spentBase,
        cats: state.cats, date: state.date, km: state.km
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
      if (v && v.cats instanceof Array) { state.cats = v.cats; }
      if (v && DATES[v.date]) { state.date = v.date; }
      if (v && KMS.indexOf(v.km) >= 0) { state.km = v.km; }
    } catch (e) { /* пустое хранилище — не ошибка */ }
  }

  function validAmount(value, code) {
    return typeof value === 'number' && isFinite(value)
        && value >= 0 && value <= WALLETS[code].share;
  }

  /* Суммы из ссылки бота: ?cinema=1200&other=2500. Приходят извне, поэтому
   * проверяются как чужой ввод. Свежая ссылка важнее сохранённого — человек
   * мог сходить в бот именно затем, чтобы поправить суммы.
   *
   * Кошельки читаются независимо: если бот передал только один параметр,
   * второй остаётся прежним, а не обнуляется. */
  function readBalanceFromLink() {
    var params;
    try {
      params = new URLSearchParams(location.search);
    } catch (e) {
      return;
    }
    var changed = false;
    [['cinema', 'CINEMA'], ['other', 'OTHER']].forEach(function (pair) {
      var raw = params.get(pair[0]);
      if (raw === null || raw.trim() === '') { return; }
      var value = Math.round(Number(raw));
      if (!validAmount(value, pair[1])) { return; }
      state.card[pair[1]] = value;
      state.spentBase[pair[1]] = spentIn(pair[1]);
      changed = true;
    });
    if (changed) { save(); }
  }

  /* Записи о покупках правят баланс, поэтому из хранилища берём только
   * целые: кошелёк из известных, цена числом. Битая запись молча уронила бы
   * арифметику всей карты. */
  function validPurchase(b) {
    return b && typeof b.eventId === 'number' && typeof b.priceRub === 'number' && !!WALLETS[b.wallet];
  }

  function loadFeed() { return MOCK_EVENTS; }

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

  /* Сколько на каждом кошельке. Бот спрашивает обе суммы отдельно и передаёт
   * их в ссылке (?cinema=1200&other=2500). Без параметров считаем от полного
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

  function deck() {
    return pool().filter(function (e) { return !marked(e.eventId); });
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
    return loadFeed().filter(function (e) { return ids.indexOf(e.eventId) >= 0; });
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

  function react(item, kind) {
    state.undo.push(item.eventId);
    if (state.undo.length > 30) { state.undo.shift(); }
    mark(item, kind);
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
    var card = el('article', 'bigcard');

    var ph = photo(item, 'bigcard__photo');
    ph.appendChild(el('span', 'counter', shown + '/' + total));
    card.appendChild(ph);

    var body = el('div', 'bigcard__body');
    body.appendChild(el('span', 'badge', Cat.title(item.category)));
    body.appendChild(el('h2', 'card__title', item.title));
    body.appendChild(metaRow('calendar', whenText(item.startsAt)));
    body.appendChild(metaRow('pin', item.venueName));
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
    over.appendChild(metaRow('calendar', whenText(item.startsAt)));
    over.appendChild(metaRow('pin', item.venueName));
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
   * событие молча уезжало из подборки. Стопка живёт до перезагрузки: в
   * localStorage её класть незачем, это исправление только что сделанного. */
  function undoLast() {
    var id = state.undo.pop();
    if (id === undefined) { return; }
    forget(id);
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
      heart.addEventListener('click', function () {
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
          if (liked) { forget(item.eventId); } else { mark(item, 'liked'); }
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
    if (state.editWallet !== code) {
      var pencil = el('button', 'wallet__pencil');
      pencil.type = 'button';
      pencil.title = 'Изменить баланс';
      pencil.setAttribute('aria-label', 'Изменить баланс: ' + WALLETS[code].title);
      pencil.appendChild(icon('pencil', 14));
      pencil.addEventListener('click', function () {
        state.editWallet = code;
        render();
      });
      return pencil;
    }

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
    setTimeout(function () { input.focus(); input.select(); }, 0);
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
    return loadFeed().filter(function (e) { return e.eventId === id; })[0] || null;
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

  function confirmPurchase() {
    var item = state.pending === null ? null : byEventId(state.pending);
    if (!item) { clearPending(); return; }
    var w = walletOf(item.category);
    state.bought.push({ eventId: item.eventId, priceRub: item.priceRub, wallet: w, at: Date.now() });
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

    var item = loadFeed().filter(function (e) { return e.sessionId === state.detail; })[0];
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
    head.appendChild(metaRow('pin', item.venueName));
    head.appendChild(metaRow('map', item.venueAddress));

    var price = priceBlock(item, false);
    price.className = 'price detail__price';
    head.appendChild(price);

    // Описание и кнопки тоже на карточке — всё про событие в одном месте.
    head.appendChild(el('h2', 'detail__h2', 'О мероприятии'));
    head.appendChild(el('p', 'detail__text', item.summary));
    head.appendChild(actions(item));
    head.appendChild(saveButton(item));
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

  // Варианты радиуса и значение по умолчанию — как в боте (Screens.DISTANCE_OPTIONS,
  // app.default-distance-km).
  var KMS = [3, 5, 10, 20, 50];
  var DEFAULT_KM = 10;

  var NOTHING = 'Под выбранные фильтры ничего не нашлось. Смягчи их — и события вернутся.';

  var Cat = {
    titles: { THEATRE: 'Театр', CINEMA: 'Кино', MUSEUM: 'Выставка', CONCERT: 'Концерт', EXCURSION: 'Экскурсия' },
    title: function (code) { return this.titles[code] || 'Событие'; }
  };

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
  document.getElementById('ask-no').addEventListener('click', clearPending);
  // Нажатие мимо окна и Esc считаем за «ещё нет»: молча списать деньги
  // с того, кто закрыл вопрос, нельзя.
  document.getElementById('ask').addEventListener('click', function (e) {
    if (e.target === e.currentTarget) { clearPending(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !document.getElementById('ask').hidden) { clearPending(); }
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
  render();
  // Вкладку могли закрыть, не ответив: незаданный вопрос ждёт в хранилище.
  askPurchase();
})();
