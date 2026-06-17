// Eyeball - shared pure helpers used by the service worker and dev preview.
// Pure functions only: no `chrome`, no DOM at the module level. The toolbar
// disc is rendered to OffscreenCanvas -> ImageData and handed to
// `chrome.action.setIcon` - no popup, no SVG path, pure toolbar experiment.

// ---------- Palette ----------
// A warm near-white sclera with a calm slate-blue iris, tuned to read on both
// light and dark toolbars.
export const SCLERA = "#f6f4ea";          // eye white - warm near-white
export const SCLERA_SHADE = "#e7e1c9";    // sclera shading toward the lower-right
export const IRIS = "#3e5a6e";            // calm slate-blue iris, reads on both light and dark toolbars
export const IRIS_HILITE = "#5a7a92";     // iris top highlight
export const PUPIL = "#1a1f2a";           // near-black pupil
export const HILITE = "#ffffff";          // small specular highlight on the iris
export const LID = "#3a4054";             // closed-eye line / shading
export const RING = "rgba(150,160,180,0.5)"; // outline so the disc reads on any toolbar tint

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
// clearing the canvas first if needed.
export function drawEye(ctx, size, state) {
  const cx = size / 2;
  const cy = size / 2;
  const R = size * GEOM.discR;

  if (state.kind === "closed") {
    drawClosedEye(ctx, cx, cy, R, size);
    return;
  }

  // Sclera disc (with soft vertical shading: lighter top, slightly cooler bottom).
  const grad = ctx.createLinearGradient(cx, cy - R, cx, cy + R);
  grad.addColorStop(0, SCLERA);
  grad.addColorStop(1, SCLERA_SHADE);
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
  iGrad.addColorStop(0, IRIS_HILITE);
  iGrad.addColorStop(1, IRIS);
  ctx.beginPath();
  ctx.arc(ix, iy, irisR, 0, 2 * Math.PI);
  ctx.fillStyle = iGrad;
  ctx.fill();

  // Pupil.
  const pupilR = irisR * GEOM.pupilR;
  ctx.beginPath();
  ctx.arc(ix, iy, pupilR, 0, 2 * Math.PI);
  ctx.fillStyle = PUPIL;
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
    ctx.fillStyle = HILITE;
    ctx.fill();
  }

  // Outline ring (last, so it sits cleanly on top).
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.lineWidth = Math.max(1, size * GEOM.ringW);
  ctx.strokeStyle = RING;
  ctx.stroke();
}

function drawClosedEye(ctx, cx, cy, R, size) {
  // A faint sclera ghost so the closed eye still has a disc silhouette, then a
  // thick horizontal lid line across the middle. Reads as a sleeping eye at
  // icon size.
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.fillStyle = SCLERA_SHADE;
  ctx.fill();

  ctx.beginPath();
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(1.5, R * GEOM.lidThick);
  ctx.strokeStyle = LID;
  const armR = R * 0.78;
  // Slight downward curve so the lid reads as a sleepy crescent.
  ctx.moveTo(cx - armR, cy);
  ctx.quadraticCurveTo(cx, cy + R * 0.18, cx + armR, cy);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.lineWidth = Math.max(1, size * GEOM.ringW);
  ctx.strokeStyle = RING;
  ctx.stroke();
}

// ---------- Sprite atlas ----------
// Pre-render every pose to ImageData so the runtime hot-path is just a
// `chrome.action.setIcon({imageData})` call - no per-frame canvas work, in
// line with the docs' "setIcon is for static images" guidance.
//
// Returns an object keyed by bucket ID (0..N-1, "c", "x") whose values are
// `{ [size]: ImageData }` ready to hand to `setIcon`.
export function buildAtlas(makeCanvas, sizes = [16, 32]) {
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
      drawEye(ctx, size, state);
      out[id][size] = ctx.getImageData(0, 0, size, size);
    }
  }
  return out;
}

// ---------- Cursor -> pose ----------
// Convert a cursor position within a viewport (or any rectangular region) to
// an (angle, mag) pose. The reference point is the region's center, and mag
// is normalized so a corner gives mag = 1 (clamped).
export function cursorToPose(x, y, w, h) {
  const dx = x - w / 2;
  const dy = y - h / 2;
  const angle = Math.atan2(dy, dx);
  const norm = Math.min(w, h) * 0.5;
  const mag = norm > 0 ? Math.min(1, Math.hypot(dx, dy) / norm) : 0;
  return { angle, mag };
}
