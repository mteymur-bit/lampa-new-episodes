
/* Lampa New Episodes v0.5 - read-only diagnostics */
(function () {
  'use strict';
  if (window.lampa_new_episodes_v05_loaded) return;
  window.lampa_new_episodes_v05_loaded = true;

  function init() {
    var L = window.Lampa;
    if (!L || !L.SettingsApi || typeof L.SettingsApi.addComponent !== 'function' || typeof L.SettingsApi.addParam !== 'function') return;
    var ID = 'new_episodes_diagnostics';
    function available(name) { return !!L[name]; }
    function inspect() {
      var lines = [
        'Новые серии v0.5 — диагностика',
        'Favorite: ' + available('Favorite'),
        'Favorite.all: ' + !!(L.Favorite && typeof L.Favorite.all === 'function'),
        'Timeline: ' + available('Timeline'),
        'Timeline.all: ' + !!(L.Timeline && typeof L.Timeline.all === 'function'),
        'Notices: ' + available('Notices'),
        'Storage: ' + available('Storage')
      ];
      var result = lines.join('\n');
      console.log('[NewEpisodes]', result);
      try {
        if (L.Modal && typeof L.Modal.open === 'function' && window.$) {
          var html = $('<div style="padding:1em;white-space:pre-line;line-height:1.6"></div>').text(result);
          L.Modal.open({
            title: 'Новые серии — диагностика',
            html: html,
            size: 'medium',
            onBack: function () {
              L.Modal.close();
              if (L.Controller && L.Controller.toggle) L.Controller.toggle('settings_component');
            }
          });
          return result;
        }
      } catch (e) { console.warn('[NewEpisodes] Modal:', e); }
      if (L.Noty && L.Noty.show) L.Noty.show(result.replace(/\n/g, ' | '));
      return result;
    }
    window.LampaNewEpisodes = {version: '0.5', report: inspect};
    try {
      L.SettingsApi.addComponent({component: ID, name: 'Новые серии', icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 8 6 4-6 4z"/></svg>'});
      L.SettingsApi.addParam({
        component: ID,
        param: {name: 'new_episodes_check_v05', type: 'button'},
        field: {name: 'Проверить API истории', description: 'Только проверка наличия API. Данные просмотров не читаются и не изменяются.'},
        onChange: inspect
      });
      if (L.Noty && L.Noty.show) L.Noty.show('Новые серии v0.5: настройки добавлены');
    } catch (e) { console.error('[NewEpisodes] init:', e); }
  }
  if (window.Lampa && window.Lampa.SettingsApi && window.appready) init();
  else if (window.Lampa && window.Lampa.Listener && typeof window.Lampa.Listener.follow === 'function') {
    window.Lampa.Listener.follow('app', function (e) { if (e && e.type === 'ready') init(); });
  } else init();
})();
