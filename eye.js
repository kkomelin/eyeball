// Eyeball - shared pure helpers used by the service worker and dev preview.
// Pure functions only: no `chrome`, no DOM at the module level. The toolbar
// disc is rendered to OffscreenCanvas -> ImageData and handed to
// `chrome.action.setIcon` - no popup, no SVG path, pure toolbar experiment.

// ---------- Palette ----------
// The eye is themeable: every drawing routine reads its colors off a palette
// object rather than module-level constants, so the same geometry renders in
// either the calm daytime look or the tired, bloodshot-white night look. `DAY`
// is the default everywhere, which keeps the dev preview and any old callers working.
//
// DAY: a warm near-white sclera with a calm slate-blue iris, tuned to read on
// both light and dark toolbars.
export const DAY = {
  SCLERA: "#f6f4ea",            // eye white - warm near-white
  SCLERA_SHADE: "#e7e1c9",      // sclera shading toward the lower-right
  CLOSED_FILL: "#e7e1c9",       // closed-eye disc fill - kept independent of the open-eye sclera
  IRIS: "#3e5a6e",              // calm slate-blue iris, reads on both light and dark toolbars
  IRIS_HILITE: "#5a7a92",       // iris top highlight
  PUPIL: "#1a1f2a",             // near-black pupil
  HILITE: "#ffffff",            // small specular highlight on the iris
  LID: "#3a4054",               // closed-eye line / shading
  RING: "rgba(150,160,180,0.5)", // outline so the disc reads on any toolbar tint
};

// NIGHT: a tired, bloodshot eye - the look of working late. Real eyes don't
// change iris color at night; the *white* reddens as the surface vessels dilate.
// So night mode is just DAY with a pink-red sclera that pools to a deeper,
// veiny red toward the lower-right. Everything else - iris, pupil, lid, and the
// closed-eye disc (CLOSED_FILL, inherited from DAY) - is unchanged, so the
// sleeping/blinking eye looks identical day or night.
export const NIGHT = {
  ...DAY,
  SCLERA: "#f6e1dc",            // tired white - faint pink-red instead of cream
  SCLERA_SHADE: "#dca9a0",      // bloodshot pooling toward the lower-right
};

// ---------- Direction quantization ----------
// 16 directional pupil positions + a centered pose + a closed pose. At icon
// size the pupil only has a few pixels of travel, so 16 buckets is more than
// the eye can visually distinguish - but it makes the wrap-around at 0 / 2pi
// invisible.
export const BUCKET_COUNT = 16;
export const BUCKET_CENTER = "c";
export const BUCKET_CLOSED = "x";

// Map a continuous angle (radians, atan2 convention) to a 0..BUCKET_COUNT-1
// integer bucket. mag below MIN_MAG snaps to "centered".
const MIN_MAG = 0.08;
export function angleToBucket(angle, mag) {
  if (mag == null || mag < MIN_MAG) return BUCKET_CENTER;
  const step = (2 * Math.PI) / BUCKET_COUNT;
  // Normalize to [0, 2pi) and round to the nearest bucket center.
  let a = angle % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return Math.round(a / step) % BUCKET_COUNT;
}

export function bucketToAngle(b) {
  if (b === BUCKET_CENTER || b === BUCKET_CLOSED) return 0;
  const step = (2 * Math.PI) / BUCKET_COUNT;
  return b * step;
}

// ---------- Eye geometry ----------
// All measurements are fractions of the disc radius R, so the same numbers
// drive both the canvas raster and the SVG popup. Tweaking these here keeps
// the two renderings in sync.
export const GEOM = {
  discR: 0.46,        // outer disc radius as a fraction of icon size
  ringW: 0.05,        // outline thickness as a fraction of icon size
  irisR: 0.55,        // iris radius as a fraction of disc radius
  pupilR: 0.50,       // pupil radius as a fraction of iris radius
  hiliteR: 0.20,      // highlight dot radius as a fraction of iris radius
  hiliteOffX: -0.45,  // highlight offset (fraction of iris radius)
  hiliteOffY: -0.45,
  travel: 0.42,       // max pupil travel as a fraction of disc radius (keeps iris fully inside the sclera)
  lidThick: 0.10,     // closed-eye line thickness as a fraction of disc radius
};

