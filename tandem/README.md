# Tandem 💞 — cycle tracking for two

A web-based period tracking app **built for couples**, generated from two DESIGN.md files in this repository. Mobile-first, zero dependencies, zero build step — open `index.html` and go.

```bash
cd tandem && python3 -m http.server 8080
# → http://localhost:8080  (or just open index.html directly)
```

## The two DESIGN.md sources

| Source | What it contributes |
|---|---|
| [`design-md/airbnb/DESIGN.md`](../design-md/airbnb/DESIGN.md) | The **Rausch** voltage (`#ff385c`) on every CTA and the heart itself, pill shapes, 14px soft cards, the single Airbnb shadow tier, the circular "orb" button (reused as the center Log tab), 48px touch targets |
| [`design-md/claude/DESIGN.md`](../design-md/claude/DESIGN.md) | The warm **cream canvas** (`#faf9f5`), serif display headlines with negative tracking, cream card surfaces (`#efe9de`), teal/amber companion accents, dark-surface premium badge, editorial pacing |

## The generated spritesheet 🎞️

The heart-shaped womb on the Home tab is a real **8×8, 64-frame spritesheet** (1600×1600 px) drawn entirely in code at load time — heart body with gradient fill, fallopian arms with fimbriae, ovaries with follicle dots, pulsing inner lining, glow, pulse rings and orbiting sparkles. A double-pulse *lub-dub* heartbeat curve is baked into the frames; playback steps through the sheet with `requestAnimationFrame`. The palette and heart rate shift with your cycle phase (calm during menstruation, lively at ovulation).

**See it yourself:** Settings → *View generated spritesheet*.

## Features

Feature set modeled on the top-rated period trackers (Flo, Clue, and friends), split into free and paid tiers:

**Free**
- Period logging (calendar tap or one-tap on Home), predictions for the next 3 cycles
- Fertile window + ovulation estimates (luteal-phase method, configurable)
- Daily log: flow, 12 symptoms, 10 moods, sex & drive, water, sleep, notes
- Calendar with period / predicted / fertile / ovulation marking
- Cycle stats: average cycle, average period, variability, cycle-length history chart
- **Couple mode**: partner linking with invite code, partner view with phase-aware "how to support" tips, love notes between you two
- Daily phase-aware health tips

**Tandem Plus (premium — demo paywall, the trial button just unlocks it)**
- Symptom & mood pattern analysis charts
- Doctor-ready health report export + full JSON data export
- Basal body temperature (BBT) logging
- PMS early-warning shading on the calendar
- TTC mode with conception outlook
- Daily partner coaching + gesture-of-the-day

## Tabs

`Home` (clean hero: sprite + phase + one tip) · `Calendar` · `Log` (center orb) · `Insights` · `Partner` — plus Settings and the paywall as bottom sheets.

## Motion practices

- Only `transform` and `opacity` are animated; durations 160–420 ms on `cubic-bezier(.2,.8,.2,1)` with a spring curve for tactile presses
- Staggered entrances (45 ms steps) on tab switch; time-based sprite playback (no frame drift)
- `prefers-reduced-motion` fully respected + an in-app "Reduce motion" toggle; the sprite falls back to a calm static frame

## Privacy

Everything lives in `localStorage` on your device. Nothing is sent anywhere. This is a demo — not medical advice or contraception.
