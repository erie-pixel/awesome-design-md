/* ============================================================
   Tandem — app UI
   Tabs: Home · Calendar · Log (orb) · Insights · Partner
   Free tier + Premium tier modeled on top period trackers
   (calendar, predictions, symptom logging, partner sharing free;
   advanced insights, reports, TTC tools, partner coaching paid).
   ============================================================ */

(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DOW = ['Mo','Tu','We','Th','Fr','Sa','Su'];

  const SYMPTOMS = ['Cramps','Headache','Backache','Tender breasts','Bloating','Acne','Fatigue','Nausea','Cravings','Insomnia','Dizziness','Discharge'];
  const MOODS = [['Happy','😊'],['Calm','😌'],['Energetic','⚡'],['Romantic','😍'],['Sensitive','🥺'],['Irritable','😤'],['Anxious','😰'],['Sad','😢'],['Stressed','😵‍💫'],['Meh','😐']];
  const FLOWS = ['Spotting','Light','Medium','Heavy'];
  const SEX = ['None','Protected','Unprotected','High drive'];

  const PHASE_META = {
    menstrual:  { emoji: '🌹', color: 'var(--primary)' },
    follicular: { emoji: '🌱', color: 'var(--amber)' },
    fertile:    { emoji: '🌿', color: 'var(--teal)' },
    ovulation:  { emoji: '🌕', color: 'var(--teal)' },
    luteal:     { emoji: '🌗', color: 'var(--coral)' },
    pms:        { emoji: '🌧️', color: 'var(--amber)' },
  };

  const TIPS = {
    menstrual: {
      you: ['Iron-rich food (lentils, spinach, dark chocolate) helps replace what your body loses.','Gentle heat on the lower belly eases cramps better than pushing through.','Light movement — a slow walk or stretching — can genuinely reduce cramp intensity.'],
      partner: [['🛋️','Lower the logistics: handle dinner, dishes, errands without being asked.'],['🔥','A heating pad, warm drink, or warm bath offer beats "can I help?"'],['🎬','Suggest a cozy low-energy plan — this is a rest-and-recover week.'],['💬','Extra patience: energy and pain tolerance are genuinely lower right now.']],
    },
    follicular: {
      you: ['Rising estrogen = rising energy. Great week to start things.','Strength training lands especially well in this phase.','Skin is usually at its clearest — enjoy it.'],
      partner: [['🎉','Energy is climbing — this is the best week to plan dates and adventures.'],['🗓️','Book the trip, the dinner, the thing you keep postponing.'],['🏃','Invite them to be active together — it will land well.']],
    },
    fertile: {
      you: ['You are in your fertile window — conception chance is high these days.','Cervical fluid usually turns clear and stretchy around now.','Libido often peaks along with confidence — ride the wave.'],
      partner: [['💞','Desire and confidence usually peak now — prioritize time together.'],['🗣️','Deep conversations land especially well this week.'],['⚠️','If you are avoiding pregnancy: these are the highest-risk days.']],
    },
    ovulation: {
      you: ['Ovulation day — the single most fertile day of the cycle.','Some feel a one-sided twinge (mittelschmerz). Totally normal.','Body temperature rises slightly after today — BBT logging confirms it.'],
      partner: [['🌕','Peak fertility today — important whichever way you are planning.'],['✨','Confidence and mood are usually at their monthly high.'],['🥂','Great night for something celebratory.']],
    },
    luteal: {
      you: ['Progesterone rises — energy tapers. Front-load your week.','Cravings are hormonal, not a willpower failure. Plan good snacks.','Prioritize sleep; this phase is where it pays off most.'],
      partner: [['🍫','Stock the snacks they actually crave before they ask.'],['🧘','Slower plans beat big social events in this half of the cycle.'],['👂','Listen first, solve later.']],
    },
    pms: {
      you: ['PMS window — mood dips and irritability are chemistry, not character.','Cut back caffeine and salt a little; it measurably helps.','Your period is a few days away — pads/cup/painkillers ready?'],
      partner: [['🌧️','Heads-up: PMS window. Small frustrations feel bigger — do not take it personally.'],['🤗','Affection without expectations goes a very long way right now.'],['🧺','Quietly take chores off their plate.'],['🛒','Restock period supplies before day one — legendary partner move.']],
    },
  };

  const GESTURES = ['Run a bath with the good salts','Write a sticky note for the mirror','Foot massage during the next episode','Make their favorite breakfast','Handle every dish today','Fresh flowers, no occasion','Charge their phone before bed','Plan a surprise picnic'];

  const ICONS = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-6M21 20H3"/></svg>',
    hearts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7.5-4.7-9.6-9C.9 8.9 2.7 5.5 6 5.5c2 0 3.2 1 4 2.2.8-1.2 2-2.2 4-2.2 3.3 0 5.1 3.4 3.6 6.5-2.1 4.3-9.6 9-9.6 9z"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>',
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
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  function openSheet(id) { $('#' + id).classList.add('open'); }
  function closeSheet(id) { $('#' + id).classList.remove('open'); }
  function closeAllSheets() { $$('.scrim.open').forEach(s => s.classList.remove('open')); }

  function fmtDate(iso, opts) {
    return Cycle.parse(iso).toLocaleDateString(undefined, opts || { month: 'short', day: 'numeric' });
  }

  function premiumGate(inner, title) {
    if (D.premium) return inner;
    return `<div class="locked">
      <div class="lock-scrim">
        <span class="badge badge-plus">${ICONS.spark} Tandem Plus</span>
        <div class="t">${esc(title)}</div>
        <button class="btn btn-primary btn-pill" data-action="paywall">Unlock with Plus</button>
      </div>
      <div aria-hidden="true" style="filter:saturate(.8);pointer-events:none;">${inner}</div>
    </div>`;
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
    const name = D.names.tracker || 'there';
    const meta = cur ? PHASE_META[cur.phase] : PHASE_META.follicular;
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

    let headline = 'Welcome to Tandem';
    let countLine = 'Log your period to start predictions';
    if (cur) {
      headline = `${meta.emoji} ${cur.label}`;
      if (cur.phase === 'menstrual') {
        countLine = `Day <strong>${cur.cycleDay}</strong> of your cycle`;
      } else if (cur.daysToPeriod != null && cur.daysToPeriod >= 0) {
        countLine = `Period in <strong>${cur.daysToPeriod} day${cur.daysToPeriod === 1 ? '' : 's'}</strong> · pregnancy chance: <strong>${cur.chance}</strong>`;
      }
    }

    const tips = cur ? TIPS[cur.phase].you : TIPS.follicular.you;
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
      trackLabels = `<div class="phase-track-labels"><span>Day 1</span><span>Ovulation ~day ${ovDay}</span><span>Day ${L}</span></div>`;
    }

    $('#panel-home').innerHTML = `
      <div class="hero stagger" style="--i:0">
        <p class="eyebrow">${greet}, ${esc(name)}</p>
        <div class="womb-stage">
          <div class="womb-halo"></div>
          <canvas id="womb-canvas" aria-label="Animated heart-shaped womb showing your current cycle phase"></canvas>
          ${cur ? `<div class="cycle-day-pill">Cycle day ${cur.cycleDay}</div>` : ''}
        </div>
        <h1 class="phase-line">${headline}</h1>
        <p class="count-line">${countLine}</p>
        <div class="quick-row">
          <button class="btn btn-primary btn-pill" data-action="quick-period">${new Set(D.periodDays).has(Cycle.todayISO()) ? 'Period today ✓' : 'Log period today'}</button>
          <button class="btn btn-ghost btn-pill" data-action="goto-log">Log symptoms</button>
        </div>
        ${track}${trackLabels}
      </div>

      <div class="card cream stagger" style="--i:1">
        <p class="eyebrow" style="margin-bottom:6px">Today's tip</p>
        <p style="font-size:15px">${esc(tip)}</p>
      </div>

      ${cur && cur.next ? `
      <div class="card stagger" style="--i:2">
        <div class="card-row">
          <div>
            <p class="eyebrow" style="margin-bottom:4px">Next period</p>
            <p style="font-family:var(--serif);font-size:20px">${fmtDate(cur.next.start, { weekday: 'short', month: 'long', day: 'numeric' })}</p>
            <p class="sub">Fertile window ${fmtDate(cur.next.fertileStart)} – ${fmtDate(cur.next.fertileEnd)}</p>
          </div>
          <button class="icon-btn" data-action="goto-calendar" aria-label="Open calendar">${ICONS.calendar}</button>
        </div>
      </div>` : ''}

      ${!D.premium ? `
      <div class="card voltage stagger" style="--i:3">
        <div class="card-row">
          <div>
            <p style="font-family:var(--serif);font-size:19px;margin-bottom:2px">Tandem Plus</p>
            <p class="sub">Deep insights, health reports & partner coaching</p>
          </div>
          <button class="btn btn-on-voltage btn-pill" data-action="paywall">Try free</button>
        </div>
      </div>` : `
      <div class="card dark stagger" style="--i:3">
        <div class="card-row">
          <div>
            <p style="font-family:var(--serif);font-size:18px;color:var(--amber)">${'✦'} Plus member</p>
            <p class="sub">All premium features unlocked</p>
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

    let cells = DOW.map(d => `<div class="cal-dow">${d}</div>`).join('');
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
        <button class="icon-btn" data-action="cal-prev" aria-label="Previous month"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M15 5l-7 7 7 7"/></svg></button>
        <span class="cal-title">${MONTHS[m]} ${y}</span>
        <button class="icon-btn" data-action="cal-next" aria-label="Next month"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 5l7 7-7 7"/></svg></button>
      </div>
      <div class="cal-grid stagger" style="--i:1">${cells}</div>
      <div class="legend stagger" style="--i:2">
        <span><i style="background:var(--primary)"></i>Period</span>
        <span><i style="background:var(--primary-soft);box-shadow:inset 0 0 0 1.5px var(--primary)"></i>Predicted</span>
        <span><i style="background:var(--teal-soft)"></i>Fertile</span>
        <span><i style="background:var(--teal)"></i>Ovulation</span>
        <span><i style="background:var(--amber-soft)"></i>PMS ${D.premium ? '' : '🔒'}</span>
      </div>
      <div class="card soft stagger mt16" style="--i:3">
        <p class="sub">Tap any day to mark or unmark period flow, or jump to its log. Predictions update automatically from what you log.</p>
      </div>
    `;
  }

  function openDaySheet(iso) {
    const set = new Set(D.periodDays);
    const isPeriod = set.has(iso);
    $('#day-sheet-body').innerHTML = `
      <h3>${fmtDate(iso, { weekday: 'long', month: 'long', day: 'numeric' })}</h3>
      <p class="sub">${isPeriod ? 'Marked as a period day.' : 'Not marked as a period day.'}</p>
      <button class="btn ${isPeriod ? 'btn-secondary' : 'btn-primary'} btn-block" data-action="toggle-period" data-day="${iso}">
        ${isPeriod ? 'Remove period mark' : 'Mark period flow'}
      </button>
      <button class="btn btn-ghost btn-block mt8" data-action="open-log-day" data-day="${iso}">Open daily log</button>
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
        <div class="dw">${d.toLocaleDateString(undefined, { weekday: 'short' })}</div>
        <div class="dn">${d.getDate()}</div>
      </button>`;
    }

    const chip = (group, val, on, extra = '') => `<button class="chip ${on ? 'on' : ''}" data-chip="${group}" data-val="${esc(val)}">${extra}${esc(val)}</button>`;

    $('#panel-log').innerHTML = `
      <h2 class="section-title stagger" style="--i:0">Daily log</h2>
      <div class="log-date-strip stagger" style="--i:0">${strip}</div>

      <div class="card stagger" style="--i:1">
        <div class="field-label">Flow</div>
        <div class="chip-grid">${FLOWS.map(f => chip('flow', f, log.flow === f)).join('')}</div>

        <div class="field-label">Symptoms</div>
        <div class="chip-grid">${SYMPTOMS.map(s => chip('symptom', s, log.symptoms.includes(s))).join('')}</div>

        <div class="field-label">Mood</div>
        <div class="chip-grid">${MOODS.map(([m, e]) => chip('mood', m, log.moods.includes(m), `<span class="emo">${e}</span>`)).join('')}</div>

        <div class="field-label">Sex & drive</div>
        <div class="chip-grid">${SEX.map(s => chip('sex', s, log.sex === s)).join('')}</div>
      </div>

      <div class="card stagger" style="--i:2">
        <div class="card-row">
          <div class="field-label" style="margin:0">💧 Water</div>
          <div class="stepper">
            <button data-action="water" data-d="-1" aria-label="Less water">−</button>
            <span class="val">${log.water || 0} glasses</span>
            <button data-action="water" data-d="1" aria-label="More water">+</button>
          </div>
        </div>
        <hr class="sep">
        <div class="card-row">
          <div class="field-label" style="margin:0">😴 Sleep</div>
          <div class="stepper">
            <button data-action="sleep" data-d="-0.5" aria-label="Less sleep">−</button>
            <span class="val">${log.sleep != null ? log.sleep + ' h' : '—'}</span>
            <button data-action="sleep" data-d="0.5" aria-label="More sleep">+</button>
          </div>
        </div>
        <hr class="sep">
        <div class="card-row">
          <div class="field-label" style="margin:0">🌡️ Basal temp <span class="badge badge-plus" style="font-size:9px">${ICONS.spark} Plus</span></div>
          ${D.premium
            ? `<div class="stepper">
                <button data-action="bbt" data-d="-0.05" aria-label="Lower temperature">−</button>
                <span class="val">${log.bbt != null ? log.bbt.toFixed(2) + ' °C' : '—'}</span>
                <button data-action="bbt" data-d="0.05" aria-label="Higher temperature">+</button>
              </div>`
            : `<button class="btn btn-ghost btn-pill" data-action="paywall">${ICONS.lock} Unlock</button>`}
        </div>
      </div>

      <div class="card stagger" style="--i:3">
        <div class="field-label" style="margin-top:0">Notes</div>
        <textarea class="notes" id="log-notes" placeholder="Anything else about today…">${esc(log.notes || '')}</textarea>
        <button class="btn btn-primary btn-block mt8" data-action="save-notes">Save log</button>
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
    let bars = '<p class="sub">Log at least two periods to see cycle history.</p>';
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

    // premium: symptom frequency by phase
    const freq = {};
    Object.entries(D.logs).forEach(([iso, l]) => (l.symptoms || []).forEach(s => { freq[s] = (freq[s] || 0) + 1; void iso; }));
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const maxF = top.length ? top[0][1] : 1;
    const symptomChart = top.length
      ? top.map(([s, n], i) => `<div class="freq-row" style="--i:${i}">
          <span class="name">${esc(s)}</span>
          <div class="track"><div class="fill" style="width:${Math.round((n / maxF) * 100)}%"></div></div>
          <span class="n">${n}×</span>
        </div>`).join('')
      : '<p class="sub">No symptoms logged yet.</p>';

    const cur = Cycle.current(D.periodDays, D.settings);
    const ttc = D.settings.goal === 'ttc';

    $('#panel-insights').innerHTML = `
      <h2 class="section-title stagger" style="--i:0">Your cycle, in numbers</h2>
      <div class="stat-row stagger" style="--i:0">
        <div class="stat-tile"><div class="big">${st.cycleLen}<small> d</small></div><div class="lbl">Avg cycle</div></div>
        <div class="stat-tile"><div class="big">${st.periodLen}<small> d</small></div><div class="lbl">Avg period</div></div>
        <div class="stat-tile"><div class="big">${st.variability != null ? '±' + st.variability : '—'}${st.variability != null ? '<small> d</small>' : ''}</div><div class="lbl">Variation</div></div>
      </div>

      <div class="card stagger mt16" style="--i:1">
        <p class="eyebrow" style="margin-bottom:10px">Cycle length history</p>
        ${bars}
      </div>

      <div class="card stagger" style="--i:2">
        <p class="eyebrow" style="margin-bottom:8px">Upcoming predictions</p>
        ${pred.cycles.length ? pred.cycles.map(c => `
          <div class="card-row" style="padding:8px 0;border-bottom:1px solid var(--hairline-soft)">
            <span style="font-size:14px">🌹 ${fmtDate(c.start, { month: 'long', day: 'numeric' })}</span>
            <span class="sub">ovulation ${fmtDate(c.ovulation)}</span>
          </div>`).join('') : '<p class="sub">Log a period to unlock predictions.</p>'}
      </div>

      <h2 class="section-title stagger" style="--i:3">Patterns <span class="badge badge-plus">${ICONS.spark} Plus</span></h2>
      <div class="stagger" style="--i:3">
      ${premiumGate(`
        <div class="card" style="margin-bottom:10px">
          <p class="eyebrow" style="margin-bottom:8px">Most frequent symptoms</p>
          ${symptomChart}
        </div>
        <div class="card">
          <p class="eyebrow" style="margin-bottom:8px">${ttc ? 'Conception outlook' : 'Cycle health check'}</p>
          <p style="font-size:14px;line-height:1.55">
            ${cur ? `Today's pregnancy chance is <strong>${cur.chance.toLowerCase()}</strong>. ` : ''}
            ${st.variability != null && st.variability <= 4
              ? 'Your cycles are impressively regular — predictions should be reliable to within a day or two.'
              : 'Your cycle length varies a bit; logging basal temperature tightens ovulation estimates.'}
            ${ttc ? ' In TTC mode, aim for the 3 days before and including ovulation — they carry most of the monthly chance.' : ''}
          </p>
        </div>`, 'Symptom patterns & health analysis')}
      </div>

      <h2 class="section-title stagger" style="--i:4">Health report <span class="badge badge-plus">${ICONS.spark} Plus</span></h2>
      <div class="card cream stagger" style="--i:4">
        <p class="sub" style="margin-bottom:12px">A doctor-ready summary of your cycles, symptoms and patterns — handy for gynecologist visits.</p>
        <button class="btn ${D.premium ? 'btn-primary' : 'btn-ghost'} btn-block" data-action="${D.premium ? 'export-report' : 'paywall'}">
          ${D.premium ? 'Download report' : `${ICONS.lock}&nbsp; Unlock with Plus`}
        </button>
      </div>
    `;
  }

  function exportReport() {
    const st = Cycle.stats(D.periodDays, D.settings);
    const pred = Cycle.predictions(D.periodDays, D.settings, 2);
    const lines = [
      'TANDEM — CYCLE HEALTH REPORT',
      `Generated: ${new Date().toLocaleString()}`,
      `Name: ${D.names.tracker || '—'}`,
      '',
      `Average cycle length : ${st.cycleLen} days`,
      `Average period length: ${st.periodLen} days`,
      `Cycle variability    : ${st.variability != null ? '±' + st.variability + ' days' : 'insufficient data'}`,
      '',
      'LOGGED PERIODS',
      ...st.runs.map(r => `  ${r.start} → ${r.end}  (${r.len} days)`),
      '',
      'PREDICTIONS',
      ...pred.cycles.map(c => `  Period ~${c.start}, ovulation ~${c.ovulation}, fertile ${c.fertileStart}–${c.fertileEnd}`),
      '',
      'DAILY LOGS',
      ...Object.entries(D.logs).sort().map(([iso, l]) =>
        `  ${iso}: ${[l.flow && 'flow ' + l.flow, l.symptoms.length && 'symptoms: ' + l.symptoms.join(', '), l.moods.length && 'mood: ' + l.moods.join(', '), l.bbt != null && 'BBT ' + l.bbt + '°C'].filter(Boolean).join(' · ') || '—'}`),
    ];
    download('tandem-report.txt', lines.join('\n'), 'text/plain');
    toast('Report downloaded');
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
    const trackerName = D.names.tracker || 'your partner';
    const partnerName = D.names.partner || 'your partner';
    const meta = cur ? PHASE_META[cur.phase] : PHASE_META.follicular;

    let body = '';

    if (!D.linked) {
      body = `
        <div class="card cream stagger" style="--i:1">
          <p style="font-family:var(--serif);font-size:20px;margin-bottom:6px">Invite your partner</p>
          <p class="sub">Tandem is built for two. Share this code so ${isPartner ? trackerName : partnerName} can follow along, get phase heads-ups, and send love notes.</p>
          <div class="code-box">${D.inviteCode || ''}</div>
          <button class="btn btn-primary btn-block" data-action="copy-code">Copy invite code</button>
          <button class="btn btn-ghost btn-block mt8" data-action="simulate-link">I have a code — link now</button>
        </div>`;
    } else if (isPartner) {
      // PARTNER VIEW — supportive coaching
      const tips = cur ? TIPS[cur.phase].partner : TIPS.follicular.partner;
      const gesture = GESTURES[new Date().getDate() % GESTURES.length];
      body = `
        <div class="card stagger" style="--i:1">
          <p class="eyebrow" style="margin-bottom:6px">${esc(trackerName)} right now</p>
          <p style="font-family:var(--serif);font-size:24px;letter-spacing:-.3px">${cur ? `${meta.emoji} ${cur.label}` : 'No data yet'}</p>
          ${cur && cur.daysToPeriod != null && cur.daysToPeriod >= 0 && cur.phase !== 'menstrual' ? `<p class="sub mt8">Period expected in <strong style="color:var(--ink)">${cur.daysToPeriod} day${cur.daysToPeriod === 1 ? '' : 's'}</strong> — ${fmtDate(cur.next.start, { weekday: 'long', month: 'long', day: 'numeric' })}</p>` : ''}
          ${cur && cur.phase === 'menstrual' ? `<p class="sub mt8">Day ${cur.cycleDay} — comfort mode: ON. 🫶</p>` : ''}
        </div>

        <div class="card cream stagger" style="--i:2">
          <p class="eyebrow" style="margin-bottom:4px">How to be great this week</p>
          <ul class="tip-list">
            ${tips.map(([ico, t]) => `<li><span class="ico">${ico}</span><span>${esc(t)}</span></li>`).join('')}
          </ul>
        </div>

        <div class="stagger" style="--i:3">
        ${premiumGate(`
          <div class="card">
            <p class="eyebrow" style="margin-bottom:6px">Today's gesture</p>
            <p style="font-family:var(--serif);font-size:18px">“${esc(gesture)}”</p>
            <p class="sub mt8">Daily partner coaching, PMS early warnings and gift nudges — refreshed every morning.</p>
          </div>`, 'Daily partner coaching')}
        </div>`;
    } else {
      // TRACKER VIEW — what your partner sees + sharing controls
      body = `
        <div class="card stagger" style="--i:1">
          <div class="card-row">
            <div>
              <p class="eyebrow" style="margin-bottom:4px">Linked with</p>
              <p style="font-family:var(--serif);font-size:20px">💞 ${esc(partnerName)}</p>
            </div>
            <span class="badge badge-teal">Connected</span>
          </div>
          <p class="sub mt8">${esc(partnerName)} can see your current phase, upcoming period heads-up and supportive tips — never your notes or logs.</p>
        </div>

        <div class="card cream stagger" style="--i:2">
          <p class="eyebrow" style="margin-bottom:6px">What ${esc(partnerName)} sees today</p>
          <p style="font-size:15px">${cur ? `${meta.emoji} <strong>${cur.label}</strong>${cur.daysToPeriod != null && cur.daysToPeriod >= 0 && cur.phase !== 'menstrual' ? ` · period in ${cur.daysToPeriod}d` : ''}` : 'Nothing yet — log a period first.'}</p>
          <p class="sub mt8">Plus supportive phase tips. Switch to the Partner view above to preview it.</p>
        </div>`;
    }

    // love notes (both roles, when linked)
    const me = D.role;
    const notesHtml = D.notes.slice(-12).map(n => `
      <div class="note-bubble ${n.from === me ? 'me' : 'them'}">
        ${esc(n.text)}
        <span class="who">${n.from === 'tracker' ? esc(D.names.tracker || 'Tracker') : esc(D.names.partner || 'Partner')} · ${new Date(n.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
      </div>`).join('');

    $('#panel-partner').innerHTML = `
      <div class="role-switch stagger" style="--i:0" role="tablist" aria-label="Who is looking?">
        <button class="${!isPartner ? 'on' : ''}" data-role="tracker">🌸 ${esc(D.names.tracker || 'Tracker')}</button>
        <button class="${isPartner ? 'on' : ''}" data-role="partner">💙 ${esc(D.names.partner || 'Partner')}</button>
      </div>
      ${body}
      ${D.linked ? `
      <h2 class="section-title stagger" style="--i:4">Love notes</h2>
      <div class="card stagger" style="--i:4">
        ${notesHtml || '<p class="sub">No notes yet — send the first one 💌</p>'}
        <div class="note-compose">
          <input type="text" id="note-input" placeholder="Send a little love…" maxlength="200" aria-label="Write a love note">
          <button class="send-orb" data-action="send-note" aria-label="Send note">${ICONS.send}</button>
        </div>
      </div>` : ''}
    `;
  }

  // ---------------- PAYWALL ----------------
  let selectedPlan = 'yearly';
  function renderPaywall() {
    $('#paywall-body').innerHTML = `
      <h3>Tandem <span style="color:var(--primary)">Plus</span></h3>
      <p class="sub">Everything in the free app, plus the deep stuff — for both of you.</p>
      <div>
        ${[
          'Symptom & mood pattern analysis',
          'Doctor-ready health reports (export)',
          'Basal temperature (BBT) tracking',
          'PMS early-warning calendar shading',
          'TTC mode with conception outlook',
          'Daily partner coaching & gesture ideas',
        ].map(f => `<div class="feature-check"><span class="tick">✓</span><span>${f}</span></div>`).join('')}
      </div>
      <hr class="sep">
      <div class="plan-card ${selectedPlan === 'yearly' ? 'sel' : ''}" data-plan="yearly">
        <span class="radio"></span>
        <div><strong>Yearly</strong><br><span class="sub">7-day free trial · save 58%</span></div>
        <div class="plan-price"><div class="p">$39.99</div><div class="per">$3.33 / month</div></div>
      </div>
      <div class="plan-card ${selectedPlan === 'monthly' ? 'sel' : ''}" data-plan="monthly">
        <span class="radio"></span>
        <div><strong>Monthly</strong><br><span class="sub">Flexible, cancel anytime</span></div>
        <div class="plan-price"><div class="p">$7.99</div><div class="per">/ month</div></div>
      </div>
      <button class="btn btn-primary btn-block mt8" data-action="start-trial">Start 7-day free trial</button>
      <p class="sub center mt8" style="font-size:12px">Demo app — no real payment. The button simply unlocks Plus.</p>
    `;
    openSheet('paywall');
  }

  // ---------------- SETTINGS ----------------
  function renderSettings() {
    const s = D.settings;
    $('#settings-body').innerHTML = `
      <h3>Settings</h3>
      <div class="form-row"><label>Your name</label><input class="text" id="set-name" value="${esc(D.names.tracker)}" placeholder="e.g. Maya"></div>
      <div class="form-row"><label>Partner's name</label><input class="text" id="set-pname" value="${esc(D.names.partner)}" placeholder="e.g. Sam"></div>
      <div class="form-row"><label>Goal</label>
        <select class="text" id="set-goal">
          <option value="track" ${s.goal === 'track' ? 'selected' : ''}>Track my cycle</option>
          <option value="ttc" ${s.goal === 'ttc' ? 'selected' : ''}>Trying to conceive (TTC)</option>
          <option value="avoid" ${s.goal === 'avoid' ? 'selected' : ''}>Avoid pregnancy</option>
        </select>
      </div>
      <div class="form-row"><label>Cycle length (days) — used until predictions learn from your logs</label><input class="text" id="set-cycle" type="number" min="15" max="60" value="${s.cycleLen}"></div>
      <div class="form-row"><label>Period length (days)</label><input class="text" id="set-period" type="number" min="1" max="12" value="${s.periodLen}"></div>
      <div class="form-row"><label>Luteal phase (days) — usually 14</label><input class="text" id="set-luteal" type="number" min="9" max="17" value="${s.luteal}"></div>
      <div class="form-row"><label><input type="checkbox" id="set-motion" ${s.reduceMotion ? 'checked' : ''} style="width:auto;height:auto;margin-right:8px;vertical-align:-2px">Reduce motion (calms all animation)</label></div>
      <button class="btn btn-primary btn-block" data-action="save-settings">Save settings</button>
      <hr class="sep">
      <button class="btn btn-ghost btn-block" data-action="view-sheet">View generated spritesheet 🎞️</button>
      <button class="btn btn-ghost btn-block mt8" data-action="export-json">Export all data (JSON)</button>
      <button class="btn btn-ghost btn-block mt8" data-action="load-sample">Load sample data</button>
      <button class="btn btn-ghost btn-block mt8" style="color:var(--error)" data-action="erase">Erase everything</button>
      ${D.premium ? `<button class="btn btn-ghost btn-block mt8" data-action="cancel-plus">Cancel Tandem Plus</button>` : ''}
    `;
    openSheet('settings');
  }

  function applyMotionPref() {
    document.body.classList.toggle('reduce-motion', !!D.settings.reduceMotion);
  }

  // ---------------- ONBOARDING ----------------
  function renderOnboarding() {
    $('#onboard-body').innerHTML = `
      <div class="center" style="padding-top:6px">
        <span class="badge badge-voltage">Cycle tracking, together</span>
        <h3 style="margin-top:10px">Welcome to Tandem</h3>
        <p class="sub">One cycle, two people in the loop. Set up in 20 seconds.</p>
      </div>
      <div class="form-row"><label>Your name</label><input class="text" id="ob-name" placeholder="e.g. Maya"></div>
      <div class="form-row"><label>Partner's name (optional)</label><input class="text" id="ob-pname" placeholder="e.g. Sam"></div>
      <div class="form-row"><label>First day of your last period</label><input class="text" id="ob-last" type="date" max="${Cycle.todayISO()}"></div>
      <div class="form-row"><label>Typical cycle length</label>
        <select class="text" id="ob-cycle">${Array.from({ length: 26 }, (_, i) => 20 + i).map(n => `<option ${n === 28 ? 'selected' : ''}>${n}</option>`).join('')}</select>
      </div>
      <button class="btn btn-primary btn-block" data-action="finish-onboarding">Start tracking</button>
      <button class="btn btn-ghost btn-block mt8" data-action="onboard-sample">Just show me a demo with sample data</button>
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
    toast(useSample ? 'Sample couple loaded — meet Maya & Sam 💞' : 'You’re all set 🌸');
  }

  // ---------------- global event delegation ----------------
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab],[data-action],[data-day],[data-logdate],[data-chip],[data-role],[data-plan]');
    if (!t) return;

    if (t.dataset.tab) { switchTab(t.dataset.tab); return; }
    if (t.dataset.logdate) { logDate = t.dataset.logdate; renderLog(); return; }
    if (t.dataset.day && !t.dataset.action) { openDaySheet(t.dataset.day); return; }
    if (t.dataset.role) { Store.patch(d => d.role = t.dataset.role); D = Store.get(); renderPartner(); return; }
    if (t.dataset.plan) { selectedPlan = t.dataset.plan; renderPaywall(); return; }

    if (t.dataset.chip) {
      const { chip, val } = t.dataset;
      mutateLog(l => {
        if (chip === 'flow') l.flow = l.flow === val ? null : val;
        else if (chip === 'sex') l.sex = l.sex === val ? null : val;
        else if (chip === 'symptom') l.symptoms = l.symptoms.includes(val) ? l.symptoms.filter(x => x !== val) : [...l.symptoms, val];
        else if (chip === 'mood') l.moods = l.moods.includes(val) ? l.moods.filter(x => x !== val) : [...l.moods, val];
      });
      return;
    }

    switch (t.dataset.action) {
      case 'open-settings': renderSettings(); break;
      case 'paywall': renderPaywall(); break;
      case 'close-sheet': closeAllSheets(); break;

      case 'quick-period': {
        Store.togglePeriodDay(Cycle.todayISO());
        D = Store.get();
        rerender();
        toast(new Set(D.periodDays).has(Cycle.todayISO()) ? 'Period logged for today 🌹' : 'Removed today’s period mark');
        break;
      }
      case 'goto-log': switchTab('log'); break;
      case 'goto-calendar': switchTab('calendar'); break;

      case 'cal-prev': calCursor.setMonth(calCursor.getMonth() - 1); renderCalendar(); break;
      case 'cal-next': calCursor.setMonth(calCursor.getMonth() + 1); renderCalendar(); break;
      case 'toggle-period': {
        Store.togglePeriodDay(t.dataset.day);
        D = Store.get();
        closeAllSheets();
        renderCalendar();
        toast('Calendar updated');
        break;
      }
      case 'open-log-day': logDate = t.dataset.day; closeAllSheets(); switchTab('log'); break;

      case 'water': mutateLog(l => l.water = Math.max(0, (l.water || 0) + Number(t.dataset.d))); break;
      case 'sleep': mutateLog(l => l.sleep = Math.max(0, Math.round(((l.sleep == null ? 7 : l.sleep) + Number(t.dataset.d)) * 2) / 2)); break;
      case 'bbt': mutateLog(l => l.bbt = Math.round(((l.bbt == null ? 36.5 : l.bbt) + Number(t.dataset.d)) * 100) / 100); break;
      case 'save-notes': mutateLog(l => l.notes = $('#log-notes').value); toast('Log saved 💾'); break;

      case 'export-report': exportReport(); break;
      case 'export-json': download('tandem-data.json', JSON.stringify(Store.get(), null, 2), 'application/json'); toast('Data exported'); break;

      case 'copy-code': {
        const code = D.inviteCode || '';
        (navigator.clipboard ? navigator.clipboard.writeText(code) : Promise.reject()).then(
          () => toast('Code copied — send it to your person 💌'),
          () => toast('Code: ' + code)
        );
        break;
      }
      case 'simulate-link': Store.patch(d => d.linked = true); D = Store.get(); renderPartner(); toast('Linked! You’re in tandem now 💞'); break;
      case 'send-note': {
        const input = $('#note-input');
        const text = input.value.trim();
        if (!text) break;
        Store.patch(d => d.notes.push({ from: d.role, text, at: Date.now() }));
        D = Store.get();
        renderPartner();
        toast('Note sent 💌');
        break;
      }

      case 'start-trial': {
        Store.patch(d => { d.premium = true; d.trialEndsAt = Date.now() + 7 * 86400000; });
        D = Store.get();
        closeAllSheets();
        rerender();
        toast('Welcome to Tandem Plus ✦ trial started');
        break;
      }
      case 'cancel-plus': Store.patch(d => { d.premium = false; d.trialEndsAt = null; }); D = Store.get(); closeAllSheets(); rerender(); toast('Plus canceled'); break;

      case 'save-settings': {
        Store.patch(d => {
          d.names.tracker = $('#set-name').value.trim();
          d.names.partner = $('#set-pname').value.trim();
          d.settings.goal = $('#set-goal').value;
          d.settings.cycleLen = Math.min(60, Math.max(15, parseInt($('#set-cycle').value, 10) || 28));
          d.settings.periodLen = Math.min(12, Math.max(1, parseInt($('#set-period').value, 10) || 5));
          d.settings.luteal = Math.min(17, Math.max(9, parseInt($('#set-luteal').value, 10) || 14));
          d.settings.reduceMotion = $('#set-motion').checked;
        });
        D = Store.get();
        applyMotionPref();
        closeAllSheets();
        rerender();
        toast('Settings saved');
        break;
      }
      case 'view-sheet': {
        const cur = Cycle.current(D.periodDays, D.settings);
        $('#sheet-view').innerHTML = `
          <h3>Generated spritesheet</h3>
          <p class="sub">64 frames, drawn entirely in code at load time — this exact sheet powers the beating womb-heart on Home.</p>
          <img alt="8 by 8 spritesheet of the womb heart animation" src="${WombSprite.getSheetDataURL(cur ? cur.phase : 'follicular')}">
        `;
        closeSheet('settings');
        openSheet('sheetviewer');
        break;
      }
      case 'load-sample': Store.sampleData(); Store.patch(d => { d.names.tracker = d.names.tracker || 'Maya'; d.names.partner = d.names.partner || 'Sam'; }); D = Store.get(); closeAllSheets(); rerender(); toast('Sample data loaded'); break;
      case 'erase': {
        if (confirm('Erase all Tandem data on this device?')) {
          Store.reset(); D = Store.get(); closeAllSheets(); renderOnboarding();
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
    applyMotionPref();
    // generated favicon
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = WombSprite.favicon();
    document.head.appendChild(link);

    switchTab('home');
    if (!D.onboarded) renderOnboarding();
  }

  boot();
})();
