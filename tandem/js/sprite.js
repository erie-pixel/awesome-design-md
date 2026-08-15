/* ============================================================
   Tandem sprite engine
   Generates a full 8×8 (64-frame) spritesheet of an animated
   "womb-heart" — a heart shaped like a womb with fallopian
   arms, ovaries, inner lining, glow and orbiting sparkles —
   entirely in code on an offscreen canvas, then plays it back
   frame-by-frame like a classic spritesheet animation.

   Motion practices applied:
   - all easing baked per-frame (double-pulse heartbeat curve)
   - playback via requestAnimationFrame, time-based (no drift)
   - honors prefers-reduced-motion (renders a single calm frame)
   - only canvas compositing at play time; zero layout work
   ============================================================ */

const WombSprite = (() => {
  const COLS = 8, ROWS = 8, FRAMES = COLS * ROWS, CELL = 200;

  // Phase palettes: body stays womb-pink, accents shift per phase
  const PALETTES = {
    menstrual:  { light: '#ff8fa9', mid: '#ff385c', deep: '#c81e48', glow: '#ff5c7c', spark: '#ffd1da', bpm: 0.9 },
    follicular: { light: '#ffa3b8', mid: '#ff5c7c', deep: '#d42a52', glow: '#ff8fa9', spark: '#e8a55a', bpm: 1.0 },
    fertile:    { light: '#ffb0c0', mid: '#ff5c7c', deep: '#d42a52', glow: '#5db8a6', spark: '#5db8a6', bpm: 1.15 },
    ovulation:  { light: '#ffc2ce', mid: '#ff6b8a', deep: '#d42a52', glow: '#5db8a6', spark: '#8fe0cf', bpm: 1.3 },
    luteal:     { light: '#f2a98f', mid: '#e0705c', deep: '#b04a38', glow: '#cc785c', spark: '#e8a55a', bpm: 0.95 },
    pms:        { light: '#f0b283', mid: '#e08a5c', deep: '#b05f38', glow: '#e8a55a', spark: '#e8a55a', bpm: 0.85 },
  };

  // Double-pulse heartbeat envelope: lub–dub, then rest
  function beat(t) {
    const g = (c, w) => Math.exp(-Math.pow((t - c) / w, 2));
    return g(0.16, 0.055) + 0.55 * g(0.34, 0.075);
  }

  function heartPath(ctx, s) {
    // Womb-shaped heart: rounder top lobes, gently tapered base
    ctx.beginPath();
    ctx.moveTo(0, 30 * s);
    ctx.bezierCurveTo(-58 * s, -12 * s, -38 * s, -52 * s, -2 * s, -26 * s);
    ctx.bezierCurveTo(0, -28 * s, 0, -28 * s, 2 * s, -26 * s);
    ctx.bezierCurveTo(38 * s, -52 * s, 58 * s, -12 * s, 0, 30 * s);
    ctx.closePath();
  }

  function drawArm(ctx, dir, p, wiggle) {
    // Fallopian arm: curl out from the top notch, ovary at the tip
    ctx.save();
    ctx.scale(dir, 1);
    ctx.strokeStyle = p.deep;
    ctx.lineWidth = 6.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(14, -34);
    ctx.bezierCurveTo(34, -58 + wiggle * 2, 58, -56 + wiggle * 3, 66, -38 + wiggle * 2);
    ctx.stroke();
    // fimbriae — little fingers at the tube end
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.lineWidth = 2.6;
      ctx.moveTo(66, -38 + wiggle * 2);
      ctx.quadraticCurveTo(72 + i * 2, -32 + i * 5 + wiggle, 76 + i * 2.5, -28 + i * 7 + wiggle);
      ctx.stroke();
    }
    // ovary
    const og = ctx.createRadialGradient(70, -50 + wiggle * 2, 1, 70, -50 + wiggle * 2, 11);
    og.addColorStop(0, p.light);
    og.addColorStop(1, p.mid);
    ctx.fillStyle = og;
    ctx.beginPath();
    ctx.arc(70, -50 + wiggle * 2, 10, 0, Math.PI * 2);
    ctx.fill();
    // follicle dots
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    [[66, -53], [73, -49], [69, -45]].forEach(([x, y]) => {
      ctx.beginPath(); ctx.arc(x, y + wiggle * 2, 1.7, 0, Math.PI * 2); ctx.fill();
    });
    ctx.restore();
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

  function drawFrame(ctx, t, p) {
    const b = beat(t);
    const scale = 1 + 0.065 * b;
    const glow = 0.30 + 0.42 * b;
    const wiggle = Math.sin(t * Math.PI * 2) * 1.6;

    ctx.save();
    ctx.translate(CELL / 2, CELL / 2 + 8);

    // expanding pulse ring, emitted on each beat loop
    const ringT = (t + 0.7) % 1;
    ctx.beginPath();
    ctx.arc(0, -4, 52 + ringT * 44, 0, Math.PI * 2);
    ctx.strokeStyle = p.glow;
    ctx.globalAlpha = (1 - ringT) * 0.22;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // ambient glow
    const gg = ctx.createRadialGradient(0, -4, 6, 0, -4, 86);
    gg.addColorStop(0, p.glow + 'aa');
    gg.addColorStop(1, p.glow + '00');
    ctx.globalAlpha = glow;
    ctx.fillStyle = gg;
    ctx.beginPath(); ctx.arc(0, -4, 86, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;

    // arms behind body
    drawArm(ctx, -1, p, wiggle);
    drawArm(ctx, 1, p, -wiggle);

    // beating body
    ctx.save();
    ctx.scale(scale, scale);

    const bg = ctx.createLinearGradient(0, -55, 0, 55);
    bg.addColorStop(0, p.light);
    bg.addColorStop(0.45, p.mid);
    bg.addColorStop(1, p.deep);
    heartPath(ctx, 1.5);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = p.deep;
    ctx.globalAlpha = 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // inner lining (endometrium) — softly pulsing inner heart
    ctx.save();
    ctx.scale(0.58 + 0.03 * b, 0.58 + 0.03 * b);
    const ig = ctx.createRadialGradient(0, -6, 2, 0, -6, 60);
    ig.addColorStop(0, p.deep);
    ig.addColorStop(1, p.mid + '00');
    heartPath(ctx, 1.5);
    ctx.fillStyle = ig;
    ctx.globalAlpha = 0.65;
    ctx.fill();
    ctx.restore();

    // cervical dimple
    ctx.beginPath();
    ctx.arc(0, 34, 3.4, 0, Math.PI * 2);
    ctx.fillStyle = p.deep;
    ctx.globalAlpha = 0.55;
    ctx.fill();
    ctx.globalAlpha = 1;

    // gloss highlight
    ctx.beginPath();
    ctx.ellipse(-20, -28, 15, 9, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.38)';
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(-30, -14, 5, 3.2, -0.6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.30)';
    ctx.fill();
    ctx.restore();

    // orbiting sparkles
    for (let i = 0; i < 7; i++) {
      const a = t * Math.PI * 2 + (i * Math.PI * 2) / 7;
      const rad = 84 + 9 * Math.sin(t * Math.PI * 4 + i * 1.7);
      const tw = Math.sin(t * Math.PI * 6 + i * 2.3);
      drawSparkle(
        ctx,
        Math.cos(a) * rad,
        -4 + Math.sin(a) * rad * 0.82,
        2 + 1.6 * Math.abs(tw),
        0.18 + 0.4 * Math.abs(tw),
        i % 3 === 0 ? '#ffffff' : p.spark
      );
    }

    ctx.restore();
  }

  function generateSheet(phase) {
    const p = PALETTES[phase] || PALETTES.follicular;
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
      drawFrame(ctx, f / FRAMES, p);
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
    const periodMs = 2400 / p.bpm; // one heartbeat loop
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
      blit(0); // calm resting frame
    } else {
      playing = true;
      loop();
    }
  }

  function stop() { playing = false; cancelAnimationFrame(rafId); }

  function getSheetDataURL(phase) {
    return generateSheet(phase || currentPhase || 'follicular').toDataURL('image/png');
  }

  // tiny generated favicon: a single small womb-heart frame
  function favicon() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.save();
    ctx.translate(-CELL / 2 * 0.32 + 32, -CELL / 2 * 0.32 + 30 - 3);
    ctx.scale(0.32, 0.32);
    drawFrame(ctx, 0.16, PALETTES.menstrual);
    ctx.restore();
    return c.toDataURL('image/png');
  }

  return { mount, setPhase, stop, getSheetDataURL, favicon, PALETTES };
})();
