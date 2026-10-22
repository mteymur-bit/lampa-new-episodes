/* Lampa New Episodes 1.0.0. WTCH-listed episodes, local subscriptions. */
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
        issues: [], sources: [], diagnostics: [], started: Date.now(), network: null, base: '' };
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
          issues: op.issues.slice(), sources: op.sources.slice(), diagnostics: op.diagnostics.slice(), episodes: adapter.normalizedEpisodes(op.batches),
          elapsedMs: Date.now() - op.started, coverageComplete: !reason && !op.issues.length, playbackVerified: false };
        // Results carry no routes, stream URLs, access parameters or raw server messages.
        if (reason === 'profile_changed' || reason === 'cancelled') { out.episodes = []; out.sources = []; out.diagnostics = []; }
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
        if (op.base !== 'http://wtch.ch' && url.origin === 'http://wtch.ch') {
          try { url = new URLClass(url.pathname + url.search, op.base + '/'); } catch (ignore) { return null; }
        }
        if ((url.origin !== op.base && (!/^(?:www\.)?wtch\.ch$/i.test(url.hostname) || url.port)) ||
            !/^\/(?:lite\/|lifeevents(?:\/|$)|externalids(?:\/|$))/.test(url.pathname)) return null;
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
      function provider(id, index) {
        return /^(fxapi|filmix)/i.test(id) ? 'filmix' : /^rezka/i.test(id) ? 'rezka' : /^kodik/i.test(id) ? 'kodik' : 'source_' + index;
      }
      function failureDetails(error) {
        var status = error && error.status;
        status = typeof status === 'number' && isFinite(status) && status >= 0 && status <= 599 && Math.floor(status) === status ? status : null;
        var kind = error && (error.textStatus || error.statusText);
        kind = typeof kind === 'string' ? kind.toLowerCase() : '';
        var reason = kind === 'timeout' ? 'timeout' : kind === 'parsererror' ? 'parsererror' : kind === 'abort' ? 'abort' :
          status === 0 ? 'no_response' : status !== null && status >= 400 ? 'http_error' : 'transport_error';
        // Error bodies are examined only for control signals, never used as availability evidence or exported.
        var body = error && (error.responseJSON || parseJson(error.responseText));
        return { http: status, reason: reason, signal: body && body.accsdb ? 'access_required' : body && body.rch ? 'rch_required' : null };
      }
      function request(url, callback, context) {
        context = context || { stage: 'page', source: '' };
        if (!valid()) return;
        if (!url) { callback('unsupported_route'); return; }
        if (op.count >= maxRequests) { issue('request_limit'); finish('request_limit'); return; }
        var once = false;
        var timer;
        function done(error, payload, details) {
          if (once) return;
          once = true; stopTimer(timer);
          if (error === 'timeout') { try { op.network.clear(); } catch (ignore) {} }
          if (!error && typeof payload === 'string' && payload.length > 2000000) error = 'response_too_large';
          if (valid()) {
            var sample = { stage: context.stage, source: context.source || '', outcome: error || 'ok',
              scheme: url.protocol === 'https:' ? 'https' : 'http', service: /wtch\.ch$/i.test(url.hostname) ? 'wtch' : 'selected_service',
              http: details ? details.http : null, reason: details ? details.reason : error === 'timeout' ? 'timeout' : '',
              format: error ? '' : typeof payload === 'string' ? (/^\s*</.test(payload) ? 'html' : /^\s*[\[{]/.test(payload) ? 'json' : 'text') : 'object' };
            op.diagnostics.push(sample);
            callback(error, payload, details);
          }
        }
        timer = wait(function () { done('timeout'); }, 12000);
        try {
          // Only the selected service or the original WTCH service receives existing access parameters.
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
          op.network['native'](url.href, function (body) { done(null, body); }, function (error) { var details = failureDetails(error); done(details.signal || 'network_error', null, details); }, false,
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
        request(job.url, function (error, body, details) {
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
        }, { stage: 'page', source: job.source });
      }
      function discovered(parsed) {
        if (!valid()) return;
        if (parsed.status !== 'listed') issue(parsed.status);
        var enabled = (parsed.sources || []).filter(function (s) { return s.enabled; });
        var sourceChoice = typeof options.source === 'function' ? options.source() : options.source || 'auto';
        if (sourceChoice !== 'auto') {
          enabled = enabled.filter(function (s) { return provider(s.id, 0) === sourceChoice; });
          if (!enabled.length) issue('selected_source_unavailable');
        } else {
          // The user watches Filmix/Rezka/Kodik. Prefer these over arbitrary server ordering.
          var ranked = enabled.map(function (s, i) { return { source: s, index: i, rank: ['filmix','rezka','kodik'].indexOf(provider(s.id, i+1)) }; });
          ranked.sort(function (a,b) { return (a.rank < 0 ? 10 : a.rank) - (b.rank < 0 ? 10 : b.rank) || a.index - b.index; });
          enabled = ranked.map(function (r) { return r.source; });
        }
        // Give each provider one slot before allocating duplicate provider variants.
        // Otherwise two Filmix routes can consume slots while Kodik never gets checked.
        if (sourceChoice === 'auto') {
          var first=[], variants=[], seenProviders={};
          enabled.forEach(function(s,i){
            var name=provider(s.id,i+1);
            if(seenProviders[name])variants.push(s);else{seenProviders[name]=true;first.push(s);}
          });
          enabled=first.concat(variants);
        }
        var chosen = enabled.slice(0, maxSources);
        if (chosen.length < enabled.length) issue('source_limit');
        if (!chosen.length) issue('no_enabled_sources');
        chosen.forEach(function (source) {
          // Keep the provider identifier, not its arbitrary HTML display name, in shareable results.
          var id = provider(source.id, op.sources.length+1);
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
            }, { stage: 'discovery', source: '' });
          }
          wait(poll,1000);
        }, { stage: 'discovery', source: '' });
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
        }, { stage: 'ids', source: '' });
      } else discovery();
    }
    function cancel() { if (active && active.cancel) active.cancel(); }
    return { scan: scan, cancel: cancel, busy: function () { return !!active; } };
  }
  var api = { create: create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LampaNewEpisodesWtchClient = api;
})(typeof window === 'object' ? window : this);

