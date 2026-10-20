/* Lampa New Episodes 0.6.0 — diagnostics, no history writes or network requests. */
(function () {
  'use strict';
  var VERSION = '0.6.0';
  var SLOT = '__lampaNewEpisodesDiagnostics';
  var ID = 'new_episodes_diagnostics_v06';
  var previous = window[SLOT];
  if (previous && previous.version === VERSION) {
    previous.retry();
    return;
  }
  var state = 'waiting';
  var attempts = 0;
  var timer = null;
  var lastError = '';
  var selected = null;
  var season = 1;
  var episode = 1;
  var baseline = null;
  var selectionProfile = '';
  var added = {};
  var componentAdded = false;

  function method(object, name) { return !!object && typeof object[name] === 'function'; }
  function host() { return window.Lampa || {}; }
  function notify(text) {
    try { if (method(host().Noty, 'show')) host().Noty.show(text); } catch (ignore) {}
  }
  function controller() {
    try {
      var C = host().Controller;
      return method(C, 'enabled') ? C.enabled().name : 'settings_component';
    } catch (ignore) { return 'settings_component'; }
  }
  function restore(name) {
    try { if (method(host().Controller, 'toggle')) host().Controller.toggle(name || 'settings_component'); } catch (ignore) {}
  }
  function display(title, text) {
    var L = host();
    var back = controller();
    try {
      if (method(L.Modal, 'open') && method(L.Modal, 'close') && typeof window.$ === 'function') {
        var html = window.$('<div></div>').css({ padding: '1em', whiteSpace: 'pre-line', lineHeight: '1.5', wordBreak: 'break-word' }).text(text);
        L.Modal.open({ title: title, html: html, size: 'medium', onBack: function () {
          L.Modal.close(); restore(back);
        } });
        return;
      }
    } catch (ignore) {}
    // Long reports remain accessible through the public report() API.
    notify('Новые серии ' + VERSION + ': окно отчёта недоступно в этой сборке.');
  }
  function profile() {
    var L = host();
    try {
      var p = L.Account && L.Account.Permit;
      if (!p) return 'unknown';
      if (!p.sync) return 'local';
      if (p.account && p.account.profile && p.account.profile.id != null) return 'account:' + p.account.profile.id;
      return 'unknown';
    } catch (ignore) { return 'unknown'; }
  }
  function checkProfile() {
    if (selected && selectionProfile !== profile()) {
      selected = null; baseline = null; selectionProfile = '';
      return false;
    }
    return true;
  }
  function history() {
    var L = host();
    try {
      var list;
      if (method(L.Favorite, 'get')) list = L.Favorite.get({ type: 'history' });
      else if (method(L.Favorite, 'all')) {
        var all = L.Favorite.all();
        list = all && all.history;
      } else return { status: 'api_missing', cards: [] };
      if (!Array.isArray(list)) return { status: 'invalid_format', cards: [] };
      return { status: 'ok', total: list.length, cards: list.filter(function (c) {
        return c && typeof c === 'object' && (c.media_type === 'tv' || c.type === 'tv' || c.first_air_date || c.number_of_seasons);
      }) };
    } catch (ignore) { return { status: 'read_error', cards: [] }; }
  }
  function summary(key) {
    var L = host();
    if (!method(L.Storage, 'get')) return 'API отсутствует';
    try {
      var v = L.Storage.get(key, 'null');
      if (v === 'null' || v == null || v === '') return 'нет данных';
      if (Array.isArray(v)) return 'массив, записей: ' + v.length;
      if (typeof v === 'object') return 'объект, ключей: ' + Object.keys(v).length;
      return 'тип: ' + typeof v;
    } catch (ignore) { return 'ошибка чтения'; }
  }
  function number(value, max) {
    return typeof value === 'number' && isFinite(value) && value >= 0 && (max == null || value <= max) ? value : null;
  }
  function sample() {
    if (!checkProfile()) return { status: 'profile_changed' };
    if (!selected) return { status: 'select_series' };
    var L = host();
    if (!method(L.Timeline, 'watchedEpisode')) return { status: 'api_missing' };
    if (!selected.original_name && !selected.original_title) return { status: 'identity_missing' };
    try {
      var road = L.Timeline.watchedEpisode(selected, season, episode, true);
      var percent = number(typeof road === 'number' ? road : road && road.percent, 100);
      if (percent == null) return { status: 'invalid_format' };
      return { status: 'read', season: season, episode: episode, percent: percent,
        time: number(road && road.time), duration: number(road && road.duration) };
    } catch (ignore) { return { status: 'read_error' }; }
  }
  function description(s) {
    var labels = { profile_changed: 'Профиль изменился: выберите сериал заново.', select_series: 'Сериал не выбран.',
      api_missing: 'Timeline.watchedEpisode отсутствует.', identity_missing: 'Нет исходного названия для сопоставления.',
      invalid_format: 'Неизвестный формат прогресса.', read_error: 'Ошибка чтения прогресса.' };
    if (s.status !== 'read') return labels[s.status] || 'Прогресс неизвестен.';
    return 'Сезон ' + s.season + ', серия ' + s.episode + '\nПрогресс API: ' + s.percent + '%\nВремя: ' +
      (s.time == null ? 'неизвестно' : s.time + ' с') + '\nДлительность: ' + (s.duration == null ? 'неизвестно' : s.duration + ' с') +
      '\nЭто чтение API, а не подтверждение соответствия VideoHUB. Ноль может означать несовпадение схемы истории.';
  }
  function report() {
    checkProfile();
    var L = host();
    var h = history();
    var lines = ['Новые серии ' + VERSION + ' — диагностика', 'Запуск: ' + state, 'Попыток запуска: ' + attempts];
    if (lastError) lines.push('Ошибка запуска: ' + lastError);
    ['SettingsApi.addComponent', 'SettingsApi.addParam', 'Favorite.get', 'Favorite.all', 'Timeline.watchedEpisode',
      'Storage.get', 'Select.show', 'Modal.open', 'ContentRows.add'].forEach(function (path) {
      var parts = path.split('.'); lines.push(path + ': ' + (method(L[parts[0]], parts[1]) ? 'да' : 'нет'));
    });
    lines.push('История: ' + h.status, 'Карточек: ' + (h.total == null ? 'неизвестно' : h.total), 'Сериалов: ' + h.cards.length,
      'Контекст профиля: ' + (profile() === 'local' ? 'локальный' : profile() === 'unknown' ? 'не определён' : 'аккаунт'),
      'online_view: ' + summary('online_view'), 'online_watched_last: ' + summary('online_watched_last'),
      'Тестовый сериал: ' + (selected ? 'выбран' : 'не выбран'), description(sample()),
      'Исходный замер: ' + (baseline ? 'есть в памяти' : 'нет'),
      'Доступность эпизодов в источниках: НЕ ПРОВЕРЯЕТСЯ в диагностической версии.',
      'Отчёт не содержит названий, ID, адресов потоков, аккаунтов или токенов.');
    return lines.join('\n');
  }
  function chooseSeries() {
    var L = host(); var h = history(); var back = controller();
    if (h.status !== 'ok' || !h.cards.length) { display('Выбор сериала', 'История: ' + h.status + '\nСериалы не найдены. Сначала откройте сериал через онлайн-плагин.'); return; }
    if (!method(L.Select, 'show') || typeof window.$ !== 'function') { display('Выбор сериала', 'Select.show или jQuery недоступны.'); return; }
    try {
      L.Select.show({ title: 'Тестовый сериал из истории', items: h.cards.map(function (c, i) {
        var safeTitle = 'Сериал №' + (i + 1);
        // Names are shown only on-device, always as text, never exported in reports.
        var html = window.$('<div class="selectbox-item selector"><div class="selectbox-item__title"></div></div>');
        html.find('.selectbox-item__title').text(c.name || c.title || safeTitle);
        return { title: safeTitle, html: html, card: c };
      }), onBack: function () { restore(back); }, onSelect: function (item) {
        // Keep only fields needed by the host's timeline reader, not a reference to Favorite.
        selected = { id: item.card.id, source: item.card.source, original_name: item.card.original_name, original_title: item.card.original_title };
        selectionProfile = profile(); baseline = null; restore(back);
        notify('Сериал выбран. Выберите сезон и серию.');
      } });
    } catch (ignore) { restore(back); notify('Не удалось открыть список сериалов.'); }
  }
  function chooseNumber(kind) {
    var L = host(); var back = controller(); var items = [];
    if (!method(L.Select, 'show')) { notify('Select.show отсутствует.'); return; }
    var limit = kind === 'season' ? 30 : 100;
    for (var i = kind === 'season' ? 0 : 1; i <= limit; i++) items.push({ title: String(i), value: i, selected: i === (kind === 'season' ? season : episode) });
    try {
      L.Select.show({ title: kind === 'season' ? 'Сезон тестового эпизода (0–30)' : 'Серия тестового эпизода (1–100)', items: items,
        onBack: function () { restore(back); }, onSelect: function (item) {
          if (kind === 'season') season = item.value; else episode = item.value;
          baseline = null; restore(back); notify('Выбрано: сезон ' + season + ', серия ' + episode);
        } });
    } catch (ignore) { restore(back); notify('Не удалось открыть выбор номера.'); }
  }
  function takeBaseline() {
    var s = sample();
    if (s.status === 'read') baseline = { profile: profile(), sample: s };
    display('Исходный замер', description(s) + (s.status === 'read' ? '\nЗамер сохранён в памяти до перезапуска Lampa.' : ''));
    return s;
  }
  function compare() {
    var s = sample(); var text = description(s);
    if (s.status === 'read' && baseline && baseline.profile === profile()) {
      text += '\nИзменение прогресса: ' + (s.percent - baseline.sample.percent) + ' п.п.';
      if (s.time != null && baseline.sample.time != null) text += '\nИзменение времени: ' + (s.time - baseline.sample.time) + ' с';
      text += '\nИзменение нужно сверить с фактическим просмотром выбранного эпизода.';
    } else text += '\nДля сравнения сначала сохраните исходный замер этого эпизода.';
    display('Повторный замер', text);
    return text;
  }
  var buttons = [
    ['report', 'Показать обезличенный отчёт', 'Наличие API и количество записей; без названий и адресов.', function () { display('Отчёт диагностики', report()); }],
    ['series', 'Выбрать тестовый сериал', 'Из истории Lampa. Название видно только в списке на устройстве.', chooseSeries],
    ['season', 'Выбрать сезон', 'Для диагностики: 0–30; по умолчанию 1.', function () { chooseNumber('season'); }],
    ['episode', 'Выбрать серию', 'Для диагностики: 1–100; по умолчанию 1.', function () { chooseNumber('episode'); }],
    ['baseline', 'Сохранить исходный замер', 'Перед коротким просмотром выбранного эпизода; только в памяти.', takeBaseline],
    ['compare', 'Проверить прогресс после просмотра', 'Вернитесь из плеера и сравните результат с исходным замером.', compare]
  ];
  function start() {
    if (state === 'ready') return true;
    attempts++;
    var L = host();
    if (!method(L.SettingsApi, 'addComponent') || !method(L.SettingsApi, 'addParam')) { state = 'waiting'; return false; }
    state = 'registering';
    try {
      if (!componentAdded) {
        L.SettingsApi.addComponent({ component: ID, name: 'Новые серии — диагностика 0.6',
          icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 8 6 4-6 4z"/></svg>' });
        componentAdded = true;
      }
      // This ID belongs only to 0.6. Rebuild after a partial registration if supported.
      if (method(L.SettingsApi, 'removeParams')) { L.SettingsApi.removeParams(ID); added = {}; }
      buttons.forEach(function (b) {
        if (!added[b[0]]) {
          L.SettingsApi.addParam({ component: ID, param: { name: 'ne_diag_v06_' + b[0], type: 'button' },
            field: { name: b[1], description: b[2] }, onChange: b[3] });
          added[b[0]] = true;
        }
      });
      state = 'ready'; lastError = ''; notify('Новые серии 0.6: диагностика доступна в настройках.');
      return true;
    } catch (ignore) { state = 'error'; lastError = 'settings_registration_failed'; return false; }
  }
  function tick() {
    timer = null;
    if (start()) return;
    if (attempts < 60) timer = window.setTimeout(tick, 500);
    else { state = 'timeout'; notify('Новые серии 0.6: запуск не завершён. Перезапустите Lampa.'); }
  }
  function retry() {
    if (state === 'ready' || timer !== null) return;
    attempts = 0; tick();
  }
  var api = { version: VERSION, report: report, retry: retry, sample: sample, takeBaseline: takeBaseline, compare: compare };
  window[SLOT] = api;
  window.LampaNewEpisodes = api;
  tick();
})();
