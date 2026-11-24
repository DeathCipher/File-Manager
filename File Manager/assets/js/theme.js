(function(){
  var KEY = 'fm-theme';

  function systemPrefersLight(){
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  }

  function readStored(){
    try { return localStorage.getItem(KEY); } catch(e){ return null; }
  }

  function resolveInitial(){
    var stored = readStored();
    if(stored === 'light' || stored === 'dark') return stored;
    return systemPrefersLight() ? 'light' : 'dark';
  }

  document.documentElement.setAttribute('data-theme', resolveInitial());

  function setTheme(theme){
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(KEY, theme); } catch(e){}
    try { window.dispatchEvent(new CustomEvent('fm-theme-change', { detail: theme })); } catch(e){}
  }

  window.FMTheme = {
    get: function(){ return document.documentElement.getAttribute('data-theme'); },
    set: setTheme,
    toggle: function(){
      var next = this.get() === 'light' ? 'dark' : 'light';
      setTheme(next);
      return next;
    }
  };

  window.addEventListener('storage', function(e){
    if(e.key === KEY && (e.newValue === 'light' || e.newValue === 'dark')){
      document.documentElement.setAttribute('data-theme', e.newValue);
      try { window.dispatchEvent(new CustomEvent('fm-theme-change', { detail: e.newValue })); } catch(err){}
    }
  });
})();
