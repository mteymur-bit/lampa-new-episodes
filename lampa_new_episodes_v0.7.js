/* Lampa New Episodes 0.7.0-alpha.1 — experimental one-series WTCH check. */
/* New Episodes: offline WTCH response adapter. Does not fetch or play media. */
(function (root) {
  'use strict';
  function integer(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
    var n = Number(value);
    return isFinite(n) && n >= 0 && n <= 100000 && Math.floor(n) === n ? n : null;
  }
  function usableUrl(value) {
    return typeof value === 'string' && value.length > 0 && !/[\u0000-\u0020]/.test(value) &&
      !/^(?:javascript|data|vbscript):/i.test(value) &&
      (!/^[a-z][a-z0-9+.-]*:/i.test(value) || /^https?:\/\//i.test(value));
  }
  function signal(json) {
    if (json && json.accsdb) return 'access_required';
    if (json && json.rch) return 'rch_required';
    if (json && json.life) return 'pending';
    return 'unknown_format';
  }
  function sources(payload) {
    var json = payload;
    if (typeof json === 'string') {
      try { json = JSON.parse(json); } catch (ignore) { return { status: 'unknown_format', sources: [] }; }
    }
    var pending = false;
    if (json && !json.accsdb && !json.rch && Array.isArray(json.online)) {
      pending = json.ready !== true;
      json = json.online;
    }
    if (!Array.isArray(json)) {
      return { status: signal(json), sources: [], memkey: json && typeof json.memkey === 'string' ? json.memkey : null };
    }
    var result = [];
    var invalid = 0;
    json.forEach(function (s) {
      if (!s || typeof s.name !== 'string' || !s.name.replace(/\s/g, '') || !usableUrl(s.url)) { invalid++; return; }
      result.push({ id: String(s.balanser || s.name.split(' ')[0]).toLowerCase(), name: s.name, url: s.url, enabled: typeof s.show === 'undefined' ? true : !!s.show });
    });
    return { status: pending ? 'pending' : invalid ? 'partial' : 'listed', sources: result, invalid: invalid };
  }
  function page(payload, document) {
    var out = { status: 'unknown_format', episodes: [], links: [], voices: [], invalid: 0, ambiguous: 0 };
    if (typeof payload !== 'string') { out.status = signal(payload); return out; }
    var text = payload.replace(/^\s+/, '');
    if (text.charAt(0) === '{' || text.charAt(0) === '[') {
      try { out.status = signal(JSON.parse(text)); } catch (ignore) { out.status = 'invalid_json'; }
      return out;
    }
    if (!document || typeof document.createElement !== 'function') { out.status = 'parser_unavailable'; return out; }
    // Template contents are inert: scripts, images and event attributes are never inserted into the live document.
    var template = document.createElement('template');
    if (!template.content || !template.content.querySelectorAll) { out.status = 'parser_unavailable'; return out; }
    template.innerHTML = payload;
    var nodes = template.content.querySelectorAll('.videos__item, .videos__button');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var data;
      try { data = JSON.parse(node.getAttribute('data-json')); } catch (ignore) { out.invalid++; continue; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) { out.invalid++; continue; }
      var season = integer(node.hasAttribute('s') ? node.getAttribute('s') : data.season);
      var episode = integer(node.hasAttribute('e') ? node.getAttribute('e') : data.episode);
      var record = { season: season, episode: episode, method: data.method,
        url: usableUrl(data.url) ? data.url : null, active: node.classList.contains('active') };
      if (node.classList.contains('videos__button')) {
        if (record.url) out.voices.push(record); else out.invalid++;
      } else if (data.similar) {
        // Similar results require manual identity confirmation; never turn them into episodes.
        out.ambiguous++;
      } else if (data.method === 'link') {
        if (record.url) out.links.push(record); else out.invalid++;
      } else if ((data.method === 'play' || data.method === 'call') && record.url && season !== null && episode !== null && episode > 0) {
        record.evidence = 'listed_by_source';
        record.playbackVerified = false;
        out.episodes.push(record);
      } else out.invalid++;
    }
    out.status = out.episodes.length || out.links.length || out.voices.length ? (out.invalid || out.ambiguous ? 'partial' : 'listed') :
      out.ambiguous ? 'identity_required' : out.invalid ? 'invalid_items' : 'unknown_format';
    return out;
  }
  function normalizedEpisodes(batches, includeSpecials) {
    var seen = {};
    var episodes = [];
    (batches || []).forEach(function (batch) {
      if (!batch || !Array.isArray(batch.episodes)) return;
      batch.episodes.forEach(function (e) {
        if (!e || integer(e.season) === null || integer(e.episode) === null || Number(e.episode) === 0 ||
            e.evidence !== 'listed_by_source' || (!includeSpecials && Number(e.season) === 0)) return;
        var key = Number(e.season) + ':' + Number(e.episode);
        if (!seen[key]) {
          seen[key] = { season: Number(e.season), episode: Number(e.episode), evidence: 'listed_by_source', playbackVerified: false, sources: [] };
          episodes.push(seen[key]);
        }
        var source = typeof batch.source === 'string' ? batch.source : 'unknown';
        if (seen[key].sources.indexOf(source) === -1) seen[key].sources.push(source);
      });
    });
    episodes.sort(function (a, b) { return a.season - b.season || a.episode - b.episode; });
    return episodes;
  }
  function percentage(road) {
    var p = typeof road === 'number' ? road : road && road.percent;
    return typeof p === 'number' && isFinite(p) && p >= 0 && p <= 100 ? p : null;
  }
  function progress(L, card, season, episode) {
    if (!card || !card.original_title) return { status: 'identity_missing', percent: null };
    if (integer(season) === null || integer(episode) === null || Number(episode) === 0) return { status: 'invalid_episode', percent: null };
    // The supplied WTCH hashes every season-0 item by title alone; episode identity is ambiguous.
    if (Number(season) === 0) return { status: 'special_progress_unsupported', percent: null };
    if (!L || !L.Utils || typeof L.Utils.hash !== 'function' || !L.Timeline || typeof L.Timeline.view !== 'function') return { status: 'api_missing', percent: null };
    try {
      // Mirrors the supplied WTCH draw(): original_title, delimiter for season >10, no voice in timeline hash.
      var input = Number(season) ? [Number(season), Number(season) > 10 ? ':' : '', Number(episode), card.original_title].join('') : card.original_title;
      var road = L.Timeline.view(L.Utils.hash(input));
      var p = percentage(road);
      if (p === null) return { status: 'invalid_progress', percent: null };
      // A default zero road from Timeline.view is indistinguishable from a missing record.
      return { status: p === 0 ? 'unknown_zero' : 'observed', percent: p };
    } catch (ignore) { return { status: 'read_error', percent: null }; }
  }
  function classify(episode, progressValue, threshold) {
    threshold = threshold == null ? 90 : threshold;
    if (typeof threshold !== 'number' || !isFinite(threshold) || threshold <= 0 || threshold > 100) return 'invalid_threshold';
    if (!episode || episode.evidence !== 'listed_by_source') return 'availability_unknown';
    if (!progressValue || progressValue.status !== 'observed' || percentage(progressValue) === null) return 'progress_unknown';
    return progressValue.percent >= threshold ? 'completed' : 'in_progress';
  }
  var api = { version: '0.1.0', parseSources: sources, parsePage: page,
    normalizedEpisodes: normalizedEpisodes, progress: progress, classify: classify };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LampaNewEpisodesWtchAdapter = api;
})(typeof window === 'object' ? window : this);

