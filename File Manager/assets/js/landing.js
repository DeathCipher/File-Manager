(function(){
  var toggleBtn = document.getElementById('themeToggleBtn');
  var themeLabel = document.getElementById('themeLabel');
  var knob = toggleBtn ? toggleBtn.querySelector('.knob') : null;

  function syncSwitch(theme){
    if(!toggleBtn) return;
    var isLight = theme === 'light';
    if(themeLabel) themeLabel.textContent = isLight ? 'Light' : 'Dark';
    if(knob) knob.textContent = isLight ? '☀️' : '🌙';
  }

  syncSwitch(window.FMTheme ? window.FMTheme.get() : 'dark');

  if(toggleBtn){
    toggleBtn.addEventListener('click', function(){
      var next = window.FMTheme.toggle();
      syncSwitch(next);
    });
  }

  window.addEventListener('fm-theme-change', function(e){
    syncSwitch(e.detail);
  });

  var bootLog = document.getElementById('bootLog');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var lines = [
    { text: 'mounting file_system_access.sys', status: 'OK' },
    { text: 'loading interface modules', status: 'OK' },
    { text: 'ready — select a system to continue', status: '' }
  ];

  function renderLine(l){
    var status = l.status ? ' <span class="ok">[' + l.status + ']</span>' : '';
    return '<div class="line">&gt; ' + l.text + status + '</div>';
  }

  if(bootLog){
    if(reduceMotion){
      bootLog.innerHTML = lines.map(renderLine).join('');
    } else {
      var i = 0;
      (function next(){
        if(i >= lines.length) return;
        var div = document.createElement('div');
        div.innerHTML = renderLine(lines[i]);
        bootLog.appendChild(div.firstChild);
        i++;
        if(i < lines.length) setTimeout(next, 230);
      })();
    }
  }
})();
