'use strict';
// Apply the device preference before styles paint; no account data is stored here.
(() => {
  const key = 'paipaiji-font-size';
  const choices = ['standard', 'large', 'xlarge'];
  let current = 'standard';
  const normalize = value => choices.includes(value) ? value : 'standard';
  const apply = value => {
    current = normalize(value);
    document.documentElement.dataset.fontSize = current;
  };
  try { apply(localStorage.getItem(key)); } catch { apply('standard'); }
  window.AppAppearance = {
    get: () => current,
    set(value) {
      apply(value);
      try { localStorage.setItem(key, current); return true; } catch { return false; }
    },
  };
})();
