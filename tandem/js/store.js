/* ============================================================
   Tandem store — localStorage persistence + defaults
   ============================================================ */

const Store = (() => {
  const KEY = 'tandem.v1';

  const defaults = () => ({
    onboarded: false,
    premium: false,
    trialEndsAt: null,
    role: 'tracker', // 'tracker' | 'partner'
    linked: false,
    inviteCode: null,
    names: { tracker: '', partner: '' },
    settings: { cycleLen: 28, periodLen: 5, luteal: 14, reduceMotion: false, goal: 'track', lang: null }, // goal: track | ttc | avoid; lang: 'en' | 'ko' (null = auto-detect)
    periodDays: [],        // ['YYYY-MM-DD', ...]
    logs: {},              // { iso: { flow, symptoms[], moods[], sex, energy, water, sleep, bbt, notes } }
    notes: [],             // love notes: { from: 'tracker'|'partner', text, at }
  });

  let data = defaults();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) data = Object.assign(defaults(), JSON.parse(raw));
    } catch (e) { /* corrupted state — start fresh */ data = defaults(); }
    return data;
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* storage full/blocked */ }
  }

  function patch(fn) { fn(data); save(); }

  function reset() { data = defaults(); save(); }

  function get() { return data; }

  function togglePeriodDay(iso) {
    patch(d => {
      const i = d.periodDays.indexOf(iso);
      if (i >= 0) d.periodDays.splice(i, 1);
      else d.periodDays.push(iso);
      d.periodDays.sort();
    });
  }

  function log(iso) {
    if (!data.logs[iso]) data.logs[iso] = { flow: null, symptoms: [], moods: [], sex: null, energy: null, water: 0, sleep: null, bbt: null, notes: '' };
    return data.logs[iso];
  }

  function sampleData() {
    // Three realistic past cycles ending recently, plus a few logs
    const today = Cycle.todayISO();
    const starts = [Cycle.addDays(today, -66), Cycle.addDays(today, -37), Cycle.addDays(today, -9)];
    const lens = [5, 6, 5];
    const periodDays = [];
    starts.forEach((s, i) => { for (let k = 0; k < lens[i]; k++) periodDays.push(Cycle.addDays(s, k)); });
    const logs = {};
    const put = (iso, o) => { logs[iso] = Object.assign({ flow: null, symptoms: [], moods: [], sex: null, energy: null, water: 0, sleep: null, bbt: null, notes: '' }, o); };
    put(starts[2], { flow: 'Heavy', symptoms: ['Cramps', 'Fatigue'], moods: ['Sensitive'], water: 5, sleep: 7 });
    put(Cycle.addDays(starts[2], 1), { flow: 'Heavy', symptoms: ['Cramps', 'Backache'], moods: ['Irritable'], water: 6, sleep: 6.5 });
    put(Cycle.addDays(starts[2], 2), { flow: 'Medium', symptoms: ['Headache'], moods: ['Calm'], water: 7, sleep: 8 });
    put(Cycle.addDays(starts[2], 3), { flow: 'Light', symptoms: [], moods: ['Happy'], water: 6, sleep: 8 });
    put(Cycle.addDays(starts[2], 4), { flow: 'Spotting', symptoms: [], moods: ['Energetic'], water: 8, sleep: 7.5 });
    put(Cycle.addDays(starts[1], 0), { flow: 'Medium', symptoms: ['Cramps', 'Bloating'], moods: ['Sad'], water: 4, sleep: 6 });
    put(Cycle.addDays(starts[1], 26), { symptoms: ['Tender breasts', 'Cravings'], moods: ['Irritable'], water: 5, sleep: 6 });
    put(Cycle.addDays(starts[1], 25), { symptoms: ['Bloating', 'Cravings'], moods: ['Anxious'], water: 4, sleep: 6.5 });
    put(Cycle.addDays(today, -1), { symptoms: [], moods: ['Romantic'], sex: 'Protected', water: 7, sleep: 8 });

    patch(d => {
      d.periodDays = periodDays.sort();
      d.logs = logs;
      d.notes = [
        { from: 'partner', text: 'Picked up your favorite tea on the way home 🍵', at: Date.now() - 86400000 * 2 },
        { from: 'tracker', text: 'You’re the best. Movie night?', at: Date.now() - 86400000 * 2 + 3600000 },
        { from: 'partner', text: 'Always. You pick, I’ll make popcorn 🍿', at: Date.now() - 86400000 },
      ];
      d.linked = true;
      d.inviteCode = 'LUNA-7439';
    });
  }

  return { load, save, patch, reset, get, togglePeriodDay, log, sampleData, KEY };
})();
