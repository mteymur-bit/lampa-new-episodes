
/* Lampa New Episodes v0.4 - read-only API diagnostics */
(function () {
  'use strict';
  var L = window.Lampa;
  if (!L) return;
  function has(o, k) {
    return !!o && typeof o[k] !== 'undefined';
  }
  function report() {
    var lines = [
      'New Episodes v0.4 (read-only)',
      'Favorite: ' + has(L, 'Favorite'),
      'Favorite.all: ' + (has(L, 'Favorite') && typeof L.Favorite.all === 'function'),
      'Timeline: ' + has(L, 'Timeline'),
      'Timeline.all: ' + (has(L, 'Timeline') && typeof L.Timeline.all === 'function'),
      'Notices: ' + has(L, 'Notices'),
      'Storage: ' + has(L, 'Storage'),
      'Listener: ' + has(L, 'Listener')
    ];
    var message = lines.join('\n');
    try { console.log('[NewEpisodes]', message); } catch (e) {}
    try {
      if (L.Noty && typeof L.Noty.show === 'function')
        L.Noty.show('New Episodes v0.4: API checked');
    } catch (e) {}
    return message;
  }
  window.LampaNewEpisodes = { version: '0.4', report: report };
  report();
})();
  