// Returns the iris center in pixel coords for a given pose.
// state = { kind: 'open' | 'closed', angle?: number, mag?: number }
export function irisCenter(state, cx, cy, discR) {
  if (state.kind !== "open" || !state.mag) return { x: cx, y: cy };
  const r = discR * GEOM.travel;
  const m = Math.min(1, Math.max(0, state.mag));
  return {
    x: cx + Math.cos(state.angle) * r * m,
    y: cy + Math.sin(state.angle) * r * m,
  };
}

// ---------- Canvas drawer ----------
// ctx is any Canvas-2D-compatible context (HTMLCanvas, OffscreenCanvas).
// Draws into the [0, size] x [0, size] region. Caller is responsible for
// clearing the canvas first if needed. `theme` is a palette object (DAY/NIGHT);
// it defaults to DAY so existing callers keep their original look.
export function drawEye(ctx, size, state, theme = DAY) {
  const cx = size / 2;
  const cy = size / 2;
  const R = size * GEOM.discR;

  if (state.kind === "closed") {
    drawClosedEye(ctx, cx, cy, R, size, theme);
    return;
  }

  // Sclera disc (with soft vertical shading: lighter top, slightly cooler bottom).
  const grad = ctx.createLinearGradient(cx, cy - R, cx, cy + R);
  grad.addColorStop(0, theme.SCLERA);
  grad.addColorStop(1, theme.SCLERA_SHADE);
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.fillStyle = grad;
  ctx.fill();

  // Iris.
  const { x: ix, y: iy } = irisCenter(state, cx, cy, R);
  const irisR = R * GEOM.irisR;
  const iGrad = ctx.createRadialGradient(
    ix - irisR * 0.3,
    iy - irisR * 0.3,
    irisR * 0.1,
    ix,
    iy,
    irisR,
  );
  iGrad.addColorStop(0, theme.IRIS_HILITE);
  iGrad.addColorStop(1, theme.IRIS);
  ctx.beginPath();
  ctx.arc(ix, iy, irisR, 0, 2 * Math.PI);
  ctx.fillStyle = iGrad;
  ctx.fill();

  // Pupil.
  const pupilR = irisR * GEOM.pupilR;
  ctx.beginPath();
  ctx.arc(ix, iy, pupilR, 0, 2 * Math.PI);
  ctx.fillStyle = theme.PUPIL;
  ctx.fill();

  // Specular highlight.
  const hR = irisR * GEOM.hiliteR;
  if (hR >= 0.6) {
    ctx.beginPath();
    ctx.arc(
      ix + irisR * GEOM.hiliteOffX,
      iy + irisR * GEOM.hiliteOffY,
      hR,
      0,
      2 * Math.PI,
    );
    ctx.fillStyle = theme.HILITE;
    ctx.fill();
  }

  // Outline ring (last, so it sits cleanly on top).
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.lineWidth = Math.max(1, size * GEOM.ringW);
  ctx.strokeStyle = theme.RING;
  ctx.stroke();
}

function drawClosedEye(ctx, cx, cy, R, size, theme = DAY) {
  // A faint sclera ghost so the closed eye still has a disc silhouette, then a
  // thick horizontal lid line across the middle. Reads as a sleeping eye at
  // icon size.
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.fillStyle = theme.CLOSED_FILL;
  ctx.fill();

  ctx.beginPath();
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(1.5, R * GEOM.lidThick);
  ctx.strokeStyle = theme.LID;
  const armR = R * 0.78;
  // Slight downward curve so the lid reads as a sleepy crescent.
  ctx.moveTo(cx - armR, cy);
  ctx.quadraticCurveTo(cx, cy + R * 0.18, cx + armR, cy);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.lineWidth = Math.max(1, size * GEOM.ringW);
  ctx.strokeStyle = theme.RING;
  ctx.stroke();
}