/* Persistent, profile-scoped episode tracking. Writes only its own localStorage key. */
(function(root){
  'use strict';
  var KEY='lampa_new_episodes_tracking_v1';
  function own(o,k){return Object.prototype.hasOwnProperty.call(o,k);}
  function clone(v){return JSON.parse(JSON.stringify(v));}
  function object(v){return v && typeof v==='object' && !Array.isArray(v);}
  function episodeKey(e){
    if(!e || typeof e.season!=='number' || typeof e.episode!=='number' || !isFinite(e.season) || !isFinite(e.episode) ||
       e.season<1 || e.episode<1 || e.season>100000 || e.episode>100000 || Math.floor(e.season)!==e.season || Math.floor(e.episode)!==e.episode)return null;
    return 'e:'+e.season+':'+e.episode;
  }
  function cardKey(card){
    if(!card || (typeof card.id!=='number' && typeof card.id!=='string') || (typeof card.id==='number' && (!isFinite(card.id) || card.id<=0 || Math.floor(card.id)!==card.id)) || !/^[a-zA-Z0-9_-]{1,96}$/.test(String(card.id)) || !/^[a-zA-Z0-9_-]{1,32}$/.test(card.source || 'tmdb'))throw Error('tracking_identity');
    return 's:'+(card.source || 'tmdb')+':'+String(card.id);
  }
  function safeCard(card){
    var out={};
    ['id','source','name','title','original_name','original_title','poster_path','backdrop_path','first_air_date','original_language','number_of_seasons','media_type','tmdb_id','imdb_id','kinopoisk_id'].forEach(function(k){
      if(typeof card[k]==='string'){
        if(k==='original_name' || k==='original_title'){if(card[k].length>2000)throw Error('tracking_identity');out[k]=card[k];}
        else out[k]=card[k].slice(0,500);
      }
      else if(typeof card[k]==='number' && isFinite(card[k]))out[k]=card[k];
    });
    out.media_type='tv';
    return out;
  }
  function create(options){
    var storage=options.storage;var currentProfile=options.profile;var now=options.now || Date.now;
    function read(){
      var raw;
      try{raw=storage.getItem(KEY);}catch(ignore){throw Error('tracking_read_failed');}
      if(!raw)return {schema:1,profiles:{}};
      var data;
      try{data=JSON.parse(raw);}catch(ignore){throw Error('tracking_corrupt');}
      if(!object(data) || data.schema!==1 || !object(data.profiles))throw Error('tracking_schema');
      return data;
    }
    function bucket(data){
      var profile=String(currentProfile());
      if(!profile || profile==='unknown')throw Error('tracking_profile_unknown');
      var key='p:'+encodeURIComponent(profile);
      if(!own(data.profiles,key))data.profiles[key]={series:{}};
      if(!object(data.profiles[key]) || !object(data.profiles[key].series))throw Error('tracking_corrupt');
      return data.profiles[key].series;
    }
    function write(data){
      try{storage.setItem(KEY,JSON.stringify(data));}catch(ignore){throw Error('tracking_write_failed');}
    }
    function get(card){var series=bucket(read());var key=cardKey(card);return own(series,key)?clone(series[key]):null;}
    function list(){var series=bucket(read());return Object.keys(series).map(function(k){return clone(series[k]);});}
    function update(card,result,scope,subscribe){
      if(!result || !Array.isArray(result.episodes) || ['cancelled','profile_changed','invalid_series','api_missing'].indexOf(result.status)!==-1)throw Error('tracking_no_result');
      if(['auto','filmix','rezka','kodik'].indexOf(scope)===-1)throw Error('tracking_scope');
      var data=read();var series=bucket(data);var key=cardKey(card);var time=now();var entry;
      if(!own(series,key)){
        if(!subscribe)return null;
        if(Object.keys(series).length>=50)throw Error('tracking_limit');
        entry={card:safeCard(card),scope:scope,startedAt:time,checkedAt:0,baselineReady:false,zeroTrusted:false,episodes:{}};
      }else entry=series[key];
      if(!object(entry) || !object(entry.episodes))throw Error('tracking_corrupt');
      if(entry.scope!==scope)throw Error('tracking_scope_mismatch');
      var complete=result.coverageComplete===true;
      var initial=!entry.baselineReady;
      var hadSnapshot=entry.snapshotReady===true || Object.keys(entry.episodes).length>0;
      // Negative evidence is applied only after a successful full scan of the same configured scope.
      if(complete)Object.keys(entry.episodes).forEach(function(k){entry.episodes[k].present=false;});
      result.episodes.forEach(function(e){
        var ek=episodeKey(e);
        if(!ek || e.evidence!=='listed_by_source')return;
        if(!own(entry.episodes,ek))entry.episodes[ek]={season:e.season,episode:e.episode,origin:initial?'baseline':'new',discoveryNew:hadSnapshot,firstSeen:time,manual:null};
        var saved=entry.episodes[ek];saved.present=true;saved.lastSeen=time;
        saved.sources=(Array.isArray(e.sources)?e.sources:[]).filter(function(s){return typeof s==='string' && /^[a-z0-9_]{1,32}$/.test(s);});
      });
      if(Object.keys(entry.episodes).length>5000)throw Error('tracking_episode_limit');
      // The first complete scan establishes the baseline. Episodes discovered while it was partial are not fresh releases.
      if(initial && complete){
        entry.baselineReady=true;
        Object.keys(entry.episodes).forEach(function(k){entry.episodes[k].origin='baseline';});
      }
      entry.snapshotReady=hadSnapshot || Object.keys(entry.episodes).length>0;
      entry.checkedAt=time;entry.lastStatus=result.status;entry.lastComplete=complete;
      series[key]=entry;write(data);return clone(entry);
    }
    function change(card,apply){
      var data=read();var series=bucket(data);var key=cardKey(card);
      if(!own(series,key))throw Error('tracking_not_subscribed');
      apply(series[key]);write(data);return clone(series[key]);
    }
    function trustZero(card,value){return change(card,function(e){e.zeroTrusted=value===true;});}
    function mark(card,episode,state){
      if([null,'unwatched','completed'].indexOf(state)===-1)throw Error('tracking_mark');
      return change(card,function(e){var key=episodeKey(episode);if(!key || !own(e.episodes,key))throw Error('tracking_episode_missing');e.episodes[key].manual=state;});
    }
    function remove(card){var data=read();var series=bucket(data);delete series[cardKey(card)];write(data);}
    function view(entry,readProgress){
      var counts={newAvailable:0,backlog:0,inProgress:0,completed:0,unknown:0,stale:0,discovered:0};
      var episodes=[];
      Object.keys(entry.episodes).forEach(function(key){
        var e=entry.episodes[key];if(!e.present)return;
        var p;
        try{p=readProgress(entry.card,e.season,e.episode);}catch(ignore){p={status:'read_error',percent:null};}
        var status='unknown';
        if(e.manual==='completed')status='completed';
        else if(e.manual==='unwatched')status='unwatched';
        else if(p && p.status==='observed' && typeof p.percent==='number' && isFinite(p.percent) && p.percent>0 && p.percent<=100)status=p.percent>=90?'completed':'in_progress';
        else if(entry.zeroTrusted && p && p.status==='unknown_zero')status='unwatched';
        var stale=e.lastSeen!==entry.checkedAt || now()-e.lastSeen>86400000;
        var discovered=e.discoveryNew===true || e.origin==='new';
        if(discovered && status!=='completed')counts.discovered++;
        if(stale)counts.stale++;
        if(status==='completed')counts.completed++;
        else if(status==='unknown')counts.unknown++;
        else{
          if(status==='in_progress')counts.inProgress++;
          if(e.origin==='new' && entry.baselineReady)counts.newAvailable++;
          else counts.backlog++;
        }
        episodes.push({season:e.season,episode:e.episode,origin:e.origin,discovered:discovered,status:status,stale:stale,sources:e.sources,manual:e.manual,percent:p && p.percent});
      });
      episodes.sort(function(a,b){return a.season-b.season || a.episode-b.episode;});
      return {card:clone(entry.card),scope:entry.scope,baselineReady:entry.baselineReady,checkedAt:entry.checkedAt,lastComplete:entry.lastComplete,counts:counts,episodes:episodes};
    }
    return {get:get,list:list,update:update,trustZero:trustZero,mark:mark,remove:remove,view:view,key:KEY};
  }
  var api={create:create,key:KEY};
  if(typeof module==='object' && module.exports)module.exports=api;else root.LampaNewEpisodesTrackingStore=api;
})(typeof window==='object'?window:this);

