/* ============================================================
   Tandem notifications & app badge (serverless best-effort)
   - Local notifications fire when the app opens / becomes
     visible: "period in N days" (N ≤ 3), ovulation day.
     Once per day, tracked via lastNotify.
   - App icon badge (where supported) shows days-to-period.
   NOTE: true background push needs a server (planned with the
   Supabase integration) — this is the honest PWA-only maximum.
   ============================================================ */

const Notify = (() => {
  const supported = () => 'Notification' in window;

  async function enable() {
    if (!supported()) return 'unsupported';
    try { return await Notification.requestPermission(); }
    catch (e) { return 'denied'; }
  }

  async function show(title, body) {
    const opts = { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'tandem-cycle' };
    try {
      const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
      if (reg && reg.showNotification) { reg.showNotification(title, opts); return; }
    } catch (e) { /* fall through */ }
    try { new Notification(title, opts); } catch (e) { /* blocked */ }
  }

  function updateBadge(cur) {
    if (!('setAppBadge' in navigator)) return;
    if (cur && cur.daysToPeriod != null && cur.daysToPeriod >= 0 && cur.daysToPeriod <= 9) {
      navigator.setAppBadge(cur.daysToPeriod).catch(() => {});
    } else {
      navigator.clearAppBadge && navigator.clearAppBadge().catch(() => {});
    }
  }

  // Called on boot, on visibility, and after data changes
  function check(D) {
    if (!D || !D.settings.reminders) { navigator.clearAppBadge && navigator.clearAppBadge().catch(() => {}); return; }
    const cur = Cycle.current(D.periodDays, D.settings);
    updateBadge(cur);
    if (!cur) return;
    if (!supported() || Notification.permission !== 'granted') return;

    const today = Cycle.todayISO();
    if (D.lastNotify === today) return; // once per day

    let title = null, body = null;
    if (cur.daysToPeriod === 0 && cur.phase !== 'menstrual') {
      title = t('notif.d0Title'); body = t('notif.body');
    } else if (cur.daysToPeriod != null && cur.daysToPeriod > 0 && cur.daysToPeriod <= 3) {
      title = t('notif.dTitle', { d: cur.daysToPeriod }); body = t('notif.body');
    } else if (cur.phase === 'ovulation') {
      title = t('notif.ovuTitle'); body = t('notif.ovuBody');
    }

    if (title) {
      show(title, body);
      Store.patch(d => d.lastNotify = today);
    }
  }

  return { supported, enable, check, updateBadge };
})();
