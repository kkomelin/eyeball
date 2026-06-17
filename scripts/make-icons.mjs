// Generates the static brand icons (icons/icon{16,32,48,128}.png) with zero
// dependencies. The eye is drawn analytically (4x4 supersampled) into an
// RGBA buffer and encoded as PNG using Node's built-in zlib. Run:
//   npm run icons
//
// The brand icon is a single forward-looking eye - centered pupil, slate-blue
// iris, with a tiny specular highlight on the upper-left. Iris detail (a
// faint radial pattern) appears only at 48+ px so the 16/32 px icons stay
// clean. Geometry constants mirror eye.js so the brand and the runtime
// sprites read as the same eye.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------- Palette (matches eye.js) ----------
const SCLERA_HI = [246, 244, 234];   // top-of-disc highlight
const SCLERA_LO = [231, 225, 201];   // bottom-of-disc shading
const IRIS_HI = [90, 122, 146];      // iris upper-left highlight
const IRIS_LO = [62, 90, 110];       // iris outer color
const IRIS_DETAIL = [40, 64, 84];    // faint radial lines (48+ only)
const PUPIL = [26, 31, 42];
const HILITE = [255, 255, 255];
const RING = [150, 160, 180];

// ---------- Geometry (matches eye.js GEOM) ----------
const GEOM = {
  discR: 0.46,
  ringW: 0.05,
  irisR: 0.55,    // fraction of disc radius
  pupilR: 0.50,   // fraction of iris radius
  hiliteR: 0.20,  // fraction of iris radius
  hiliteOffX: -0.45,
  hiliteOffY: -0.45,
};

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [
  lerp(c1[0], c2[0], t),
  lerp(c1[1], c2[1], t),
  lerp(c1[2], c2[2], t),
];
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Returns [r,g,b,a] for a single pixel sample, or null for transparent.
function sample(px, py, size) {
  const cx = size / 2;
  const cy = size / 2;
  const R = size * GEOM.discR;
  const dx = px - cx;
  const dy = py - cy;
  const dist = Math.hypot(dx, dy);
  if (dist > R) return null;

  const ringW = Math.max(1, size * GEOM.ringW);
  if (dist >= R - ringW * 0.5) {
    // Antialiased ring edge: blend the ring color in where the outline sits.
    const t = clamp01((dist - (R - ringW * 0.5)) / ringW + 0.5);
    // Outside the disc but within the ring band -> ring; inside the band ->
    // blend ring over whatever is underneath. Simpler approach: the ring sits
    // on top, so just paint ring where dist > R - ringW.
    if (dist >= R - ringW) return [...RING, 255];
  }

  // Iris (centered).
  const irisR = R * GEOM.irisR;
  if (dist <= irisR) {
    return sampleIris(dx, dy, dist, irisR, size);
  }

  // Sclera with soft vertical shading.
  const ny = (dy + R) / (2 * R); // 0 at top, 1 at bottom
  const col = mix(SCLERA_HI, SCLERA_LO, clamp01(ny));
  return [...col, 255];
}

function sampleIris(dx, dy, dist, irisR, size) {
  const pupilR = irisR * GEOM.pupilR;
  if (dist <= pupilR) {
    // Specular highlight inside the pupil region: tiny white dot offset
    // up-left from the iris center.
    const hR = irisR * GEOM.hiliteR;
    const hx = irisR * GEOM.hiliteOffX;
    const hy = irisR * GEOM.hiliteOffY;
    const hd = Math.hypot(dx - hx, dy - hy);
    if (hd <= hR) {
      const t = clamp01(hd / hR);
      return [...mix(HILITE, [220, 220, 220], t), 255];
    }
    return [...PUPIL, 255];
  }

  // Iris ring: radial gradient from a brighter upper-left to a darker outer
  // edge. The gradient origin is offset toward the highlight for a soft
  // spherical feel.
  const ox = irisR * 0.3;
  const oy = irisR * 0.3;
  const od = Math.hypot(dx + ox, dy + oy);
  const t = clamp01(od / (irisR * 1.4));
  let col = mix(IRIS_HI, IRIS_LO, t);

  // Faint radial detail at 48+ px: gentle angular variation.
  if (size >= 48) {
    const angle = Math.atan2(dy, dx);
    const ripple = 0.5 + 0.5 * Math.cos(angle * 8); // 8 soft ribs
    col = mix(col, IRIS_DETAIL, 0.06 * ripple);
  }
  return [...col, 255];
}

function drawIcon(size) {
  const SS = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rr = 0, gg = 0, bb = 0, aa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const c = sample(px, py, size);
          if (c) {
            rr += c[0];
            gg += c[1];
            bb += c[2];
            aa += c[3];
          }
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      const covered = aa / 255;
      buf[i] = covered ? Math.round(rr / covered) : 0;
      buf[i + 1] = covered ? Math.round(gg / covered) : 0;
      buf[i + 2] = covered ? Math.round(bb / covered) : 0;
      buf[i + 3] = Math.round(aa / n);
    }
  }
  return buf;
}

// ---------- Minimal PNG encoder (RGBA, 8-bit) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // None filter
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(join(ROOT, "icons"), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, drawIcon(size));
  const out = join(ROOT, "icons", `icon${size}.png`);
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes)`);
}
