/* Панель «Доступність» для сайту «Медіа Дотичне».
   Налаштування зберігаються в браузері відвідувача. */
(function () {
  var KEY = 'dotychne.a11y';
  var OPTS = [
    ['contrast', 'Висока контрастність'],
    ['font', 'Чіткий шрифт'],
    ['spacing', 'Більші інтервали'],
    ['links', 'Підкреслити посилання'],
    ['cursor', 'Звичайний курсор'],
    ['motion', 'Зупинити анімацію']
  ];
  var root = document.documentElement;
  var state = { size: 0 };
  try { state = Object.assign(state, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) {}

  function apply() {
    root.classList.remove('a11y-size-1', 'a11y-size-2', 'a11y-size-3');
    if (state.size) root.classList.add('a11y-size-' + state.size);
    OPTS.forEach(function (o) { root.classList.toggle('a11y-' + o[0], !!state[o[0]]); });
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }
  apply(); // одразу, щоб не блимало

  function build() {
    var btn = document.createElement('button');
    btn.id = 'a11y-toggle';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Налаштування доступності');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'a11y-panel');
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="4.2" r="1.8" fill="currentColor" stroke="none"/><path d="M4.5 8.2c2.5.8 5 1.2 7.5 1.2s5-.4 7.5-1.2M12 9.4v4.8M12 14.2l-3.2 6.3M12 14.2l3.2 6.3"/></svg>';

    var p = document.createElement('div');
    p.id = 'a11y-panel';
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-modal', 'false');
    p.setAttribute('aria-labelledby', 'a11y-title');
    p.hidden = true;
    var html = '<button type="button" class="a11y-close" aria-label="Закрити">×</button>' +
      '<h2 id="a11y-title">Доступність</h2><p>Налаштуйте сайт під себе. Ми запам’ятаємо вибір у цьому браузері.</p>' +
      '<div class="a11y-row a11y-size"><span id="a11y-size-l">Розмір тексту</span><span role="group" aria-labelledby="a11y-size-l">' +
      '<button type="button" data-size="-1" aria-label="Зменшити текст">А−</button> ' +
      '<button type="button" data-size="1" aria-label="Збільшити текст">А+</button></span></div>' +
      '<div class="a11y-row" aria-live="polite" id="a11y-size-v" style="margin-top:-6px;font-size:13px"></div>';
    OPTS.forEach(function (o) {
      html += '<div class="a11y-row"><button type="button" class="a11y-opt" data-opt="' + o[0] + '" aria-pressed="false"><span>' + o[1] + '</span><span aria-hidden="true">✓</span></button></div>';
    });
    html += '<button type="button" class="a11y-reset">Скинути налаштування</button>';
    p.innerHTML = html;
    document.body.appendChild(p);
    document.body.appendChild(btn);

    function sync() {
      p.querySelectorAll('.a11y-opt').forEach(function (b) { b.setAttribute('aria-pressed', state[b.dataset.opt] ? 'true' : 'false'); });
      p.querySelector('#a11y-size-v').textContent = 'Масштаб: ' + [100, 120, 140, 160][state.size || 0] + '%';
    }
    function open(v) {
      p.hidden = !v; btn.setAttribute('aria-expanded', v ? 'true' : 'false');
      if (v) p.querySelector('.a11y-opt').focus(); else btn.focus();
    }
    btn.addEventListener('click', function () { open(p.hidden); });
    p.addEventListener('click', function (e) {
      var t = e.target.closest('button'); if (!t) return;
      if (t.classList.contains('a11y-close')) return open(false);
      if (t.dataset.size) { state.size = Math.max(0, Math.min(3, (state.size || 0) + Number(t.dataset.size))); }
      else if (t.dataset.opt) { state[t.dataset.opt] = !state[t.dataset.opt]; }
      else if (t.classList.contains('a11y-reset')) { state = { size: 0 }; }
      apply(); sync();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !p.hidden) open(false); });
    sync();
  }

  function landmarks() {
    // Позначаємо декоративні елементи, щоб їх не зачитував скрінрідер
    document.querySelectorAll('.cursor, .cursor-ring, .cursor-follower, .hero-bg-logo').forEach(function (el) { el.setAttribute('aria-hidden', 'true'); });
    document.querySelectorAll('a svg, button svg').forEach(function (s) { if (!s.hasAttribute('aria-label')) { s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false'); } });
    // Посилання, що відкриваються в новій вкладці
    document.querySelectorAll('a[target="_blank"]').forEach(function (a) {
      if (!a.querySelector('.sr-only')) { var s = document.createElement('span'); s.className = 'sr-only'; s.textContent = ' (відкриється в новій вкладці)'; a.appendChild(s); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { build(); landmarks(); });
  else { build(); landmarks(); }
})();