/* Serial refresh scheduler. No work while hidden/playing; never scans the whole history. */
(function(root){
  'use strict';
  function create(o){
    var timer=null, running=false, disposed=false, token=0, batch=null, activeProfile='', cooldown={};
    var now=o.now || Date.now, later=o.setTimeout || root.setTimeout, clear=o.clearTimeout || root.clearTimeout;
    function key(e){return String(o.profile())+'|'+(e.card.source || 'tmdb')+':'+e.card.id;}
    function schedule(ms){if(disposed)return;if(timer!==null)clear(timer);timer=later(tick,ms);}
    function stop(){
      token++;batch=null;running=false;activeProfile='';
      o.cancel();schedule(60000);
    }
    function tick(){
      timer=null;if(disposed)return;
      try{
        if(running){
          if(String(o.profile())!==activeProfile || !o.allowed()){stop();return;}
          schedule(1000);return;
        }
        if(!o.allowed() || o.busy()){schedule(60000);return;}
        if(!batch && !o.enabled()){schedule(60000);return;}
        var profile=String(o.profile());
        if(batch && (batch.profile!==profile || now()>=batch.deadline))batch=null;
        if(!batch && !o.enabled()){schedule(60000);return;}
        var entries=o.list().sort(function(a,b){return (a.checkedAt||0)-(b.checkedAt||0);});
        var entry=null;
        for(var i=0;i<entries.length;i++){
          var e=entries[i], k=key(e);
          if(cooldown[k] && cooldown[k]>now())continue;
          if(batch){if(batch.done[k])continue;}
          else {
            var interval=e.lastComplete?21600000:1800000;
            if(e.checkedAt && now()>=e.checkedAt && now()-e.checkedAt<interval)continue;
          }
          entry=e;break;
        }
        if(!entry){batch=null;schedule(60000);return;}
        var run=++token, entryKey=key(entry);running=true;activeProfile=profile;
        if(batch)batch.done[entryKey]=true;
        cooldown[entryKey]=now()+1800000;
        schedule(1000);
        o.scan(entry,function(result){
          if(disposed || run!==token)return;
          running=false;activeProfile='';
          if(String(o.profile())===profile && result.status!=='cancelled' && result.status!=='profile_changed'){
            try{o.save(entry,result);}catch(ignore){if(o.error)o.error();}
          }
          schedule(batch?1000:60000);
        });
      }catch(ignore){running=false;batch=null;if(o.error)o.error();schedule(60000);}
    }
    function refresh(){stop();cooldown={};batch={profile:String(o.profile()),deadline:now()+300000,done:{}};schedule(0);}
    function dispose(){disposed=true;token++;batch=null;running=false;if(timer!==null)clear(timer);timer=null;o.cancel();}
    schedule(15000);
    return {refresh:refresh,stop:stop,dispose:dispose,busy:function(){return running;},pending:function(){return !!batch;}};
  }
  var api={create:create};if(typeof module==='object' && module.exports)module.exports=api;else root.LampaNewEpisodesScheduler=api;
})(typeof window==='object'?window:this);

