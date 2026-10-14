/* Lampa New Episodes v0.3 - minimal loader test. No history access. */
(function () {
  'use strict';
  try {
    var L = window.Lampa;
    if (L && L.Noty && typeof L.Noty.show === 'function') {
      L.Noty.show('New Episodes v0.3: JavaScript executed');
    }
  } catch (e) {
    /* Never modify application state. */
  }
})();