/* WTCH one-series reader. No playback, history writes or execution of RCH responses. */
(function (root) {
  'use strict';
  function create(options) {
    var L = options.Lampa;
    var adapter = options.adapter;
    var active = null;
    var later = options.setTimeout || root.setTimeout;
    var stopTimer = options.clearTimeout || root.clearTimeout;
    var getProfile = options.profile || function () { return 'local'; };
    var maxRequests = options.maxRequests || 30;
    var maxSources = options.maxSources || 3;
    var totalMs = options.totalMs || 90000;
    var URLClass = options.URL || root.URL;
    function parseJson(payload) {
      if (typeof payload !== 'string') return payload;
      try { return JSON.parse(payload); } catch (ignore) { return null; }
    }
    function scan(movie, complete, progress) {
      cancel();
      var op = { done: false, count: 0, timers: [], jobs: [], batches: [], seen: {}, profile: String(getProfile()),
        issues: [], sources: [], started: Date.now(), network: null, base: '' };
      active = op;
      var card = {};
      ['id','source','tmdb_id','imdb_id','kinopoisk_id','title','name','original_title','original_name','original_language','release_date','first_air_date'].forEach(function (key) {
        if (movie && (typeof movie[key] === 'string' || typeof movie[key] === 'number')) card[key] = movie[key];
      });
      function issue(code) { if (op.issues.indexOf(code) < 0) op.issues.push(code); }
      function valid() {
        if (op.done) return false;
        if (String(getProfile()) !== op.profile) { finish('profile_changed'); return false; }
        return true;
      }
      function finish(reason) {
        if (op.done) return;
        op.done = true;
        op.timers.forEach(function (t) { stopTimer(t); });
        try { if (op.network && op.network.clear) op.network.clear(); } catch (ignore) {}
        var out = { status: reason || (op.issues.length ? 'partial' : 'complete'), requests: op.count,
          issues: op.issues.slice(), sources: op.sources.slice(), episodes: adapter.normalizedEpisodes(op.batches),
          elapsedMs: Date.now() - op.started, coverageComplete: !reason && !op.issues.length, playbackVerified: false };
        // Results carry no routes, stream URLs, access parameters or raw server messages.
        if (reason === 'profile_changed' || reason === 'cancelled') { out.episodes = []; out.sources = []; }
        if (active === op) active = null;
        complete(out);
      }
      op.cancel = function () { finish('cancelled'); };
      function wait(callback, ms) {
        var id = later(function () { if (valid()) callback(); }, ms);
        op.timers.push(id);
        return id;
      }
      function normalize(route, parent) {
        var url;
        try { url = new URLClass(route, parent || op.base + '/'); } catch (ignore) { return null; }
        if (url.username || url.password || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
        // WTCH rewrites its original base when an existing source adapter selects a PRO base.
        if (/^(?:www\.)?wtch\.ch$/i.test(url.hostname) && url.origin !== op.base) {
          try { url = new URLClass(url.pathname + url.search, op.base + '/'); } catch (ignore) { return null; }
        }
        if (url.origin !== op.base || !/^\/(?:lite\/|lifeevents(?:\/|$)|externalids(?:\/|$))/.test(url.pathname)) return null;
        url.hash = '';
        return url;
      }
      function addCardParams(url) {
        var params = { id: card.id, title: card.title || card.name || '', original_title: card.original_title || card.original_name || '',
          serial: 1, original_language: card.original_language || '', year: String(card.release_date || card.first_air_date || '0000').slice(0,4),
          source: card.source || 'tmdb', clarification: 0, similar: false,
          rchtype: root.rch_nws && root.rch_nws['wtch.ch'] ? root.rch_nws['wtch.ch'].type || '' : '' };
        ['tmdb_id','imdb_id','kinopoisk_id'].forEach(function (key) { if (card[key]) params[key] = card[key]; });
        Object.keys(params).forEach(function (key) { if (!url.searchParams.has(key)) url.searchParams.set(key, String(params[key])); });
        return url;
      }
      function request(url, callback) {
        if (!valid()) return;
        if (!url) { callback('unsupported_route'); return; }
        if (op.count >= maxRequests) { issue('request_limit'); finish('request_limit'); return; }
        var once = false;
        var timer;
        function done(error, payload) {
          if (once) return;
          once = true; stopTimer(timer);
          if (error === 'timeout') { try { op.network.clear(); } catch (ignore) {} }
          if (!error && typeof payload === 'string' && payload.length > 2000000) error = 'response_too_large';
          if (valid()) callback(error, payload);
        }
        timer = wait(function () { done('timeout'); }, 12000);
        try {
          // Only the selected, allowlisted service origin receives existing WTCH access parameters.
          var pairs = { account_email: 'account_email', uid: 'lampac_unic_id', nws_id: 'lampac_nws_id', showy_token: 'showy_token' };
          Object.keys(pairs).forEach(function (key) {
            var value = L.Storage.get(pairs[key], '');
            if (value && !url.searchParams.has(key)) url.searchParams.set(key, String(value));
          });
          var token = L.Storage.get('showy_token', '');
          var ticket = L.Storage.get('showy_access_ticket', '');
          if (token && ticket && !url.searchParams.has('access_ticket')) url.searchParams.set('access_ticket', String(ticket));
          var headers = {};
          var key = L.Storage.get('kit_aesgcmkey', '');
          if (key) headers['X-Kit-AesGcm'] = key;
          op.count++;
          if (typeof progress === 'function') progress({ requests: op.count, pagesQueued: op.jobs.length });
          op.network.timeout(10000);
          op.network['native'](url.href, function (body) { done(null, body); }, function () { done('network_error'); }, false,
            { dataType: 'text', headers: headers });
        } catch (ignore) { done('request_error'); }
      }
      function enqueue(route, source, parent, rootPage) {
        var url = normalize(route, parent);
        if (!url) { issue('unsupported_route'); return; }
        if (rootPage) addCardParams(url);
        // Strip auth query parameters from routing keys. Credentials are only read at dispatch time.
        var keyUrl = new URLClass(url.href);
        ['account_email','uid','nws_id','showy_token','access_ticket','token','cub_id'].forEach(function (key) { keyUrl.searchParams.delete(key); });
        var key = source + ' ' + keyUrl.href;
        if (op.seen[key]) return;
        if (op.jobs.length >= 60) { issue('queue_limit'); return; }
        op.seen[key] = true;
        op.jobs.push({ url: url, source: source });
      }
      function pump() {
        if (!valid()) return;
        if (!op.jobs.length) { finish(); return; }
        var job = op.jobs.shift();
        request(job.url, function (error, body) {
          if (error) issue(error);
          else {
            var parsed;
            try { parsed = options.parsePage ? options.parsePage(body) : adapter.parsePage(body, options.document); }
            catch (ignore) { parsed = { status: 'parse_error', episodes: [], links: [], voices: [] }; }
            if (parsed.status !== 'listed') issue(parsed.status);
            op.batches.push({ source: job.source, episodes: parsed.episodes || [] });
            (parsed.links || []).concat(parsed.voices || []).forEach(function (link) { enqueue(link.url, job.source, job.url.href, false); });
          }
          // Yield between pages so cancellation, UI input and profile switches can be processed.
          wait(pump, 150);
        });
      }
      function discovered(parsed) {
        if (!valid()) return;
        if (parsed.status !== 'listed') issue(parsed.status);
        var enabled = (parsed.sources || []).filter(function (s) { return s.enabled; });
        var chosen = enabled.slice(0, maxSources);
        if (chosen.length < enabled.length) issue('source_limit');
        if (!chosen.length) issue('no_enabled_sources');
        chosen.forEach(function (source) {
          // Keep the provider identifier, not its arbitrary HTML display name, in shareable results.
          var id = /^(fxapi|filmix)/i.test(source.id) ? 'filmix' : /^rezka/i.test(source.id) ? 'rezka' : /^kodik/i.test(source.id) ? 'kodik' : 'source_'+(op.sources.length+1);
          op.sources.push(id); enqueue(source.url, id, null, true);
        });
        pump();
      }
      function discovery() {
        var first = addCardParams(normalize('/lite/events?life=true'));
        request(first, function (error, payload) {
          if (error) { issue(error); finish('discovery_failed'); return; }
          var parsed = adapter.parseSources(payload);
          if (parsed.status !== 'pending') { discovered(parsed); return; }
          if (!parsed.memkey) { issue('missing_memkey'); finish('discovery_failed'); return; }
          var polls = 0;
          function poll() {
            var url = normalize('/lifeevents'); url.searchParams.set('memkey', parsed.memkey); addCardParams(url);
            request(url, function (err, body) {
              if (err) { issue(err); finish('discovery_failed'); return; }
              var current = adapter.parseSources(body); polls++;
              if (current.status === 'pending' && polls < 8) wait(poll,1000);
              else { if (current.status === 'pending') issue('discovery_pending'); discovered(current); }
            });
          }
          wait(poll,1000);
        });
      }
      if (!movie || card.id == null || !card.name || (!card.original_title && !card.original_name)) { finish('invalid_series'); return; }
      if (!URLClass || !L || typeof L.Reguest !== 'function' || !L.Storage || typeof L.Storage.get !== 'function') { finish('api_missing'); return; }
      try {
        var base = 'http://wtch.ch';
        if (root.ShowyMarketingRuntime && typeof root.ShowyMarketingRuntime.sourceBase === 'function') base = root.ShowyMarketingRuntime.sourceBase(base);
        var origin = new URLClass(base);
        if (!/^(?:www\.)?(?:wtch\.ch|showypro\.com|showy\.pro)$/i.test(origin.hostname) || origin.username || origin.password || origin.port ||
            (origin.protocol !== 'http:' && origin.protocol !== 'https:')) { finish('unsupported_service'); return; }
        op.base = origin.origin;
        op.network = new L.Reguest();
        if (typeof op.network['native'] !== 'function' || typeof op.network.timeout !== 'function') { finish('api_missing'); return; }
      } catch (ignore) { finish('api_missing'); return; }
      wait(function () { issue('total_timeout'); finish('total_timeout'); }, totalMs);
      // Upstream WTCH tries external IDs first; failure is recorded and discovery can still use the supplied card.
      if (!card.imdb_id || !card.kinopoisk_id) {
        var url = normalize('/externalids'); url.searchParams.set('id', String(card.id)); url.searchParams.set('serial','1');
        ['imdb_id','kinopoisk_id'].forEach(function (key) { if (card[key]) url.searchParams.set(key, String(card[key])); });
        request(url, function (error, body) {
          var ids = parseJson(body);
          if (!error && ids && typeof ids === 'object') {
            ['imdb_id','kinopoisk_id','tmdb_id'].forEach(function (key) { if (typeof ids[key] === 'string' || typeof ids[key] === 'number') card[key] = ids[key]; });
          } else issue('external_ids_unavailable');
          discovery();
        });
      } else discovery();
    }
    function cancel() { if (active && active.cancel) active.cancel(); }
    return { scan: scan, cancel: cancel, busy: function () { return !!active; } };
  }
  var api = { create: create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LampaNewEpisodesWtchClient = api;
})(typeof window === 'object' ? window : this);

/* New Episodes 0.7.0-alpha.1: manual one-series WTCH probe inside Lampa. */
(function () {
  'use strict';
  var VERSION = '0.7.0-alpha.1';
  var SLOT = '__newEpisodesWtchPreview';
  var ID = 'new_episodes_wtch_preview_v07';
  if (window[SLOT]) { window[SLOT].retry(); return; }
  var state = 'waiting';
  var timer = null;
  var attempts = 0;
  var selected = null;
  var selectedProfile = '';
  var inventory = null;
  var lastAttempt = null;
  var client = null;
  var serial = 0;
  var componentAdded = false;
  var added = {};
  function host() { return window.Lampa || {}; }
  function method(o, name) { return !!o && typeof o[name] === 'function'; }
  function notify(text) { try { if (method(host().Noty,'show')) host().Noty.show(text); } catch (ignore) {} }
  function profile() {
    try {
      var L=host();
      if (method(L.Timeline,'filename')) return String(L.Timeline.filename());
      var p=L.Account && L.Account.Permit;
      if (p && !p.sync) return 'local';
      if (p && p.account && p.account.profile) return 'account:'+p.account.profile.id;
    } catch (ignore) {}
    return 'unknown';
  }
  function checkProfile() {
    if (selected && selectedProfile !== profile()) {
      serial++; if (client) client.cancel();
      selected=null; inventory=null; lastAttempt=null; selectedProfile='';
    }
  }
  function controller() {
    try { return method(host().Controller,'enabled') ? host().Controller.enabled().name : 'settings_component'; }
    catch (ignore) { return 'settings_component'; }
  }
  function restore(name) { try { if (method(host().Controller,'toggle')) host().Controller.toggle(name || 'settings_component'); } catch (ignore) {} }
  function show(title, text) {
    var L=host(); var back=controller();
    try {
      if (method(L.Modal,'open') && typeof window.$==='function') {
        L.Modal.open({ title:title, size:'medium', html:window.$('<div></div>').css({padding:'1em',whiteSpace:'pre-line',lineHeight:'1.5',wordBreak:'break-word'}).text(text),
          onBack:function(){ if(method(L.Modal,'close')) L.Modal.close(); restore(back); } });
        return;
      }
    } catch (ignore) {}
    notify('Не удалось открыть окно. Отчёт доступен через LampaNewEpisodesPreview.report().');
  }
  function choose() {
    checkProfile(); var L=host(); var back=controller(); var list=[];
    try {
      if (method(L.Favorite,'get')) list=L.Favorite.get({type:'history'});
      else if(method(L.Favorite,'all')) list=L.Favorite.all().history;
      if(!Array.isArray(list)) throw new Error('format');
      list=list.filter(function(c){return c && c.name && (c.first_air_date || c.number_of_seasons || c.media_type==='tv');});
    } catch (ignore) { show('История','Не удалось прочитать историю сериалов.'); return; }
    if(!list.length){show('История','Сериалы не найдены. Откройте сериал обычным способом и повторите выбор.');return;}
    if(!method(L.Select,'show') || typeof window.$!=='function'){show('Выбор','API выбора недоступно.');return;}
    L.Select.show({title:'Сериал для проверки WTCH',items:list.map(function(card,i){
      var html=window.$('<div class="selectbox-item selector"><div class="selectbox-item__title"></div></div>');
      html.find('.selectbox-item__title').text(card.name || 'Сериал '+(i+1));
      return {title:'Сериал '+(i+1),html:html,card:card};
    }),onBack:function(){restore(back);},onSelect:function(item){
      serial++; if(client)client.cancel();
      // Copy so downstream readers never mutate Favorite's card object.
      selected={}; Object.keys(item.card).forEach(function(k){if(typeof item.card[k]==='string' || typeof item.card[k]==='number')selected[k]=item.card[k];});
      selectedProfile=profile(); inventory=null;lastAttempt=null;restore(back);
      notify('Сериал выбран. Нажмите «Проверить источники WTCH».');
    }});
  }
  var labels={complete:'Обход завершён',partial:'Получен неполный результат',cancelled:'Проверка отменена',
    profile_changed:'Профиль изменился',invalid_series:'Недостаточно данных о сериале',api_missing:'Нужный API недоступен',
    unsupported_service:'Не поддержан выбранный сервер WTCH',discovery_failed:'Не удалось получить источники',
    total_timeout:'Истёк общий срок проверки',request_limit:'Достигнут лимит запросов',
    queue_limit:'Достигнут лимит очереди страниц',response_too_large:'Слишком большой ответ источника',
    network_error:'Ошибка сети',timeout:'Запрос превысил время ожидания',request_error:'Ошибка отправки запроса',
    external_ids_unavailable:'Внешние ID не получены',unsupported_route:'Не поддержан адрес перехода',
    source_limit:'Проверены только первые три доступных источника',access_required:'Сервер требует доступ',
    rch_required:'Для ответа нужен транспорт RCH',pending:'Источники ещё готовятся',discovery_pending:'Список источников ещё готовится',
    missing_memkey:'Нет ключа ожидания списка источников',no_enabled_sources:'Нет доступных для выбора источников',
    unknown_format:'Формат ответа не распознан',invalid_json:'Некорректный JSON',invalid_items:'Некорректные данные эпизодов',
    identity_required:'Нужно уточнить соответствие сериала',parser_unavailable:'Разбор HTML не поддерживается',parse_error:'Ошибка разбора ответа'};
  function label(code){return labels[code] || 'Неизвестное состояние';}
  function measuredEpisodes() {
    if(!inventory)return [];
    return inventory.episodes.map(function(e){
      var p=window.LampaNewEpisodesWtchAdapter.progress(host(),selected,e.season,e.episode);
      return {season:e.season,episode:e.episode,sources:e.sources,progress:p,
        status:window.LampaNewEpisodesWtchAdapter.classify(e,p)};
    });
  }
  function report() {
    checkProfile();
    var lines=['Новые серии '+VERSION+' — проверка одного сериала','Запуск: '+state,
      'WTCH загружен: '+(window.wtch_runtime_loaded || window.wtch_plugin ? 'да' : 'не подтверждено'),
      'Сериал: '+(selected?'выбран':'не выбран'),'Проверка выполняется: '+(client && client.busy()?'да':'нет')];
    if(lastAttempt){
      lines.push('Последняя попытка: '+label(lastAttempt.status),'Запросов: '+lastAttempt.requests,'Источников: '+lastAttempt.sources.length,
        'Полный обход в пределах проверки: '+(lastAttempt.coverageComplete?'да':'нет'));
      lastAttempt.issues.forEach(function(code){lines.push('Ограничение: '+label(code));});
    }
    if(inventory){
      var counts={completed:0,in_progress:0,progress_unknown:0};
      measuredEpisodes().forEach(function(e){counts[e.status]=(counts[e.status]||0)+1;});
      lines.push('Эпизодов в последнем сохранённом результате: '+inventory.episodes.length,
        'Завершены по прогрессу ≥90%: '+counts.completed,'В процессе: '+counts.in_progress,'Прогресс требует сверки: '+counts.progress_unknown,
        'Возраст результата: '+Math.floor((Date.now()-inventory.savedAt)/1000)+' с');
      if(lastAttempt!==inventory)lines.push('Показан предыдущий результат: последняя попытка не дала нового списка.');
    }
    lines.push('Наличие в списке источника ещё не подтверждает успешный запуск потока.',
      'Это тестовая проверка; количество новых непросмотренных серий пока не определяется.',
      'Названия, ID, URL, токены и аккаунты в отчёт не включаются.');
    return lines.join('\n');
  }
  function episodes() {
    checkProfile();
    if(!inventory){show('Серии WTCH','Сначала выберите сериал и выполните проверку источников.');return;}
    var rows=measuredEpisodes(); var back=controller(); var L=host();
    if(!rows.length){show('Серии WTCH','В этой попытке не получен список эпизодов. Это не доказывает их отсутствие.\n\n'+report());return;}
    if(!method(L.Select,'show')){show('Серии WTCH','API списка недоступен.\n\n'+report());return;}
    L.Select.show({title:'Эпизоды, перечисленные источниками',items:rows.map(function(e){
      var status=e.status==='completed'?'просмотрено':e.status==='in_progress'?'в процессе':'нужна сверка прогресса';
      return {title:'S'+e.season+' E'+e.episode+' — '+status,subtitle:e.sources.join(', '),data:e};
    }),onBack:function(){restore(back);},onSelect:function(item){
      restore(back);var e=item.data;
      show('S'+e.season+' E'+e.episode,'Источники: '+e.sources.join(', ')+'\nПрогресс: '+
        (e.progress.percent==null?'неизвестен':e.progress.percent+'%')+'\nДля просмотра откройте этот сериал обычной кнопкой WTCH.\n'+
        'Успешный запуск потока данной проверкой не подтверждён.');
    }});
  }
  function scan() {
    checkProfile();
    if(!selected){notify('Сначала выберите сериал.');return;}
    if(!window.wtch_runtime_loaded && !window.wtch_plugin){show('WTCH','Сначала включите установленный WTCH и перезапустите Lampa.');return;}
    if(!client){show('WTCH','Клиент проверки не инициализирован.');return;}
    var run=++serial;
    notify('Проверка WTCH началась: до 30 запросов, максимум 90 секунд. Можно отменить в настройках.');
    client.scan(selected,function(result){
      if(run!==serial)return;
      checkProfile();if(!selected || run!==serial)return;
      lastAttempt=result;
      if(result.status!=='cancelled' && result.status!=='profile_changed' && (result.episodes.length || result.coverageComplete)){
        result.savedAt=Date.now();inventory=result;
      }
      notify('WTCH: '+label(result.status)+'. Откройте отчёт или найденные эпизоды.');
    });
  }
  var buttons=[
    ['choose','Выбрать сериал из истории','Для первого испытания — один известный сериал.',choose],
    ['scan','Проверить источники WTCH','Отправит запросы установленному сервису с его текущими параметрами доступа. До 3 источников, 30 запросов и 90 секунд.',scan],
    ['cancel','Отменить проверку','Остановить очередь и запросы.',function(){if(client)client.cancel();}],
    ['episodes','Посмотреть найденные эпизоды','Список источников и степень просмотра; неизвестный прогресс требует сверки.',episodes],
    ['report','Показать обезличенный отчёт','Статусы, счётчики и ограничения последней попытки.',function(){show('Отчёт WTCH',report());}]
  ];
  function start() {
    if(state==='ready')return true;
    attempts++;var L=host();
    if(!method(L.SettingsApi,'addComponent') || !method(L.SettingsApi,'addParam'))return false;
    try {
      if(!componentAdded){L.SettingsApi.addComponent({component:ID,name:'Новые серии — проверка WTCH 0.7',icon:'<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M4 4h16v16H4zM9 8v8l7-4z"/></svg>'});componentAdded=true;}
      if(method(L.SettingsApi,'removeParams')){L.SettingsApi.removeParams(ID);added={};}
      buttons.forEach(function(b){if(!added[b[0]]){L.SettingsApi.addParam({component:ID,param:{name:'ne_wtch07_'+b[0],type:'button'},field:{name:b[1],description:b[2]},onChange:function(){try{b[3]();}catch(ignore){notify('Не удалось выполнить действие. Откройте отчёт или перезапустите Lampa.');}}});added[b[0]]=true;}});
      client=window.LampaNewEpisodesWtchClient.create({Lampa:L,adapter:window.LampaNewEpisodesWtchAdapter,document:document,profile:profile});
      state='ready';notify('Проверка WTCH 0.7 добавлена в настройки.');return true;
    }catch(ignore){state='error';return false;}
  }
  function tick(){timer=null;if(start())return;if(attempts<60)timer=window.setTimeout(tick,500);else state='timeout';}
  function retry(){if(state==='ready'||timer!==null)return;attempts=0;tick();}
  var api={version:VERSION,report:report,retry:retry,cancel:function(){if(client)client.cancel();}};
  window[SLOT]=api;window.LampaNewEpisodesPreview=api;tick();
})();
