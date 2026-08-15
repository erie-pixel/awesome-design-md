/* ============================================================
   Tandem — app UI
   Tabs: Home · Calendar · Log (orb) · Insights · Partner
   All user-facing strings go through I18N (js/i18n.js) so the
   Settings → Language option can switch English / 한국어 live.
   Stored data keeps canonical English keys — switching language
   never breaks previously saved logs.
   ============================================================ */

(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Canonical data keys (never translated in storage)
  const SYMPTOMS = ['Cramps','Headache','Backache','Tender breasts','Bloating','Acne','Fatigue','Nausea','Cravings','Insomnia','Dizziness','Discharge'];
  const MOODS = [['Happy','😊'],['Calm','😌'],['Energetic','⚡'],['Romantic','😍'],['Sensitive','🥺'],['Irritable','😤'],['Anxious','😰'],['Sad','😢'],['Stressed','😵‍💫'],['Meh','😐']];
  const FLOWS = ['Spotting','Light','Medium','Heavy'];
  const SEX = ['None','Protected','Unprotected','High drive'];

  const PHASE_EMOJI = { menstrual: '🌹', follicular: '🌱', fertile: '🌿', ovulation: '🌕', luteal: '🌗', pms: '🌧️' };

  const ICONS = {
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
    lock: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>',
    spark: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2l2.2 6.6L21 11l-6.8 2.4L12 20l-2.2-6.6L3 11l6.8-2.4z"/></svg>',
  };

  let D; // store data ref
  let activeTab = 'home';
  let calCursor = new Date(); calCursor.setDate(1);
  let logDate = Cycle.todayISO();

  // ---------------- utilities ----------------
  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  function openSheet(id) { $('#' + id).classList.add('open'); }
  function closeSheet(id) { $('#' + id).classList.remove('open'); }
  function closeAllSheets() { $$('.scrim.open').forEach(s => s.classList.remove('open')); }

  function fmtDate(iso, opts) {
    return Cycle.parse(iso).toLocaleDateString(I18N.locale(), opts || { month: 'short', day: 'numeric' });
  }

  function premiumGate(inner, title) {
    if (D.premium) return inner;
    return `<div class="locked">
      <div class="lock-scrim">
        <span class="badge badge-plus">${ICONS.spark} Tandem Plus</span>
        <div class="t">${esc(title)}</div>
        <button class="btn btn-primary btn-pill" data-action="paywall">${t('ins.unlockPlus')}</button>
      </div>
      <div aria-hidden="true" style="filter:saturate(.8);pointer-events:none;">${inner}</div>
    </div>`;
  }

  // ---------------- language ----------------
  function applyLang() {
    I18N.setLang(D.settings.lang || 'en');
    document.documentElement.lang = I18N.getLang();
    $$('.tab-bar [data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  }

  // ---------------- tab switching ----------------
  function switchTab(tab) {
    activeTab = tab;
    $$('.tab-bar button[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    $$('.panel').forEach(p => p.classList.remove('active'));
    const panel = $('#panel-' + tab);
    render(tab);
    // force re-trigger of panel entrance animation
    void panel.offsetWidth;
    panel.classList.add('active');
    if (tab === 'home') mountSprite();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function render(tab) {
    ({ home: renderHome, calendar: renderCalendar, log: renderLog, insights: renderInsights, partner: renderPartner })[tab]();
  }
  function rerender() { render(activeTab); if (activeTab === 'home') mountSprite(); }

  // ---------------- sprite ----------------
  function mountSprite() {
    const canvas = $('#womb-canvas');
    if (!canvas) return;
    WombSprite.mount(canvas);
    const cur = Cycle.current(D.periodDays, D.settings);
    WombSprite.setPhase(cur ? cur.phase : 'follicular');
  }

  // ---------------- HOME ----------------
  function renderHome() {
    const cur = Cycle.current(D.periodDays, D.settings);
    const name = D.names.tracker;
    const hour = new Date().getHours();
    const greetKey = hour < 12 ? 'greet.morning' : hour < 18 ? 'greet.afternoon' : 'greet.evening';
    const isKo = I18N.getLang() === 'ko';
    const greetLine = name
      ? (isKo ? `${t(greetKey)}, ${esc(name)} 님` : `${t(greetKey)}, ${esc(name)}`)
      : (isKo ? t(greetKey) : `${t(greetKey)}, ${t('greet.fallback')}`);

    let headline = t('home.welcome');
    let countLine = t('home.logToStart');
    if (cur) {
      headline = `${PHASE_EMOJI[cur.phase]} ${t('phase.' + cur.phase)}`;
      if (cur.phase === 'menstrual') {
        countLine = t('home.dayOfCycle', { n: cur.cycleDay });
      } else if (cur.daysToPeriod != null && cur.daysToPeriod >= 0) {
        countLine = t('home.periodIn', { d: I18N.nDays(cur.daysToPeriod), c: t('chance.' + cur.phase) });
      }
    }

    const tips = t(cur ? `tips.${cur.phase}.you` : 'tips.follicular.you');
    const tip = tips[new Date().getDate() % tips.length];

    // phase track segments across the cycle
    let track = '', trackLabels = '';
    if (cur) {
      const L = cur.cycleLen;
      const ovDay = L - D.settings.luteal;
      const segs = [];
      for (let d = 1; d <= L; d++) {
        let cls = '';
        if (d <= cur.periodLen) cls = 'fill-p';
        else if (d >= ovDay - 5 && d < ovDay) cls = 'fill-f';
        else if (d === ovDay || d === ovDay + 1) cls = 'fill-o';
        else if (d > ovDay + 1) cls = 'fill-l';
        const on = d <= cur.cycleDay && cur.cycleDay <= L;
        segs.push(`<span class="${on ? cls : ''}"></span>`);
      }
      track = `<div class="phase-track">${segs.join('')}</div>`;
      trackLabels = `<div class="phase-track-labels"><span>${t('home.day1')}</span><span>${t('home.ovDay', { n: ovDay })}</span><span>${t('home.dayL', { n: L })}</span></div>`;
    }

    $('#panel-home').innerHTML = `
      <div class="hero stagger" style="--i:0">
        <p class="eyebrow">${greetLine}</p>
        <div class="womb-stage">
          <div class="womb-halo"></div>
          <canvas id="womb-canvas" aria-label="Animated heart-shaped womb showing your current cycle phase"></canvas>
          ${cur ? `<div class="cycle-day-pill">${t('home.cycleDayN', { n: cur.cycleDay })}</div>` : ''}
        </div>
        <h1 class="phase-line">${headline}</h1>
        <p class="count-line">${countLine}</p>
        <div class="quick-row">
          <button class="btn btn-primary btn-pill" data-action="quick-period">${new Set(D.periodDays).has(Cycle.todayISO()) ? t('home.periodToday') : t('home.logPeriodToday')}</button>
          <button class="btn btn-ghost btn-pill" data-action="goto-log">${t('home.logSymptoms')}</button>
        </div>
        ${track}${trackLabels}
      </div>

      <div class="card cream stagger" style="--i:1">
        <p class="eyebrow" style="margin-bottom:6px">${t('home.todaysTip')}</p>
        <p style="font-size:15px">${esc(tip)}</p>
      </div>

      ${cur && cur.next ? `
      <div class="card stagger" style="--i:2">
        <div class="card-row">
          <div>
            <p class="eyebrow" style="margin-bottom:4px">${t('home.nextPeriod')}</p>
            <p style="font-family:var(--serif);font-size:20px">${fmtDate(cur.next.start, { weekday: 'short', month: 'long', day: 'numeric' })}</p>
            <p class="sub">${t('home.fertileRange', { a: fmtDate(cur.next.fertileStart), b: fmtDate(cur.next.fertileEnd) })}</p>
          </div>
          <button class="icon-btn" data-action="goto-calendar" aria-label="${t('tab.calendar')}">${ICONS.calendar}</button>
        </div>
      </div>` : ''}

      ${!D.premium ? `
      <div class="card voltage stagger" style="--i:3">
        <div class="card-row">
          <div>
            <p style="font-family:var(--serif);font-size:19px;margin-bottom:2px">Tandem Plus</p>
            <p class="sub">${t('home.plusSub')}</p>
          </div>
          <button class="btn btn-on-voltage btn-pill" data-action="paywall">${t('home.tryFree')}</button>
        </div>
      </div>` : `
      <div class="card dark stagger" style="--i:3">
        <div class="card-row">
          <div>
            <p style="font-family:var(--serif);font-size:18px;color:var(--amber)">${t('home.plusMember')}</p>
            <p class="sub">${t('home.plusUnlocked')}</p>
          </div>
        </div>
      </div>`}
    `;
  }

  // ---------------- CALENDAR ----------------
  function renderCalendar() {
    const y = calCursor.getFullYear(), m = calCursor.getMonth();
    const first = new Date(y, m, 1);
    const startDow = (first.getDay() + 6) % 7; // Monday-first
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const today = Cycle.todayISO();
    const set = new Set(D.periodDays);
    const monthTitle = first.toLocaleDateString(I18N.locale(), { year: 'numeric', month: 'long' });

    let cells = t('cal.dow').map(d => `<div class="cal-dow">${d}</div>`).join('');
    for (let i = 0; i < startDow; i++) cells += `<div class="cal-day dim"></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const info = Cycle.dayInfo(iso, set, D.settings);
      let cls = info.kind === 'none' ? '' : info.kind;
      if (cls === 'pms' && !D.premium) cls = ''; // PMS shading is a Plus perk
      const hasLog = D.logs[iso] && (D.logs[iso].symptoms.length || D.logs[iso].moods.length || D.logs[iso].flow);
      cells += `<button class="cal-day ${cls} ${iso === today ? 'today' : ''}" data-day="${iso}" aria-label="${iso}">
        ${d}${hasLog ? '<span style="position:absolute;bottom:4px;left:50%;transform:translateX(-50%);width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.7"></span>' : ''}
      </button>`;
    }

    $('#panel-calendar').innerHTML = `
      <div class="cal-head stagger" style="--i:0">
        <button class="icon-btn" data-action="cal-prev" aria-label="previous month"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M15 5l-7 7 7 7"/></svg></button>
        <span class="cal-title">${monthTitle}</span>
        <button class="icon-btn" data-action="cal-next" aria-label="next month"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 5l7 7-7 7"/></svg></button>
      </div>
      <div class="cal-grid stagger" style="--i:1">${cells}</div>
      <div class="legend stagger" style="--i:2">
        <span><i style="background:var(--primary)"></i>${t('cal.legend.period')}</span>
        <span><i style="background:var(--primary-soft);box-shadow:inset 0 0 0 1.5px var(--primary)"></i>${t('cal.legend.predicted')}</span>
        <span><i style="background:var(--teal-soft)"></i>${t('cal.legend.fertile')}</span>
        <span><i style="background:var(--teal)"></i>${t('cal.legend.ovulation')}</span>
        <span><i style="background:var(--amber-soft)"></i>${t('cal.legend.pms')} ${D.premium ? '' : '🔒'}</span>
      </div>
      <div class="card soft stagger mt16" style="--i:3">
        <p class="sub">${t('cal.help')}</p>
      </div>
    `;
  }

  function openDaySheet(iso) {
    const set = new Set(D.periodDays);
    const isPeriod = set.has(iso);
    $('#day-sheet-body').innerHTML = `
      <h3>${fmtDate(iso, { weekday: 'long', month: 'long', day: 'numeric' })}</h3>
      <p class="sub">${isPeriod ? t('day.marked') : t('day.notMarked')}</p>
      <button class="btn ${isPeriod ? 'btn-secondary' : 'btn-primary'} btn-block" data-action="toggle-period" data-day="${iso}">
        ${isPeriod ? t('day.remove') : t('day.mark')}
      </button>
      <button class="btn btn-ghost btn-block mt8" data-action="open-log-day" data-day="${iso}">${t('day.openLog')}</button>
    `;
    openSheet('day-sheet');
  }

  // ---------------- LOG ----------------
  function renderLog() {
    const log = Store.get().logs[logDate] || { flow: null, symptoms: [], moods: [], sex: null, water: 0, sleep: null, bbt: null, notes: '' };
    const today = Cycle.todayISO();

    // 14-day date strip ending today
    let strip = '';
    for (let i = 13; i >= 0; i--) {
      const iso = Cycle.addDays(today, -i);
      const d = Cycle.parse(iso);
      strip += `<button class="date-cell ${iso === logDate ? 'sel' : ''}" data-logdate="${iso}">
        <div class="dw">${d.toLocaleDateString(I18N.locale(), { weekday: 'short' })}</div>
        <div class="dn">${d.getDate()}</div>
      </button>`;
    }

    const chip = (group, val, on, label, extra = '') => `<button class="chip ${on ? 'on' : ''}" data-chip="${group}" data-val="${esc(val)}">${extra}${esc(label)}</button>`;

    $('#panel-log').innerHTML = `
      <h2 class="section-title stagger" style="--i:0">${t('log.title')}</h2>
      <div class="log-date-strip stagger" style="--i:0">${strip}</div>

      <div class="card stagger" style="--i:1">
        <div class="field-label">${t('log.flow')}</div>
        <div class="chip-grid">${FLOWS.map(f => chip('flow', f, log.flow === f, t('flow.' + f))).join('')}</div>

        <div class="field-label">${t('log.symptoms')}</div>
        <div class="chip-grid">${SYMPTOMS.map(s => chip('symptom', s, log.symptoms.includes(s), t('symptom.' + s))).join('')}</div>

        <div class="field-label">${t('log.mood')}</div>
        <div class="chip-grid">${MOODS.map(([m, e]) => chip('mood', m, log.moods.includes(m), t('mood.' + m), `<span class="emo">${e}</span>`)).join('')}</div>

        <div class="field-label">${t('log.sex')}</div>
        <div class="chip-grid">${SEX.map(s => chip('sex', s, log.sex === s, t('sex.' + s))).join('')}</div>
      </div>

      <div class="card stagger" style="--i:2">
        <div class="card-row">
          <div class="field-label" style="margin:0">${t('log.water')}</div>
          <div class="stepper">
            <button data-action="water" data-d="-1" aria-label="less">−</button>
            <span class="val">${t('log.glasses', { n: log.water || 0 })}</span>
            <button data-action="water" data-d="1" aria-label="more">+</button>
          </div>
        </div>
        <hr class="sep">
        <div class="card-row">
          <div class="field-label" style="margin:0">${t('log.sleep')}</div>
          <div class="stepper">
            <button data-action="sleep" data-d="-0.5" aria-label="less">−</button>
            <span class="val">${log.sleep != null ? t('log.hours', { n: log.sleep }) : '—'}</span>
            <button data-action="sleep" data-d="0.5" aria-label="more">+</button>
          </div>
        </div>
        <hr class="sep">
        <div class="card-row">
          <div class="field-label" style="margin:0">${t('log.bbt')} <span class="badge badge-plus" style="font-size:9px">${ICONS.spark} Plus</span></div>
          ${D.premium
            ? `<div class="stepper">
                <button data-action="bbt" data-d="-0.05" aria-label="less">−</button>
                <span class="val">${log.bbt != null ? log.bbt.toFixed(2) + ' °C' : '—'}</span>
                <button data-action="bbt" data-d="0.05" aria-label="more">+</button>
              </div>`
            : `<button class="btn btn-ghost btn-pill" data-action="paywall">${ICONS.lock} ${t('log.unlock')}</button>`}
        </div>
      </div>

      <div class="card stagger" style="--i:3">
        <div class="field-label" style="margin-top:0">${t('log.notes')}</div>
        <textarea class="notes" id="log-notes" placeholder="${t('log.notesPh')}">${esc(log.notes || '')}</textarea>
        <button class="btn btn-primary btn-block mt8" data-action="save-notes">${t('log.save')}</button>
      </div>
    `;
  }

  function mutateLog(fn) {
    Store.patch(d => { const l = Store.log(logDate); fn(l); void d; });
    renderLog();
  }

  // ---------------- INSIGHTS ----------------
  function renderInsights() {
    const st = Cycle.stats(D.periodDays, D.settings);
    const pred = Cycle.predictions(D.periodDays, D.settings, 3);
    const rs = st.runs;

    // bar chart of last cycles
    let bars = `<p class="sub">${t('ins.needTwo')}</p>`;
    if (st.intervals.length) {
      const max = Math.max(...st.intervals, 35);
      bars = `<div class="chart-wrap"><div class="bar-chart">` + st.intervals.map((v, i) => {
        const startIso = rs[rs.length - st.intervals.length - 1 + i]?.start || '';
        return `<div class="bar-col" style="--i:${i}">
          <span class="v">${v}</span>
          <div class="bar" style="height:${Math.round((v / max) * 82) + 8}px"></div>
          <span class="d">${startIso ? fmtDate(startIso) : ''}</span>
        </div>`;
      }).join('') + `</div></div>`;
    }

    // premium: symptom frequency
    const freq = {};
    Object.values(D.logs).forEach(l => (l.symptoms || []).forEach(s => { freq[s] = (freq[s] || 0) + 1; }));
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const maxF = top.length ? top[0][1] : 1;
    const symptomChart = top.length
      ? top.map(([s, n], i) => `<div class="freq-row" style="--i:${i}">
          <span class="name">${esc(t('symptom.' + s))}</span>
          <div class="track"><div class="fill" style="width:${Math.round((n / maxF) * 100)}%"></div></div>
          <span class="n">${n}×</span>
        </div>`).join('')
      : `<p class="sub">${t('ins.noSymptoms')}</p>`;

    const cur = Cycle.current(D.periodDays, D.settings);
    const ttc = D.settings.goal === 'ttc';

    $('#panel-insights').innerHTML = `
      <h2 class="section-title stagger" style="--i:0">${t('ins.title')}</h2>
      <div class="stat-row stagger" style="--i:0">
        <div class="stat-tile"><div class="big">${st.cycleLen}<small>${t('ins.d')}</small></div><div class="lbl">${t('ins.avgCycle')}</div></div>
        <div class="stat-tile"><div class="big">${st.periodLen}<small>${t('ins.d')}</small></div><div class="lbl">${t('ins.avgPeriod')}</div></div>
        <div class="stat-tile"><div class="big">${st.variability != null ? '±' + st.variability : '—'}${st.variability != null ? `<small>${t('ins.d')}</small>` : ''}</div><div class="lbl">${t('ins.variation')}</div></div>
      </div>

      <div class="card stagger mt16" style="--i:1">
        <p class="eyebrow" style="margin-bottom:10px">${t('ins.history')}</p>
        ${bars}
      </div>

      <div class="card stagger" style="--i:2">
        <p class="eyebrow" style="margin-bottom:8px">${t('ins.upcoming')}</p>
        ${pred.cycles.length ? pred.cycles.map(c => `
          <div class="card-row" style="padding:8px 0;border-bottom:1px solid var(--hairline-soft)">
            <span style="font-size:14px">🌹 ${fmtDate(c.start, { month: 'long', day: 'numeric' })}</span>
            <span class="sub">${t('ins.ovulationOn', { d: fmtDate(c.ovulation) })}</span>
          </div>`).join('') : `<p class="sub">${t('ins.logToUnlock')}</p>`}
      </div>

      <h2 class="section-title stagger" style="--i:3">${t('ins.patterns')} <span class="badge badge-plus">${ICONS.spark} Plus</span></h2>
      <div class="stagger" style="--i:3">
      ${premiumGate(`
        <div class="card" style="margin-bottom:10px">
          <p class="eyebrow" style="margin-bottom:8px">${t('ins.topSymptoms')}</p>
          ${symptomChart}
        </div>
        <div class="card">
          <p class="eyebrow" style="margin-bottom:8px">${ttc ? t('ins.outlookTtc') : t('ins.outlook')}</p>
          <p style="font-size:14px;line-height:1.55">
            ${cur ? t('ins.chanceToday', { c: t('chance.' + cur.phase) }) : ''}
            ${st.variability != null && st.variability <= 4 ? t('ins.regular') : t('ins.varies')}
            ${ttc ? t('ins.ttcTip') : ''}
          </p>
        </div>`, t('gate.patterns'))}
      </div>

      <h2 class="section-title stagger" style="--i:4">${t('ins.report')} <span class="badge badge-plus">${ICONS.spark} Plus</span></h2>
      <div class="card cream stagger" style="--i:4">
        <p class="sub" style="margin-bottom:12px">${t('ins.reportSub')}</p>
        <button class="btn ${D.premium ? 'btn-primary' : 'btn-ghost'} btn-block" data-action="${D.premium ? 'export-report' : 'paywall'}">
          ${D.premium ? t('ins.download') : `${ICONS.lock}&nbsp; ${t('ins.unlockPlus')}`}
        </button>
      </div>
    `;
  }

  function exportReport() {
    const st = Cycle.stats(D.periodDays, D.settings);
    const pred = Cycle.predictions(D.periodDays, D.settings, 2);
    const days = t('report.days');
    const lines = [
      t('report.title'),
      `${t('report.generated')}: ${new Date().toLocaleString(I18N.locale())}`,
      `${t('report.name')}: ${D.names.tracker || '—'}`,
      '',
      `${t('report.avgCycle')}: ${st.cycleLen} ${days}`,
      `${t('report.avgPeriod')}: ${st.periodLen} ${days}`,
      `${t('report.variability')}: ${st.variability != null ? '±' + st.variability + ' ' + days : t('report.insufficient')}`,
      '',
      t('report.periods'),
      ...st.runs.map(r => `  ${r.start} → ${r.end}  (${r.len} ${days})`),
      '',
      t('report.predictions'),
      ...pred.cycles.map(c => `  ~${c.start} (${t('ins.ovulationOn', { d: c.ovulation })}, ${c.fertileStart}–${c.fertileEnd})`),
      '',
      t('report.logs'),
      ...Object.entries(D.logs).sort().map(([iso, l]) =>
        `  ${iso}: ${[
          l.flow && `${t('report.flow')} ${t('flow.' + l.flow)}`,
          l.symptoms.length && `${t('report.symptoms')}: ${l.symptoms.map(s => t('symptom.' + s)).join(', ')}`,
          l.moods.length && `${t('report.mood')}: ${l.moods.map(m => t('mood.' + m)).join(', ')}`,
          l.bbt != null && `BBT ${l.bbt}°C`,
        ].filter(Boolean).join(' · ') || '—'}`),
    ];
    download('tandem-report.txt', lines.join('\n'), 'text/plain');
    toast(t('toast.reportDone'));
  }

  function download(name, content, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // ---------------- PARTNER ----------------
  function renderPartner() {
    const cur = Cycle.current(D.periodDays, D.settings);
    const isPartner = D.role === 'partner';
    const trackerName = esc(D.names.tracker || t('partner.yourPartner'));
    const partnerName = esc(D.names.partner || t('partner.yourPartner'));
    const emoji = cur ? PHASE_EMOJI[cur.phase] : PHASE_EMOJI.follicular;

    let body = '';

    if (!D.linked) {
      body = `
        <div class="card cream stagger" style="--i:1">
          <p style="font-family:var(--serif);font-size:20px;margin-bottom:6px">${t('partner.invite')}</p>
          <p class="sub">${t('partner.inviteSub', { name: isPartner ? trackerName : partnerName })}</p>
          <div class="code-box">${D.inviteCode || ''}</div>
          <button class="btn btn-primary btn-block" data-action="copy-code">${t('partner.copy')}</button>
          <button class="btn btn-ghost btn-block mt8" data-action="simulate-link">${t('partner.haveCode')}</button>
        </div>`;
    } else if (isPartner) {
      // PARTNER VIEW — supportive coaching
      const tips = t(cur ? `tips.${cur.phase}.partner` : 'tips.follicular.partner');
      const gestures = t('gestures');
      const gesture = gestures[new Date().getDate() % gestures.length];
      body = `
        <div class="card stagger" style="--i:1">
          <p class="eyebrow" style="margin-bottom:6px">${t('partner.rightNow', { name: trackerName })}</p>
          <p style="font-family:var(--serif);font-size:24px;letter-spacing:-.3px">${cur ? `${emoji} ${t('phase.' + cur.phase)}` : t('partner.noData')}</p>
          ${cur && cur.daysToPeriod != null && cur.daysToPeriod >= 0 && cur.phase !== 'menstrual' ? `<p class="sub mt8">${t('partner.expectedIn', { d: I18N.nDays(cur.daysToPeriod), date: fmtDate(cur.next.start, { weekday: 'long', month: 'long', day: 'numeric' }) })}</p>` : ''}
          ${cur && cur.phase === 'menstrual' ? `<p class="sub mt8">${t('partner.comfort', { n: cur.cycleDay })}</p>` : ''}
        </div>

        <div class="card cream stagger" style="--i:2">
          <p class="eyebrow" style="margin-bottom:4px">${t('partner.howTo')}</p>
          <ul class="tip-list">
            ${tips.map(([ico, tip]) => `<li><span class="ico">${ico}</span><span>${esc(tip)}</span></li>`).join('')}
          </ul>
        </div>

        <div class="stagger" style="--i:3">
        ${premiumGate(`
          <div class="card">
            <p class="eyebrow" style="margin-bottom:6px">${t('partner.gesture')}</p>
            <p style="font-family:var(--serif);font-size:18px">“${esc(gesture)}”</p>
            <p class="sub mt8">${t('partner.gestureSub')}</p>
          </div>`, t('gate.coaching'))}
        </div>`;
    } else {
      // TRACKER VIEW — what your partner sees + sharing controls
      body = `
        <div class="card stagger" style="--i:1">
          <div class="card-row">
            <div>
              <p class="eyebrow" style="margin-bottom:4px">${t('partner.linkedWith')}</p>
              <p style="font-family:var(--serif);font-size:20px">💞 ${partnerName}</p>
            </div>
            <span class="badge badge-teal">${t('partner.connected')}</span>
          </div>
          <p class="sub mt8">${t('partner.privacy', { name: partnerName })}</p>
        </div>

        <div class="card cream stagger" style="--i:2">
          <p class="eyebrow" style="margin-bottom:6px">${t('partner.seesToday', { name: partnerName })}</p>
          <p style="font-size:15px">${cur ? `${emoji} <strong>${t('phase.' + cur.phase)}</strong>${cur.daysToPeriod != null && cur.daysToPeriod >= 0 && cur.phase !== 'menstrual' ? t('partner.periodInShort', { d: I18N.nDays(cur.daysToPeriod) }) : ''}` : t('partner.nothingYet')}</p>
          <p class="sub mt8">${t('partner.previewTip')}</p>
        </div>`;
    }

    // love notes (both roles, when linked)
    const me = D.role;
    const notesHtml = D.notes.slice(-12).map(n => `
      <div class="note-bubble ${n.from === me ? 'me' : 'them'}">
        ${esc(n.text)}
        <span class="who">${n.from === 'tracker' ? esc(D.names.tracker || t('partner.tracker')) : esc(D.names.partner || t('partner.partner'))} · ${new Date(n.at).toLocaleDateString(I18N.locale(), { month: 'short', day: 'numeric' })}</span>
      </div>`).join('');

    $('#panel-partner').innerHTML = `
      <div class="role-switch stagger" style="--i:0" role="tablist">
        <button class="${!isPartner ? 'on' : ''}" data-role="tracker">🌸 ${esc(D.names.tracker || t('partner.tracker'))}</button>
        <button class="${isPartner ? 'on' : ''}" data-role="partner">💙 ${esc(D.names.partner || t('partner.partner'))}</button>
      </div>
      ${body}
      ${D.linked ? `
      <h2 class="section-title stagger" style="--i:4">${t('partner.loveNotes')}</h2>
      <div class="card stagger" style="--i:4">
        ${notesHtml || `<p class="sub">${t('partner.noNotes')}</p>`}
        <div class="note-compose">
          <input type="text" id="note-input" placeholder="${t('partner.notePh')}" maxlength="200" aria-label="love note">
          <button class="send-orb" data-action="send-note" aria-label="send">${ICONS.send}</button>
        </div>
      </div>` : ''}
    `;
  }

  // ---------------- PAYWALL ----------------
  let selectedPlan = 'yearly';
  function renderPaywall() {
    $('#paywall-body').innerHTML = `
      <h3>Tandem <span style="color:var(--primary)">Plus</span></h3>
      <p class="sub">${t('pay.sub')}</p>
      <div>
        ${t('pay.features').map(f => `<div class="feature-check"><span class="tick">✓</span><span>${esc(f)}</span></div>`).join('')}
      </div>
      <hr class="sep">
      <div class="plan-card ${selectedPlan === 'yearly' ? 'sel' : ''}" data-plan="yearly">
        <span class="radio"></span>
        <div><strong>${t('pay.yearly')}</strong><br><span class="sub">${t('pay.yearlySub')}</span></div>
        <div class="plan-price"><div class="p">$39.99</div><div class="per">${t('pay.yearlyPer')}</div></div>
      </div>
      <div class="plan-card ${selectedPlan === 'monthly' ? 'sel' : ''}" data-plan="monthly">
        <span class="radio"></span>
        <div><strong>${t('pay.monthly')}</strong><br><span class="sub">${t('pay.monthlySub')}</span></div>
        <div class="plan-price"><div class="p">$7.99</div><div class="per">${t('pay.monthlyPer')}</div></div>
      </div>
      <button class="btn btn-primary btn-block mt8" data-action="start-trial">${t('pay.cta')}</button>
      <p class="sub center mt8" style="font-size:12px">${t('pay.demo')}</p>
    `;
    openSheet('paywall');
  }

  // ---------------- SETTINGS ----------------
  function renderSettings() {
    const s = D.settings;
    $('#settings-body').innerHTML = `
      <h3>${t('set.title')}</h3>
      <div class="form-row"><label>${t('set.lang')}</label>
        <select class="text" id="set-lang">
          <option value="en" ${(s.lang || 'en') === 'en' ? 'selected' : ''}>English</option>
          <option value="ko" ${s.lang === 'ko' ? 'selected' : ''}>한국어</option>
        </select>
      </div>
      <div class="form-row"><label>${t('set.yourName')}</label><input class="text" id="set-name" value="${esc(D.names.tracker)}" placeholder="${t('set.namePh')}"></div>
      <div class="form-row"><label>${t('set.partnerName')}</label><input class="text" id="set-pname" value="${esc(D.names.partner)}" placeholder="${t('set.pnamePh')}"></div>
      <div class="form-row"><label>${t('set.goal')}</label>
        <select class="text" id="set-goal">
          <option value="track" ${s.goal === 'track' ? 'selected' : ''}>${t('set.goalTrack')}</option>
          <option value="ttc" ${s.goal === 'ttc' ? 'selected' : ''}>${t('set.goalTtc')}</option>
          <option value="avoid" ${s.goal === 'avoid' ? 'selected' : ''}>${t('set.goalAvoid')}</option>
        </select>
      </div>
      <div class="form-row"><label>${t('set.cycleLen')}</label><input class="text" id="set-cycle" type="number" min="15" max="60" value="${s.cycleLen}"></div>
      <div class="form-row"><label>${t('set.periodLen')}</label><input class="text" id="set-period" type="number" min="1" max="12" value="${s.periodLen}"></div>
      <div class="form-row"><label>${t('set.luteal')}</label><input class="text" id="set-luteal" type="number" min="9" max="17" value="${s.luteal}"></div>
      <div class="form-row"><label><input type="checkbox" id="set-reminders" ${s.reminders ? 'checked' : ''} style="width:auto;height:auto;margin-right:8px;vertical-align:-2px">${t('set.reminders')}</label></div>
      <div class="form-row"><label><input type="checkbox" id="set-motion" ${s.reduceMotion ? 'checked' : ''} style="width:auto;height:auto;margin-right:8px;vertical-align:-2px">${t('set.reduceMotion')}</label></div>
      <button class="btn btn-primary btn-block" data-action="save-settings">${t('set.save')}</button>
      <hr class="sep">
      ${window.__installPrompt ? `<button class="btn btn-ghost btn-block" style="margin-bottom:8px" data-action="install-app">${t('set.install')}</button>` : ''}
      <button class="btn btn-ghost btn-block" style="margin-bottom:8px" data-action="open-glance">${t('set.glance')}</button>
      <button class="btn btn-ghost btn-block" data-action="view-sheet">${t('set.viewSheet')}</button>
      <button class="btn btn-ghost btn-block mt8" data-action="export-json">${t('set.export')}</button>
      <button class="btn btn-ghost btn-block mt8" data-action="load-sample">${t('set.sample')}</button>
      <button class="btn btn-ghost btn-block mt8" style="color:var(--error)" data-action="erase">${t('set.erase')}</button>
      ${D.premium ? `<button class="btn btn-ghost btn-block mt8" data-action="cancel-plus">${t('set.cancelPlus')}</button>` : ''}
    `;
    openSheet('settings');
  }

  function applyMotionPref() {
    document.body.classList.toggle('reduce-motion', !!D.settings.reduceMotion);
  }

  // ---------------- micro-interactions ----------------
  const buzz = pattern => { try { navigator.vibrate && navigator.vibrate(pattern); } catch (e) { /* unsupported */ } };

  function burstHearts(x, y) {
    if (document.body.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (let i = 0; i < 10; i++) {
      const s = document.createElement('span');
      s.className = 'burst-heart';
      s.textContent = '♥';
      s.style.left = x + 'px';
      s.style.top = y + 'px';
      document.body.appendChild(s);
      const a = Math.random() * 2 - 1;
      s.animate([
        { transform: 'translate(-50%,-50%) scale(.4)', opacity: 1 },
        { transform: `translate(calc(-50% + ${a * 76}px), calc(-50% - ${58 + Math.random() * 74}px)) scale(${0.8 + Math.random() * 0.7}) rotate(${a * 42}deg)`, opacity: 0 },
      ], { duration: 700 + Math.random() * 300, easing: 'cubic-bezier(.2,.8,.2,1)' }).onfinish = () => s.remove();
    }
  }

  // ---------------- ONBOARDING ----------------
  function renderOnboarding() {
    $('#onboard-body').innerHTML = `
      <div class="center" style="padding-top:6px">
        <span class="badge badge-voltage">${t('ob.badge')}</span>
        <h3 style="margin-top:10px">${t('ob.title')}</h3>
        <p class="sub">${t('ob.sub')}</p>
      </div>
      <div class="form-row"><label>${t('set.yourName')}</label><input class="text" id="ob-name" placeholder="${t('set.namePh')}"></div>
      <div class="form-row"><label>${t('ob.partnerNameOpt')}</label><input class="text" id="ob-pname" placeholder="${t('set.pnamePh')}"></div>
      <div class="form-row"><label>${t('ob.lastPeriod')}</label><input class="text" id="ob-last" type="date" max="${Cycle.todayISO()}"></div>
      <div class="form-row"><label>${t('ob.cycleLen')}</label>
        <select class="text" id="ob-cycle">${Array.from({ length: 26 }, (_, i) => 20 + i).map(n => `<option ${n === 28 ? 'selected' : ''}>${n}</option>`).join('')}</select>
      </div>
      <button class="btn btn-primary btn-block" data-action="finish-onboarding">${t('ob.start')}</button>
      <button class="btn btn-ghost btn-block mt8" data-action="onboard-sample">${t('ob.demo')}</button>
    `;
    openSheet('onboard');
  }

  function finishOnboarding(useSample) {
    Store.patch(d => {
      d.onboarded = true;
      d.inviteCode = 'LUNA-' + Math.floor(1000 + Math.random() * 9000);
      if (!useSample) {
        d.names.tracker = $('#ob-name').value.trim();
        d.names.partner = $('#ob-pname').value.trim();
        d.settings.cycleLen = parseInt($('#ob-cycle').value, 10) || 28;
        const last = $('#ob-last').value;
        if (last) for (let k = 0; k < d.settings.periodLen; k++) d.periodDays.push(Cycle.addDays(last, k));
        d.periodDays.sort();
      }
    });
    if (useSample) {
      Store.sampleData();
      Store.patch(d => { d.names.tracker = d.names.tracker || 'Maya'; d.names.partner = d.names.partner || 'Sam'; });
    }
    D = Store.get();
    closeSheet('onboard');
    switchTab('home');
    toast(useSample ? t('toast.welcomeSample') : t('toast.allSet'));
  }

  // ---------------- global event delegation ----------------
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-tab],[data-action],[data-day],[data-logdate],[data-chip],[data-role],[data-plan]');
    if (!el) return;

    if (el.dataset.tab) { switchTab(el.dataset.tab); return; }
    if (el.dataset.logdate) { logDate = el.dataset.logdate; renderLog(); return; }
    if (el.dataset.day && !el.dataset.action) { openDaySheet(el.dataset.day); return; }
    if (el.dataset.role) { Store.patch(d => d.role = el.dataset.role); D = Store.get(); renderPartner(); return; }
    if (el.dataset.plan) { selectedPlan = el.dataset.plan; renderPaywall(); return; }

    if (el.dataset.chip) {
      buzz(8);
      const { chip, val } = el.dataset;
      mutateLog(l => {
        if (chip === 'flow') l.flow = l.flow === val ? null : val;
        else if (chip === 'sex') l.sex = l.sex === val ? null : val;
        else if (chip === 'symptom') l.symptoms = l.symptoms.includes(val) ? l.symptoms.filter(x => x !== val) : [...l.symptoms, val];
        else if (chip === 'mood') l.moods = l.moods.includes(val) ? l.moods.filter(x => x !== val) : [...l.moods, val];
      });
      return;
    }

    switch (el.dataset.action) {
      case 'open-settings': renderSettings(); break;
      case 'paywall': renderPaywall(); break;
      case 'close-sheet': closeAllSheets(); break;

      case 'quick-period': {
        const wasOff = !new Set(D.periodDays).has(Cycle.todayISO());
        const rect = el.getBoundingClientRect();
        Store.togglePeriodDay(Cycle.todayISO());
        D = Store.get();
        rerender();
        if (wasOff) { burstHearts(rect.left + rect.width / 2, rect.top + rect.height / 2); buzz([10, 30, 10]); }
        toast(wasOff ? t('toast.periodOn') : t('toast.periodOff'));
        Notify.check(D);
        break;
      }
      case 'goto-log': switchTab('log'); break;
      case 'goto-calendar': switchTab('calendar'); break;

      case 'cal-prev': calCursor.setMonth(calCursor.getMonth() - 1); renderCalendar(); break;
      case 'cal-next': calCursor.setMonth(calCursor.getMonth() + 1); renderCalendar(); break;
      case 'toggle-period': {
        Store.togglePeriodDay(el.dataset.day);
        D = Store.get();
        closeAllSheets();
        renderCalendar();
        toast(t('toast.calUpdated'));
        break;
      }
      case 'open-log-day': logDate = el.dataset.day; closeAllSheets(); switchTab('log'); break;

      case 'water': mutateLog(l => l.water = Math.max(0, (l.water || 0) + Number(el.dataset.d))); break;
      case 'sleep': mutateLog(l => l.sleep = Math.max(0, Math.round(((l.sleep == null ? 7 : l.sleep) + Number(el.dataset.d)) * 2) / 2)); break;
      case 'bbt': mutateLog(l => l.bbt = Math.round(((l.bbt == null ? 36.5 : l.bbt) + Number(el.dataset.d)) * 100) / 100); break;
      case 'save-notes': mutateLog(l => l.notes = $('#log-notes').value); toast(t('toast.saved')); break;

      case 'export-report': exportReport(); break;
      case 'export-json': download('tandem-data.json', JSON.stringify(Store.get(), null, 2), 'application/json'); toast(t('toast.exported')); break;

      case 'copy-code': {
        const code = D.inviteCode || '';
        (navigator.clipboard ? navigator.clipboard.writeText(code) : Promise.reject()).then(
          () => toast(t('toast.codeCopied')),
          () => toast(t('toast.code', { c: code }))
        );
        break;
      }
      case 'simulate-link': Store.patch(d => d.linked = true); D = Store.get(); renderPartner(); toast(t('toast.linked')); break;
      case 'send-note': {
        const input = $('#note-input');
        const text = input.value.trim();
        if (!text) break;
        Store.patch(d => d.notes.push({ from: d.role, text, at: Date.now() }));
        D = Store.get();
        renderPartner();
        toast(t('toast.noteSent'));
        break;
      }

      case 'start-trial': {
        Store.patch(d => { d.premium = true; d.trialEndsAt = Date.now() + 7 * 86400000; });
        D = Store.get();
        closeAllSheets();
        rerender();
        toast(t('toast.trial'));
        break;
      }
      case 'cancel-plus': Store.patch(d => { d.premium = false; d.trialEndsAt = null; }); D = Store.get(); closeAllSheets(); rerender(); toast(t('toast.plusOff')); break;

      case 'save-settings': {
        const wantReminders = $('#set-reminders').checked;
        Store.patch(d => {
          d.settings.lang = $('#set-lang').value;
          d.names.tracker = $('#set-name').value.trim();
          d.names.partner = $('#set-pname').value.trim();
          d.settings.goal = $('#set-goal').value;
          d.settings.cycleLen = Math.min(60, Math.max(15, parseInt($('#set-cycle').value, 10) || 28));
          d.settings.periodLen = Math.min(12, Math.max(1, parseInt($('#set-period').value, 10) || 5));
          d.settings.luteal = Math.min(17, Math.max(9, parseInt($('#set-luteal').value, 10) || 14));
          d.settings.reduceMotion = $('#set-motion').checked;
          d.settings.reminders = wantReminders;
        });
        D = Store.get();
        applyLang();
        applyMotionPref();
        closeAllSheets();
        rerender();
        if (wantReminders && Notify.supported() && Notification.permission !== 'granted') {
          Notify.enable().then(p => {
            if (p === 'granted') { toast(t('toast.remindOn')); Notify.check(D); }
            else { Store.patch(d => d.settings.reminders = false); D = Store.get(); toast(t('toast.remindDenied')); }
          });
        } else {
          toast(t('toast.settingsSaved'));
          Notify.check(D);
        }
        break;
      }
      case 'install-app': {
        const p = window.__installPrompt;
        if (p) { p.prompt(); window.__installPrompt = null; closeAllSheets(); }
        break;
      }
      case 'open-glance': location.href = 'glance.html'; break;
      case 'view-sheet': {
        const cur = Cycle.current(D.periodDays, D.settings);
        $('#sheet-view').innerHTML = `
          <h3>${t('sheet.title')}</h3>
          <p class="sub">${t('sheet.sub')}</p>
          <img alt="8x8 spritesheet" src="${WombSprite.getSheetDataURL(cur ? cur.phase : 'follicular')}">
        `;
        closeSheet('settings');
        openSheet('sheetviewer');
        break;
      }
      case 'load-sample': Store.sampleData(); Store.patch(d => { d.names.tracker = d.names.tracker || 'Maya'; d.names.partner = d.names.partner || 'Sam'; }); D = Store.get(); closeAllSheets(); rerender(); toast(t('toast.sampleLoaded')); break;
      case 'erase': {
        if (confirm(t('confirm.erase'))) {
          const lang = D.settings.lang;
          Store.reset();
          Store.patch(d => d.settings.lang = lang); // keep language across resets
          D = Store.get();
          closeAllSheets();
          renderOnboarding();
        }
        break;
      }
      case 'finish-onboarding': finishOnboarding(false); break;
      case 'onboard-sample': finishOnboarding(true); break;
    }
  });

  // close sheets when tapping the scrim itself
  $$('.scrim').forEach(s => s.addEventListener('click', e => { if (e.target === s) s.classList.remove('open'); }));

  // ---------------- boot ----------------
  function boot() {
    D = Store.load();
    if (!D.settings.lang) Store.patch(d => d.settings.lang = I18N.detect()); // first run: follow device language
    D = Store.get();
    applyLang();
    applyMotionPref();
    // generated favicon
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = WombSprite.favicon();
    document.head.appendChild(link);

    // PWA: service worker (https/localhost only; no-op for file://)
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    // PWA: capture the install prompt so Settings can offer "Install app"
    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); window.__installPrompt = e; });

    // reminders + app badge: on boot and whenever the app returns to view
    Notify.check(D);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { D = Store.get(); Notify.check(D); }
    });

    switchTab('home');
    if (!D.onboarded) renderOnboarding();
  }

  boot();
})();