// ---------- Sprite atlas ----------
// Pre-render every pose to ImageData so the runtime hot-path is just a
// `chrome.action.setIcon({imageData})` call - no per-frame canvas work, in
// line with the docs' "setIcon is for static images" guidance.
//
// Returns an object keyed by bucket ID (0..N-1, "c", "x") whose values are
// `{ [size]: ImageData }` ready to hand to `setIcon`. `theme` selects the
// palette (DAY/NIGHT); build one atlas per theme up front and swap between them.
export function buildAtlas(makeCanvas, sizes = [16, 32], theme = DAY) {
  const out = {};
  const poses = [];
  poses.push({ id: BUCKET_CENTER, state: { kind: "open", angle: 0, mag: 0 } });
  poses.push({ id: BUCKET_CLOSED, state: { kind: "closed" } });
  for (let i = 0; i < BUCKET_COUNT; i++) {
    poses.push({
      id: i,
      state: { kind: "open", angle: bucketToAngle(i), mag: 1 },
    });
  }
  for (const { id, state } of poses) {
    out[id] = {};
    for (const size of sizes) {
      const canvas = makeCanvas(size, size);
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, size, size);
      drawEye(ctx, size, state, theme);
      out[id][size] = ctx.getImageData(0, 0, size, size);
    }
  }
  return out;
}

// ---------- Cursor -> pose (centered reference) ----------
// Convert a cursor position within a viewport (or any rectangular region) to
// an (angle, mag) pose, measured from the region's CENTER. mag is normalized so
// a corner gives mag = 1 (clamped). Handy as a generic "look toward the cursor"
// mapping; the live toolbar uses gazeToward() below instead, which anchors the
// eye where the icon actually sits.
export function cursorToPose(x, y, w, h) {
  const dx = x - w / 2;
  const dy = y - h / 2;
  const angle = Math.atan2(dy, dx);
  const norm = Math.min(w, h) * 0.5;
  const mag = norm > 0 ? Math.min(1, Math.hypot(dx, dy) / norm) : 0;
  return { angle, mag };
}

// ---------- Cursor -> gaze (toolbar-eye geometry) ----------
// The live eye is the toolbar ICON, sitting in the browser chrome above the
// TOP-RIGHT of the page - not at the page's center. This maps a cursor at
// (x, y) in a w x h viewport to the (angle, mag) gaze of an eye anchored at
// that off-screen spot, so the pupil fixates the cursor wherever it roams:
// down-left, straight-down, or down-RIGHT. Like a human eye, it keeps the
// target on the fovea (smooth pursuit) and stays converged on it as it nears,
// rather than ever losing it or looking away.
//
//   eyeXFrac     - the eye's horizontal column as a fraction of width (where
//                  the icon sits). Cursors right of it read dx > 0 -> look right.
//   eyeAboveFrac - how far above the top edge the eye floats, as a fraction of
//                  height. Keeps dy > 0 for every in-page cursor, so the gaze is
//                  always downward (the eye never looks up, away from the page).
//                  Keep it small - about the real toolbar's offset above the
//                  page. Too large parks the virtual eye far above the real
//                  icon, so as the cursor climbs toward the top the gaze slides
//                  straight down instead of staying ON the cursor.
//
// mag is pinned to full fixation (1): at icon size pupil travel is effectively
// binary, and we want the eye locked on the cursor everywhere, never drifting
// back to neutral while the cursor is live.
//
// This is the reference implementation. content.js inlines the identical math
// (MV3 content scripts can't import this module) - keep the two in sync.
export function gazeToward(x, y, w, h, eyeXFrac = 0.85, eyeAboveFrac = 0.08) {
  const dx = x - w * eyeXFrac;     // < 0 left of the icon, > 0 right of it
  const dy = y + h * eyeAboveFrac; // > 0 for any in-page cursor -> always downward
  return { angle: Math.atan2(dy, dx), mag: 1 };
}

// ---------- Night mode schedule ----------
// Hardcoded window for the time-based night look: tired eye from 21:00 until
// 06:00 the next morning. Edit these two constants to reschedule.
export const NIGHT_START_HOUR = 21;
export const NIGHT_END_HOUR = 6;

// True when `hour` (0..23) falls inside the night window [startHour, endHour).
// The window may wrap past midnight (e.g. 17 -> 6 covers evening + early morning).
// A zero-length window (start === end) means "never night".
export function isNightTime(hour, startHour, endHour) {
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour; // wraps midnight
}
