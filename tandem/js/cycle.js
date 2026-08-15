/* ============================================================
   Tandem cycle engine — predictions computed from logged
   period days, falling back to user settings.
   Model (standard across popular trackers):
   - cycle length  = interval between period starts (avg of last 6)
   - ovulation     = next predicted start − luteal length (default 14)
   - fertile window = ovulation −5 days … ovulation +1 day
   - PMS window    = 4 days before predicted start
   ============================================================ */

const Cycle = (() => {
  const pad = n => String(n).padStart(2, '0');
  const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (iso, n) => { const d = parse(iso); d.setDate(d.getDate() + n); return toISO(d); };
  const diffDays = (a, b) => Math.round((parse(a) - parse(b)) / 86400000);
  const todayISO = () => toISO(new Date());

  // Group sorted period day strings into consecutive runs
  function runs(periodDays) {
    const days = [...periodDays].sort();
    const out = [];
    for (const d of days) {
      const last = out[out.length - 1];
      if (last && diffDays(d, last.end) === 1) { last.end = d; last.len++; }
      else out.push({ start: d, end: d, len: 1 });
    }
    return out;
  }

  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

  function stats(periodDays, settings) {
    const rs = runs(periodDays);
    const starts = rs.map(r => r.start);
    const intervals = [];
    for (let i = 1; i < starts.length; i++) {
      const d = diffDays(starts[i], starts[i - 1]);
      if (d >= 15 && d <= 60) intervals.push(d);
    }
    const recent = intervals.slice(-6);
    const recentLens = rs.slice(-6).map(r => r.len).filter(l => l >= 1 && l <= 12);
    const cycleLen = recent.length ? Math.round(mean(recent)) : settings.cycleLen;
    const periodLen = recentLens.length ? Math.round(mean(recentLens)) : settings.periodLen;
    const variability = recent.length > 1
      ? Math.round(Math.max(...recent) - Math.min(...recent))
      : null;
    return { runs: rs, intervals: recent, cycleLen, periodLen, variability, lastStart: starts[starts.length - 1] || null };
  }

  function predictions(periodDays, settings, count = 3) {
    const st = stats(periodDays, settings);
    if (!st.lastStart) return { ...st, cycles: [] };
    const cycles = [];
    for (let k = 1; k <= count; k++) {
      const start = addDays(st.lastStart, st.cycleLen * k);
      const ovulation = addDays(start, -settings.luteal);
      cycles.push({
        start,
        end: addDays(start, st.periodLen - 1),
        ovulation,
        fertileStart: addDays(ovulation, -5),
        fertileEnd: addDays(ovulation, 1),
        pmsStart: addDays(start, -4),
      });
    }
    return { ...st, cycles };
  }

  // Classify one calendar date. Logged period wins over everything.
  function dayInfo(iso, periodDays, settings) {
    const set = periodDays instanceof Set ? periodDays : new Set(periodDays);
    if (set.has(iso)) return { kind: 'period' };
    const pred = predictions(periodDays, settings, 4);
    if (!pred.lastStart) return { kind: 'none' };

    // current (in-progress) cycle fertile window too
    const currentOv = addDays(pred.cycles.length ? pred.cycles[0].start : pred.lastStart, pred.cycles.length ? -settings.luteal : 0);
    const windows = pred.cycles.map(c => c);

    for (const c of windows) {
      if (iso >= c.start && iso <= c.end) return { kind: 'predicted' };
    }
    for (const c of windows) {
      if (iso === c.ovulation) return { kind: 'ovulation' };
      if (iso >= c.fertileStart && iso <= c.fertileEnd) return { kind: 'fertile' };
    }
    for (const c of windows) {
      if (iso >= c.pmsStart && iso < c.start) return { kind: 'pms' };
    }
    void currentOv;
    return { kind: 'none' };
  }

  // Today's headline state for the home screen / partner view
  function current(periodDays, settings) {
    const today = todayISO();
    const pred = predictions(periodDays, settings, 1);
    if (!pred.lastStart) return null;
    const cycleDay = diffDays(today, pred.lastStart) + 1;
    const next = pred.cycles[0];
    const daysToPeriod = next ? diffDays(next.start, today) : null;
    const set = new Set(periodDays);

    let phase, label;
    if (set.has(today)) { phase = 'menstrual'; label = 'Period'; }
    else if (next && today === next.ovulation) { phase = 'ovulation'; label = 'Ovulation day'; }
    else if (next && today >= next.fertileStart && today <= next.fertileEnd) { phase = 'fertile'; label = 'Fertile window'; }
    else if (next && today >= next.pmsStart && today < next.start) { phase = 'pms'; label = 'PMS window'; }
    else if (next && today < next.fertileStart) { phase = 'follicular'; label = 'Follicular phase'; }
    else { phase = 'luteal'; label = 'Luteal phase'; }

    const chance = { menstrual: 'Low', follicular: 'Low to medium', fertile: 'High', ovulation: 'Highest', luteal: 'Low', pms: 'Low' }[phase];

    return { today, cycleDay, phase, label, daysToPeriod, next, cycleLen: pred.cycleLen, periodLen: pred.periodLen, chance };
  }

  return { toISO, parse, addDays, diffDays, todayISO, runs, stats, predictions, dayInfo, current };
})();
