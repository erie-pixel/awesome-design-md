/* ============================================================
   Tandem sprite engine v2 — "Bibi" the cycle heart
   A clean, kawaii heart (no anatomy) whose FACE and ACCESSORY
   change with the cycle phase, generated as a full 8×8 64-frame
   spritesheet entirely in code:

     menstrual  → resting closed eyes, floating droplet, slow beat
     follicular → bright eyes + sprout on top
     fertile    → sparkle eyes + orbiting teal sparks
     ovulation  → star eyes + golden crown, fastest beat
     luteal     → sleepy half eyes + crescent moon
     pms        → pouty face + little rain cloud

   Motion practles baked in: squash & stretch on the heartbeat,
   idle sway, blink cycle, bobbing accessories, time-based
   playback via rAF, prefers-reduced-motion → calm static frame.
   ============================================================ */

const WombSprite = (() => {
  const COLS = 8, ROWS = 8, FRAMES = COLS * ROWS, CELL = 200;

  const PALETTES = {
    menstrual:  { light: '#ffb3c4', mid: '#ff5c7c', deep: '#e0224d', glow: '#ff8fa9', spark: '#ffd1da', blush: '#e0224d', bpm: 0.85 },
    follicular: { light: '#ffbecd', mid: '#ff6b8a', deep: '#e63a60', glow: '#ffa3b8', spark: '#e8a55a', blush: '#e63a60', bpm: 1.0 },
    fertile:    { light: '#ffc4d2', mid: '#ff6b8a', deep: '#e63a60', glow: '#5db8a6', spark: '#5db8a6', blush: '#e63a60', bpm: 1.12 },
    ovulation:  { light: '#ffcdd9', mid: '#ff7593', deep: '#e63a60', glow: '#f4c95d', spark: '#ffd98a', blush: '#e63a60', bpm: 1.28 },
    luteal:     { light: '#ffc0b0', mid: '#f08a70', deep: '#d05a44', glow: '#e8a55a', spark: '#e8d9a8', blush: '#d05a44', bpm: 0.92 },
    pms:        { light: '#f5c8a8', mid: '#e89a70', deep: '#c76a48', glow: '#e8a55a', spark: '#c9c4bd', blush: '#c76a48', bpm: 0.8 },
  };

  // Double-pulse heartbeat envelope: lub–dub, then rest
  function beat(t) {
    const g = (c, w) => Math.exp(-Math.pow((t - c) / w, 2));
    return g(0.16, 0.055) + 0.55 * g(0.34, 0.075);
  }

  // Chubby kawaii heart: wide round lobes, shallow notch, soft tip
  function heartPath(ctx, s) {
    ctx.beginPath();
    ctx.moveTo(0, 36 * s);
    ctx.bezierCurveTo(-14 * s, 26 * s, -52 * s, 8 * s, -52 * s, -16 * s);
    ctx.bezierCurveTo(-52 * s, -36 * s, -34 * s, -42 * s, -22 * s, -38 * s);
    ctx.bezierCurveTo(-10 * s, -34 * s, -3 * s, -26 * s, 0, -18 * s);
    ctx.bezierCurveTo(3 * s, -26 * s, 10 * s, -34 * s, 22 * s, -38 * s);
    ctx.bezierCurveTo(34 * s, -42 * s, 52 * s, -36 * s, 52 * s, -16 * s);
    ctx.bezierCurveTo(52 * s, 8 * s, 14 * s, 26 * s, 0, 36 * s);
    ctx.closePath();
  }

  function drawSparkle(ctx, x, y, r, alpha, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-r, 0); ctx.lineTo(r, 0);
    ctx.moveTo(0, -r); ctx.lineTo(0, r);
    ctx.stroke();
    ctx.restore();
  }

  function drawStarPupil(ctx, x, y, r, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4 - Math.PI / 2;
      const rad = i % 2 === 0 ? r : r * 0.45;
      ctx[i === 0 ? 'moveTo' : 'lineTo'](Math.cos(a) * rad, Math.sin(a) * rad);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // ---------- face per phase ----------
  function drawFace(ctx, phase, t) {
    const INK = '#4a2430';
    const ey = -6, ex = 17; // eye positions
    const blinking = t > 0.52 && t < 0.60; // one blink per loop

    ctx.save();
    ctx.lineCap = 'round';

    const closedEye = (x, dir = 1) => { // relaxed ∪ curve
      ctx.strokeStyle = INK; ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, ey - 1 * dir, 5.5, dir > 0 ? 0.15 * Math.PI : 1.15 * Math.PI, dir > 0 ? 0.85 * Math.PI : 1.85 * Math.PI);
      ctx.stroke();
    };
    const dotEye = (x) => {
      ctx.fillStyle = INK;
      ctx.beginPath(); ctx.arc(x, ey, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.beginPath(); ctx.arc(x - 1.7, ey - 1.7, 1.7, 0, Math.PI * 2); ctx.fill();
    };
    const sleepyEye = (x) => { // half-lidded line with tiny curve
      ctx.strokeStyle = INK; ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.arc(x, ey - 3, 5.5, 0.12 * Math.PI, 0.88 * Math.PI);
      ctx.stroke();
    };
    const flatEye = (x) => {
      ctx.strokeStyle = INK; ctx.lineWidth = 3.2;
      ctx.beginPath(); ctx.moveTo(x - 5, ey); ctx.lineTo(x + 5, ey); ctx.stroke();
    };

    const smile = (w = 7, yOff = 9, curve = 4) => {
      ctx.strokeStyle = INK; ctx.lineWidth = 2.8;
      ctx.beginPath();
      ctx.moveTo(-w, yOff);
      ctx.quadraticCurveTo(0, yOff + curve, w, yOff);
      ctx.stroke();
    };
    const openSmile = () => {
      ctx.fillStyle = INK;
      ctx.beginPath(); ctx.arc(0, 9, 6, 0, Math.PI); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ff8fa9';
      ctx.beginPath(); ctx.arc(0, 12.5, 3, 0, Math.PI); ctx.closePath(); ctx.fill();
    };
    const catMouth = () => { // cute "w"
      ctx.strokeStyle = INK; ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(-7, 8); ctx.quadraticCurveTo(-3.5, 12, 0, 8);
      ctx.quadraticCurveTo(3.5, 12, 7, 8);
      ctx.stroke();
    };
    const pout = () => {
      ctx.strokeStyle = INK; ctx.lineWidth = 2.8;
      ctx.beginPath();
      ctx.moveTo(-6, 11);
      ctx.quadraticCurveTo(0, 7.5, 6, 11);
      ctx.stroke();
    };

    switch (phase) {
      case 'menstrual':
        closedEye(-ex); closedEye(ex);
        smile(5.5, 9, 3);
        break;
      case 'follicular':
        if (blinking) { closedEye(-ex); closedEye(ex); } else { dotEye(-ex); dotEye(ex); }
        smile();
        break;
      case 'fertile':
        if (blinking) { closedEye(-ex); closedEye(ex); } else { dotEye(-ex); dotEye(ex); }
        catMouth();
        break;
      case 'ovulation':
        drawStarPupil(ctx, -ex, ey, 7, '#4a2430');
        drawStarPupil(ctx, ex, ey, 7, '#4a2430');
        openSmile();
        break;
      case 'luteal':
        sleepyEye(-ex); sleepyEye(ex);
        smile(5.5, 9, 2.5);
        break;
      case 'pms':
        flatEye(-ex); flatEye(ex);
        pout();
        break;
    }
    ctx.restore();
  }

  // ---------- accessory per phase (bobs gently with sin) ----------
  function drawAccessory(ctx, phase, t, p) {
    const bob = Math.sin(t * Math.PI * 2) * 2.5;
    ctx.save();
    ctx.lineCap = 'round';

    if (phase === 'menstrual') {
      // soft floating droplet, top-right
      ctx.translate(48, -44 + bob);
      ctx.fillStyle = '#8fc3ea';
      ctx.beginPath();
      ctx.moveTo(0, -8);
      ctx.quadraticCurveTo(7, 2, 0, 7);
      ctx.quadraticCurveTo(-7, 2, 0, -8);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.6)';
      ctx.beginPath(); ctx.arc(-1.8, 1, 1.6, 0, Math.PI * 2); ctx.fill();
    } else if (phase === 'follicular') {
      // sprout on the notch
      ctx.translate(0, -42 + bob * 0.4);
      ctx.strokeStyle = '#5fa96f'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(0, 10); ctx.quadraticCurveTo(1, 2, 0, -3); ctx.stroke();
      ctx.fillStyle = '#7fc98f';
      ctx.beginPath(); ctx.ellipse(-6, -6, 7, 4, -0.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(6, -6, 7, 4, 0.6, 0, Math.PI * 2); ctx.fill();
    } else if (phase === 'fertile') {
      // tiny teal companion heart, top-left
      ctx.translate(-48, -42 + bob);
      ctx.fillStyle = p.glow;
      heartPath(ctx, 0.13);
      ctx.fill();
    } else if (phase === 'ovulation') {
      // golden crown
      ctx.translate(0, -48 + bob * 0.5);
      ctx.fillStyle = '#f4c95d';
      ctx.beginPath();
      ctx.moveTo(-16, 4);
      ctx.lineTo(-16, -6); ctx.lineTo(-8, 0); ctx.lineTo(0, -9); ctx.lineTo(8, 0); ctx.lineTo(16, -6); ctx.lineTo(16, 4);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffe6ae';
      [[-16, -7], [0, -10], [16, -7]].forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill(); });
    } else if (phase === 'luteal') {
      // crescent moon, top-left
      ctx.translate(-48, -42 + bob);
      ctx.fillStyle = '#e8d9a8';
      ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath(); ctx.arc(4.5, -2.5, 7.5, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    } else if (phase === 'pms') {
      // little rain cloud with falling drops
      ctx.translate(46, -44 + bob * 0.5);
      ctx.fillStyle = '#c9c4bd';
      [[0, 0, 8], [-8, 3, 6], [8, 3, 6]].forEach(([x, y, r]) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); });
      ctx.fillRect(-12, 3, 24, 6);
      const fall = (t * 3) % 1;
      ctx.fillStyle = '#8fc3ea';
      ctx.globalAlpha = 1 - fall;
      [[-6, 12], [5, 15]].forEach(([x, y]) => {
        ctx.beginPath(); ctx.ellipse(x, y + fall * 12, 1.8, 2.8, 0, 0, Math.PI * 2); ctx.fill();
      });
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function drawFrame(ctx, t, p, phase) {
    const b = beat(t);
    const sway = Math.sin(t * Math.PI * 2) * 0.035; // gentle idle sway (radians)

    ctx.save();
    ctx.translate(CELL / 2, CELL / 2 + 6);

    // expanding pulse ring, one per heartbeat loop
    const ringT = (t + 0.7) % 1;
    ctx.beginPath();
    ctx.arc(0, -4, 56 + ringT * 42, 0, Math.PI * 2);
    ctx.strokeStyle = p.glow;
    ctx.globalAlpha = (1 - ringT) * 0.2;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // ambient glow
    const gg = ctx.createRadialGradient(0, -2, 6, 0, -2, 84);
    gg.addColorStop(0, p.glow + '88');
    gg.addColorStop(1, p.glow + '00');
    ctx.globalAlpha = 0.28 + 0.4 * b;
    ctx.fillStyle = gg;
    ctx.beginPath(); ctx.arc(0, -2, 84, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;

    // orbiting sparkles (behind body)
    for (let i = 0; i < 5; i++) {
      const a = t * Math.PI * 2 + (i * Math.PI * 2) / 5;
      const rad = 78 + 7 * Math.sin(t * Math.PI * 4 + i * 1.7);
      const tw = Math.sin(t * Math.PI * 6 + i * 2.3);
      drawSparkle(ctx, Math.cos(a) * rad, -2 + Math.sin(a) * rad * 0.8, 2 + 1.5 * Math.abs(tw), 0.15 + 0.35 * Math.abs(tw), i % 2 === 0 ? '#ffffff' : p.spark);
    }

    // the heart — squash & stretch on the beat, planted bounce
    ctx.rotate(sway);
    ctx.translate(0, b * 2.2);
    ctx.scale(1 + 0.085 * b, 1 - 0.045 * b + 0.02 * b * b);

    // soft drop shadow
    ctx.save();
    ctx.translate(0, 44);
    ctx.scale(1 + 0.1 * b, 1);
    ctx.fillStyle = 'rgba(80,30,45,.10)';
    ctx.beginPath(); ctx.ellipse(0, 0, 40, 7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    const bg = ctx.createLinearGradient(0, -52, 0, 48);
    bg.addColorStop(0, p.light);
    bg.addColorStop(0.55, p.mid);
    bg.addColorStop(1, p.deep);
    heartPath(ctx, 1.15);
    ctx.fillStyle = bg;
    ctx.fill();

    // rim light + gloss
    ctx.save();
    heartPath(ctx, 1.15);
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.beginPath(); ctx.ellipse(-24, -30, 18, 10, -0.45, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.22)';
    ctx.beginPath(); ctx.ellipse(30, -22, 7, 4.5, 0.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // blush cheeks
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = p.blush;
    ctx.beginPath(); ctx.ellipse(-30, 5, 7.5, 4.8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(30, 5, 7.5, 4.8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;

    drawFace(ctx, phase, t);
    drawAccessory(ctx, phase, t, p);

    ctx.restore();
  }

  function generateSheet(phase) {
    const p = PALETTES[phase] || PALETTES.follicular;
    const key = PALETTES[phase] ? phase : 'follicular';
    const c = document.createElement('canvas');
    c.width = COLS * CELL;
    c.height = ROWS * CELL;
    const ctx = c.getContext('2d');
    for (let f = 0; f < FRAMES; f++) {
      const x = (f % COLS) * CELL, y = Math.floor(f / COLS) * CELL;
      ctx.save();
      ctx.translate(x, y);
      ctx.beginPath();
      ctx.rect(0, 0, CELL, CELL);
      ctx.clip();
      drawFrame(ctx, f / FRAMES, p, key);
      ctx.restore();
    }
    return c;
  }

  // ---------- Player ----------
  let sheet = null, currentPhase = null, rafId = 0, playing = false;
  let displayCanvas = null, dctx = null;

  function reducedMotion() {
    return document.body.classList.contains('reduce-motion') ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function blit(frame) {
    const size = displayCanvas.width;
    const sx = (frame % COLS) * CELL, sy = Math.floor(frame / COLS) * CELL;
    dctx.clearRect(0, 0, size, size);
    dctx.drawImage(sheet, sx, sy, CELL, CELL, 0, 0, size, size);
  }

  function loop() {
    const p = PALETTES[currentPhase] || PALETTES.follicular;
    const periodMs = 2400 / p.bpm;
    const step = (now) => {
      if (!playing) return;
      const frame = Math.floor(((now % periodMs) / periodMs) * FRAMES) % FRAMES;
      blit(frame);
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  }

  function mount(canvas) {
    displayCanvas = canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssSize = canvas.clientWidth || 264;
    canvas.width = Math.round(cssSize * dpr);
    canvas.height = Math.round(cssSize * dpr);
    dctx = canvas.getContext('2d');
  }

  function setPhase(phase) {
    if (!displayCanvas) return;
    if (phase !== currentPhase || !sheet) {
      currentPhase = phase;
      sheet = generateSheet(phase);
    }
    cancelAnimationFrame(rafId);
    if (reducedMotion()) {
      playing = false;
      blit(4); // calm resting frame
    } else {
      playing = true;
      loop();
    }
  }

  function stop() { playing = false; cancelAnimationFrame(rafId); }

  function getSheetDataURL(phase) {
    return generateSheet(phase || currentPhase || 'follicular').toDataURL('image/png');
  }

  // Render a single static frame onto any canvas (glance page, icons)
  function renderStatic(canvas, phase, frameT = 0.16) {
    const p = PALETTES[phase] || PALETTES.follicular;
    const key = PALETTES[phase] ? phase : 'follicular';
    const ctx = canvas.getContext('2d');
    const scale = canvas.width / CELL;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(scale, scale);
    drawFrame(ctx, frameT, p, key);
    ctx.restore();
  }

  // tiny generated favicon: one cute frame
  function favicon() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    renderStatic(c, 'menstrual', 0.16);
    return c.toDataURL('image/png');
  }

  return { mount, setPhase, stop, getSheetDataURL, renderStatic, favicon, PALETTES };
})();