/* New Episodes 1.0.0: manual one-series WTCH probe inside Lampa. */
(function () {
  'use strict';
  var VERSION = '1.0.0';
  var SLOT = '__newEpisodesTracking';
  var ID = 'new_episodes_tracking_v10';
  if (window[SLOT]) { window[SLOT].retry(); return; }
  var state = 'waiting';
  var timer = null;
  var attempts = 0;
  var selected = null;
  var sourceChoice = 'auto';
  var selectedProfile = '';
  var inventory = null;
  var lastAttempt = null;
  var client = null;
  var tracking = null;
  var trackingError = '';
  var rowAdded = false;
  var registeredRows={};
  var scheduler=null, backgroundClient=null, adding=false;
  var PREF='lampa_new_episodes_preferences_v1';
  function autoEnabled(){try{return window.localStorage.getItem(PREF)!=='off';}catch(ignore){return false;}}
  function allowed(){
    if(document.hidden || (!window.wtch_runtime_loaded && !window.wtch_plugin))return false;
    try{if(method(host().Player,'opened') && host().Player.opened())return false;}catch(ignore){return false;}
    return !/^player/.test(controller());
  }
  function cancelAll(){adding=false;serial++;if(scheduler)scheduler.stop();if(client)client.cancel();}
  function addSeries(){adding=true;choose();}
  function refreshAll(){if(client && client.busy()){notify('Дождитесь текущей проверки или отмените её.');return;}scheduler.refresh();notify('Подписки будут обновлены по очереди. Во время просмотра очередь приостановлена.');}
  function toggleAuto(){
    try{var enabled=!autoEnabled();window.localStorage.setItem(PREF,enabled?'on':'off');if(!enabled && scheduler)scheduler.stop();notify(enabled?'Фоновое обновление включено.':'Фоновое обновление выключено.');}
    catch(ignore){recordFailure({message:'tracking_write_failed'});}
  }
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
    notify('Не удалось открыть окно. Отчёт доступен через LampaNewEpisodesTracking.report().');
  }
  function choose() {
    checkProfile(); var L=host(); var back=controller(); var list=[];
    try {
      if (method(L.Favorite,'get')) list=L.Favorite.get({type:'history'});
      else if(method(L.Favorite,'all')) list=L.Favorite.all().history;
      if(!Array.isArray(list)) throw new Error('format');
      list=list.filter(function(c){return c && c.name && (c.first_air_date || c.number_of_seasons || c.media_type==='tv');});
    } catch (ignore) { adding=false;show('История','Не удалось прочитать историю сериалов.'); return; }
    if(!list.length){adding=false;show('История','Сериалы не найдены. Откройте сериал обычным способом и повторите выбор.');return;}
    if(!method(L.Select,'show') || typeof window.$!=='function'){show('Выбор','API выбора недоступно.');return;}
    L.Select.show({title:adding?'Добавить сериал в отслеживание':'Выбрать сериал',items:list.map(function(card,i){
      var html=window.$('<div class="selectbox-item selector"><div class="selectbox-item__title"></div></div>');
      html.find('.selectbox-item__title').text(card.name || 'Сериал '+(i+1));
      return {title:'Сериал '+(i+1),html:html,card:card};
    }),onBack:function(){adding=false;restore(back);},onSelect:function(item){
      if(scheduler)scheduler.stop();
      serial++; if(client)client.cancel();
      // Copy so downstream readers never mutate Favorite's card object.
      selected={}; Object.keys(item.card).forEach(function(k){if(typeof item.card[k]==='string' || typeof item.card[k]==='number')selected[k]=item.card[k];});
      selectedProfile=profile(); inventory=null;lastAttempt=null;restore(back);
      try{var entry=tracking.get(selected);if(entry)sourceChoice=entry.scope;}catch(ignore){}
      if(adding)scan();else notify('Сериал выбран. Запустите проверку в дополнительных действиях.');
    }});
  }
  function chooseSource() {
    adding=false;
    var L=host();var back=controller();
    if(!method(L.Select,'show')){show('Источник','API выбора недоступно.');return;}
    L.Select.show({title:'Источник проверки',items:[{title:'Автоматически: Filmix, Rezka, Kodik в приоритете',value:'auto'},
      {title:'Только Filmix',value:'filmix'},{title:'Только Rezka',value:'rezka'},{title:'Только Kodik',value:'kodik'}],
      onBack:function(){restore(back);},onSelect:function(item){
        serial++;if(client)client.cancel();sourceChoice=item.value;inventory=null;lastAttempt=null;restore(back);
        notify('Источник выбран. Запустите проверку.');
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
    selected_source_unavailable:'Выбранный источник не найден среди доступных',
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
  function trackedViews() {
    if(!tracking)return [];
    return tracking.list().map(function(entry){return tracking.view(entry,function(card,s,e){return window.LampaNewEpisodesWtchAdapter.progress(host(),card,s,e);});});
  }
  function recordFailure(error) {
    var allowed=['tracking_read_failed','tracking_write_failed','tracking_corrupt','tracking_schema','tracking_profile_unknown','tracking_identity',
      'tracking_scope_mismatch','tracking_limit','tracking_episode_limit','tracking_not_subscribed','tracking_episode_missing','tracking_no_result'];
    trackingError=error && allowed.indexOf(error.message)!==-1?error.message:'tracking_failed';
    notify('Не удалось сохранить учёт. Откройте отчёт.');
  }
  function subscribe() {
    checkProfile();
    if(!selected || !inventory || !inventory.episodes.length){show('Отслеживание','Сначала выберите сериал и получите список его эпизодов.');return;}
    try{
      var entry=tracking.update(selected,inventory,sourceChoice,true);trackingError='';
      show('Отслеживание сохранено',entry.baselineReady?
        'Подписка сохранена. Текущие эпизоды — исходный список. Последующие находки будут показаны отдельно. Обновление выполняется при открытой Lampa, если включён фон.':
        'Подписка сохранена по неполному ответу. Найденные эпизоды доступны в учёте. Последующие находки могут быть давно вышедшими сериями: время обнаружения не равно дате выхода.');
    }catch(error){recordFailure(error);}
  }
  function chooseTracked() {
    adding=false;
    checkProfile();var views;
    try{views=trackedViews();}catch(error){recordFailure(error);return;}
    if(!views.length){show('Отслеживаемые сериалы','Список пуст. Сначала проверьте сериал и сохраните его для отслеживания.');return;}
    var L=host();var back=controller();
    L.Select.show({title:'Отслеживаемые сериалы',items:views.map(function(v,i){
      var html=window.$('<div class="selectbox-item selector"><div class="selectbox-item__title"></div><div class="selectbox-item__subtitle"></div></div>');
      html.find('.selectbox-item__title').text(v.card.name || v.card.title || 'Сериал '+(i+1));
      html.find('.selectbox-item__subtitle').text('Найдено после подписки: '+v.counts.discovered+'; осталось: '+(v.counts.backlog+v.counts.newAvailable)+'; сверка: '+v.counts.unknown+
        (v.lastComplete?'':' · неполная проверка')+(v.counts.stale?' · есть прежние данные':''));
      return {title:'Сериал '+(i+1),html:html,card:v.card,scope:v.scope};
    }),onBack:function(){restore(back);},onSelect:function(item){
      serial++;if(client)client.cancel();selected=item.card;selectedProfile=profile();sourceChoice=item.scope;inventory=null;lastAttempt=null;
      restore(back);notify('Отслеживаемый сериал выбран. Можно обновить источники или открыть сохранённый учёт.');
    }});
  }
  function trustZero() {
    checkProfile();
    if(!selected || !tracking.get(selected)){show('Сверка прогресса','Сначала сохраните выбранный сериал для отслеживания.');return;}
    var L=host();var back=controller();
    L.Select.show({title:'Нулевой прогресс выбранного сериала',items:[
      {title:'Ноль означает «не смотрел» — я сверил этот сериал',value:true},
      {title:'Ноль неизвестен — нужна ручная сверка',value:false}],onBack:function(){restore(back);},onSelect:function(item){
      try{tracking.trustZero(selected,item.value);trackingError='';restore(back);notify('Правило сохранено только для этого сериала.');}
      catch(error){restore(back);recordFailure(error);}
    }});
  }
  function trackedEpisodes() {
    checkProfile();var entry;
    try{entry=selected && tracking.get(selected);}catch(error){recordFailure(error);return;}
    if(!entry){show('Учёт эпизодов','Сначала выберите сохранённый сериал.');return;}
    var view=tracking.view(entry,function(card,s,e){return window.LampaNewEpisodesWtchAdapter.progress(host(),card,s,e);});
    var L=host();var back=controller();
    var texts={completed:'просмотрено',in_progress:'в процессе',unwatched:'не просмотрено',unknown:'нужна сверка'};
    L.Select.show({title:'Учёт доступных эпизодов',items:view.episodes.map(function(e){return {
      title:'S'+e.season+' E'+e.episode+' — '+texts[e.status],
      subtitle:(e.discovered?'Впервые найден после подписки':'Исходный список')+(e.stale?' · прежние данные':''),episode:e};}),
      onBack:function(){restore(back);},onSelect:function(item){
        var e=item.episode;
        L.Select.show({title:'S'+e.season+' E'+e.episode,items:[
          {title:'Отметить непросмотренной в нашем учёте',value:'unwatched'},
          {title:'Отметить просмотренной в нашем учёте',value:'completed'},
          {title:'Убрать нашу ручную отметку',value:null}],onBack:function(){restore(back);},onSelect:function(action){
            try{tracking.mark(selected,e,action.value);trackingError='';restore(back);notify('Изменён только учёт «Новых серий». История Lampa не менялась.');}
            catch(error){restore(back);recordFailure(error);}
          }});
      }});
  }
  function forget() {
    adding=false;
    checkProfile();if(!selected){notify('Сначала выберите сериал.');return;}
    try{tracking.remove(selected);trackingError='';notify('Сериал убран из нашего отслеживания. История сохранена.');}catch(error){recordFailure(error);}
  }
  function addTrackingRow() {
    var L=host();
    if(rowAdded || !method(L.ContentRows,'add'))return;
    var rows=[
      {name:'found',title:'Найдено после подписки',include:function(v){return v.counts.discovered>0;}},
      {name:'remaining',title:'Осталось посмотреть — по данным источников',include:function(v){return v.counts.backlog+v.counts.newAvailable>0;}},
      {name:'unknown',title:'Серии есть — прогресс требует сверки',include:function(v){return v.counts.unknown>0;}}
    ];
    rows.forEach(function(row,index){
      if(registeredRows[row.name])return;
      L.ContentRows.add({name:'new_episodes_'+row.name+'_v10',title:row.title,index:2+index,screen:['main'],call:function(){
        var cards=[];
        try{cards=trackedViews().filter(row.include).map(function(v){return v.card;});}catch(ignore){return;}
        if(!cards.length)return;
        return function(callback){callback({results:cards,title:row.title});};
      }});
      registeredRows[row.name]=true;
    });
    rowAdded=true;
  }
  function advanced(){
    var back=controller();
    host().Select.show({title:'Дополнительные действия',items:actions.map(function(a){return {title:a[1],subtitle:a[2],value:a[0],action:a[3]};}),
      onBack:function(){restore(back);},onSelect:function(item){restore(back);try{item.action();}catch(ignore){notify('Действие недоступно. Откройте отчёт.');}}});
  }
  function report() {
    checkProfile();
    var lines=['Новые серии '+VERSION+' — отслеживание подписок','Запуск: '+state,
      'WTCH загружен: '+(window.wtch_runtime_loaded || window.wtch_plugin ? 'да' : 'не подтверждено'),
      'Строка главной: '+(rowAdded?'добавлена':'недоступна'),'Сериал: '+(selected?'выбран':'не выбран'),'Режим источника: '+sourceChoice,'Проверка выполняется: '+(client && client.busy()?'да':'нет')];
    var L=host(), missing=[];
    if(!method(L.Reguest && L.Reguest.prototype,'native') && typeof L.Reguest!=='function')missing.push('Reguest');
    if(!method(L.Timeline,'view'))missing.push('Timeline.view');
    if(!method(L.Utils,'hash'))missing.push('Utils.hash');
    if(!method(L.Select,'show'))missing.push('Select.show');
    if(typeof window.$!=='function')missing.push('jQuery');
    try{var url=new window.URL('/lite/test','https://wtch.ch');if(!url.searchParams || typeof url.searchParams.set!=='function')missing.push('URL.searchParams');}catch(ignore){missing.push('URL');}
    try{var template=document.createElement('template');if(!template.content || !template.content.querySelectorAll)missing.push('template');}catch(ignore){missing.push('template');}
    lines.push('Совместимость API: '+(missing.length?'не хватает '+missing.join(', '):'основные API найдены'));
    if(lastAttempt){
      lines.push('Последняя попытка: '+label(lastAttempt.status),'Запросов: '+lastAttempt.requests,'Источников: '+lastAttempt.sources.length,
        'Полный обход в пределах проверки: '+(lastAttempt.coverageComplete?'да':'нет'));
      lastAttempt.issues.forEach(function(code){lines.push('Ограничение: '+label(code));});
      var stages={ids:'Внешние ID',discovery:'Список источников',page:'Страница серий/сезонов'};
      var reasons={no_response:'нет доступного HTTP-ответа',http_error:'ошибка HTTP',timeout:'таймаут',parsererror:'ошибка формата транспорта',abort:'прервано',transport_error:'ошибка транспорта'};
      (lastAttempt.diagnostics || []).forEach(function(d,i){
        lines.push('Запрос '+(i+1)+': '+(stages[d.stage] || 'Страница')+(d.source?' / '+d.source:'')+' — '+
          (d.outcome==='ok'?'ответ получен'+(d.format?' ('+d.format+')':''):label(d.outcome))+
          (d.scheme?' / '+d.scheme.toUpperCase():'')+(d.http!==null?' / HTTP '+d.http:'')+(d.reason?' / '+(reasons[d.reason]||'неуточнено'):''));
      });
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
      'Найдено после подписки — время обнаружения, а не подтверждённая дата выхода.',
      'Названия, ID, URL, токены и аккаунты в отчёт не включаются.');
    if(trackingError)lines.push('Ошибка учёта: '+trackingError);
    try{
      var views=trackedViews();var total={fresh:0,backlog:0,unknown:0,discovered:0};
      views.forEach(function(v){total.fresh+=v.counts.newAvailable;total.backlog+=v.counts.backlog;total.unknown+=v.counts.unknown;total.discovered+=v.counts.discovered;});
      lines.push('Отслеживаемых сериалов: '+views.length,'Найдено после подписки (включая неизвестный прогресс): '+total.discovered,'Новых доступных эпизодов в учёте: '+total.fresh,
        'Прежних непросмотренных эпизодов: '+total.backlog,'Прогресс для сверки: '+total.unknown,'Фоновое обновление: '+(autoEnabled()?'включено':'выключено'), 'Фоновая проверка: '+(scheduler && scheduler.busy()?'выполняется':'ожидание'));
    }catch(error){lines.push('Учёт недоступен: ошибка чтения или формата.');}
    return lines.join('\n');
  }
  function episodes() {
    checkProfile();
    if(!inventory){
      var message=!selected?'Сначала выберите сериал из истории.':client && client.busy()?'Проверка ещё выполняется. Дождитесь завершения или отмените её.':
        lastAttempt?'Сериал выбран, но проверка не получила список эпизодов. Повторно выбирать сериал не требуется.\nПоследняя попытка: '+label(lastAttempt.status)+
          '\nОткройте обезличенный отчёт: в нём указаны этапы запросов и коды ошибок.':'Сериал выбран. Нажмите «Проверить источники WTCH».';
      show('Серии WTCH',message);return;
    }
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
    if(scheduler)scheduler.stop();
    var run=++serial;
    notify('Проверка WTCH началась: до 30 запросов, максимум 90 секунд. Можно отменить в настройках.');
    client.scan(selected,function(result){
      if(run!==serial)return;
      checkProfile();if(!selected || run!==serial)return;
      lastAttempt=result;
      if(result.status!=='cancelled' && result.status!=='profile_changed' && (result.episodes.length || result.coverageComplete)){
        result.savedAt=Date.now();inventory=result;
      }
      if(tracking && result.status!=='cancelled' && result.status!=='profile_changed'){
        try{if(tracking.get(selected)){tracking.update(selected,result,sourceChoice,false);trackingError='';}}catch(error){recordFailure(error);}
      }
      if(adding){adding=false;if(inventory && inventory.episodes.length)subscribe();else show('Сериал пока не добавлен','Источник не вернул эпизоды. В дополнительных действиях можно выбрать Kodik и повторить проверку, затем сохранить подписку. Подробности — в отчёте.');}
      else notify('WTCH: '+label(result.status)+'. Данные обновлены; список на главной изменится при её следующем открытии.');
    });
  }
  var actions=[
    ['choose','Выбрать сериал из истории','Выбрать сериал для дополнительных действий.',choose],
    ['source','Выбрать источник проверки','Автоматически или отдельно Filmix, Rezka, Kodik.',chooseSource],
    ['scan','Проверить источники WTCH','Отправит запросы установленному сервису с его текущими параметрами доступа. До 3 источников, 30 запросов и 90 секунд.',scan],
    ['cancel','Отменить проверку','Остановить очередь и игнорировать запоздавшие ответы.',cancelAll],
    ['episodes','Посмотреть найденные эпизоды','Список источников и степень просмотра; неизвестный прогресс требует сверки.',episodes],
    ['subscribe','Сохранить сериал для отслеживания','Запомнить исходный список. Уже вышедшие непросмотренные серии учитываются отдельно.',subscribe],
    ['tracked','Выбрать отслеживаемый сериал','Сохранённые сериалы и счётчики; после выбора можно обновить его источники.',chooseTracked],
    ['zero','Сверить нулевой прогресс этого сериала','Разрешить считать ноль непросмотренной серией только после вашей сверки.',trustZero],
    ['ledger','Открыть учёт эпизодов','Прежние и новые эпизоды; ручные отметки в собственном учёте.',trackedEpisodes],
    ['forget','Убрать сериал из отслеживания','Удалить только нашу подписку. История Lampa не меняется.',forget],
    ['report','Показать обезличенный отчёт','Статусы, счётчики и ограничения последней попытки.',function(){show('Отчёт WTCH',report());}]
  ];
  var buttons=[
    ['add','Добавить сериал из истории','Выберите сериал: проверка источников и сохранение подписки выполнятся автоматически.',addSeries],
    ['tracked','Мои сериалы','Счётчики, состояние проверки и выбор сериала.',chooseTracked],
    ['refresh','Обновить подписки','Последовательная очередь до 5 минут; её можно отменить в дополнительных действиях.',refreshAll],
    ['ledger','Эпизоды выбранного сериала','Сохранённые эпизоды и собственные отметки просмотра.',trackedEpisodes],
    ['auto','Включить / выключить фоновое обновление','Обычно раз в 6 часов; повтор неполной проверки не чаще 30 минут. Только при открытой Lampa.',toggleAuto],
    ['advanced','Дополнительные действия','Источник, ручная проверка, нулевой прогресс, отмена и удаление подписки.',advanced],
    ['report','Состояние и обезличенный отчёт','Версия, фон, результаты и ограничения.',function(){show('Новые серии — состояние',report());}]
  ];
  function start() {
    if(state==='ready')return true;
    attempts++;var L=host();
    if(!method(L.SettingsApi,'addComponent') || !method(L.SettingsApi,'addParam'))return false;
    try {
      if(!componentAdded){L.SettingsApi.addComponent({component:ID,name:'Новые серии 1.0',icon:'<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M4 4h16v16H4zM9 8v8l7-4z"/></svg>'});componentAdded=true;}
      if(method(L.SettingsApi,'removeParams')){L.SettingsApi.removeParams(ID);added={};}
      buttons.forEach(function(b){if(!added[b[0]]){L.SettingsApi.addParam({component:ID,param:{name:'ne_track10_'+b[0],type:'button'},field:{name:b[1],description:b[2]},onChange:function(){try{b[3]();}catch(ignore){notify('Не удалось выполнить действие. Откройте отчёт или перезапустите Lampa.');}}});added[b[0]]=true;}});
      tracking=window.LampaNewEpisodesTrackingStore.create({storage:{getItem:function(k){return window.localStorage.getItem(k);},setItem:function(k,v){window.localStorage.setItem(k,v);}},profile:profile});
      addTrackingRow();
      client=window.LampaNewEpisodesWtchClient.create({Lampa:L,adapter:window.LampaNewEpisodesWtchAdapter,document:document,profile:profile,source:function(){return sourceChoice;}});
      if(!scheduler)scheduler=window.LampaNewEpisodesScheduler.create({profile:profile,list:function(){return tracking.list();},
        enabled:autoEnabled,allowed:allowed,busy:function(){return client && client.busy();},
        scan:function(entry,done){
          backgroundClient=window.LampaNewEpisodesWtchClient.create({Lampa:host(),adapter:window.LampaNewEpisodesWtchAdapter,document:document,profile:profile,source:entry.scope});
          backgroundClient.scan(entry.card,done);
        },cancel:function(){if(backgroundClient)backgroundClient.cancel();},
        save:function(entry,result){if(tracking.get(entry.card))tracking.update(entry.card,result,entry.scope,false);},
        error:function(){trackingError='tracking_background_failed';}});
      state='ready';return true;
    }catch(ignore){state='error';return false;}
  }
  function tick(){timer=null;if(start())return;if(attempts<60)timer=window.setTimeout(tick,500);else state='timeout';}
  function retry(){if(state==='ready'||timer!==null)return;attempts=0;tick();}
  var api={version:VERSION,report:report,retry:retry,cancel:cancelAll};
  window[SLOT]=api;window.LampaNewEpisodesTracking=api;tick();
})();
