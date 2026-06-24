// Run with: npm test  (or: node --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUCKET_COUNT,
  BUCKET_CENTER,
  BUCKET_CLOSED,
  angleToBucket,
  bucketToAngle,
  cursorToPose,
  gazeToward,
  irisCenter,
  GEOM,
  isNightTime,
} from "../eye.js";

test("angleToBucket snaps to centered for tiny magnitudes", () => {
  assert.equal(angleToBucket(0, 0), BUCKET_CENTER);
  assert.equal(angleToBucket(Math.PI / 3, 0.05), BUCKET_CENTER);
});

test("angleToBucket wraps cleanly around 0/2pi", () => {
  const a = angleToBucket(0, 1);
  const b = angleToBucket(2 * Math.PI - 1e-6, 1);
  // The two ends of the circle should land on the same bucket.
  assert.equal(a, b);
});

test("angleToBucket returns a finite bucket for each cardinal direction", () => {
  for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const b = angleToBucket(angle, 1);
    assert.ok(Number.isInteger(b) && b >= 0 && b < BUCKET_COUNT, `bucket for ${angle} = ${b}`);
  }
});

test("bucketToAngle round-trips through angleToBucket", () => {
  for (let i = 0; i < BUCKET_COUNT; i++) {
    const a = bucketToAngle(i);
    assert.equal(angleToBucket(a, 1), i, `bucket ${i} round-trip`);
  }
});

test("cursorToPose centers a centered cursor with zero magnitude", () => {
  const { mag } = cursorToPose(500, 300, 1000, 600);
  assert.ok(mag < 1e-9);
});

test("cursorToPose returns angle pointing toward the cursor", () => {
  // Cursor to the right of center: angle ~0.
  const { angle, mag } = cursorToPose(750, 300, 1000, 600);
  assert.ok(Math.abs(angle) < 1e-9);
  assert.ok(mag > 0);
});

test("cursorToPose clamps magnitude to <= 1", () => {
  const { mag } = cursorToPose(99999, 99999, 1000, 600);
  assert.equal(mag, 1);
});

// gazeToward: the toolbar-eye geometry. The eye is anchored above the
// top-right, so it always looks DOWN, leaning left/right toward the cursor.
// Canvas convention: cos(angle) > 0 means the pupil moves right, sin(angle) > 0
// means it moves down.
test("gazeToward looks RIGHT when the cursor is right of the icon column", () => {
  // w=1000, eyeXFrac=0.85 -> column at x=850. Cursor well to its right.
  const { angle, mag } = gazeToward(950, 100, 1000, 600);
  assert.ok(Math.cos(angle) > 0, `expected rightward pupil, cos=${Math.cos(angle)}`);
  assert.ok(Math.sin(angle) > 0, "expected downward pupil");
  assert.equal(mag, 1);
});

test("gazeToward looks LEFT when the cursor is left of the icon column", () => {
  const { angle } = gazeToward(100, 100, 1000, 600);
  assert.ok(Math.cos(angle) < 0, `expected leftward pupil, cos=${Math.cos(angle)}`);
  assert.ok(Math.sin(angle) > 0, "expected downward pupil");
});

test("gazeToward looks straight DOWN when the cursor is under the icon column", () => {
  const { angle } = gazeToward(850, 300, 1000, 600); // x exactly at 0.85*w
  assert.ok(Math.abs(Math.cos(angle)) < 1e-9, `expected no horizontal lean, cos=${Math.cos(angle)}`);
  assert.ok(Math.sin(angle) > 0, "expected downward pupil");
});

test("gazeToward never looks up: every in-page cursor yields a downward gaze", () => {
  const w = 1280, h = 800;
  for (let gx = 0; gx <= 10; gx++) {
    for (let gy = 0; gy <= 10; gy++) {
      const { angle } = gazeToward((gx / 10) * w, (gy / 10) * h, w, h);
      assert.ok(Math.sin(angle) > 0, `cursor (${gx},${gy}) gazed upward: sin=${Math.sin(angle)}`);
    }
  }
});

test("gazeToward stays at full fixation (mag = 1) everywhere", () => {
  assert.equal(gazeToward(0, 0, 1000, 600).mag, 1);
  assert.equal(gazeToward(1000, 600, 1000, 600).mag, 1);
  assert.equal(gazeToward(500, 300, 1000, 600).mag, 1);
});

test("irisCenter stays inside the disc", () => {
  const size = 32;
  const cx = size / 2;
  const cy = size / 2;
  const R = size * GEOM.discR;
  const irisR = R * GEOM.irisR;
  for (let i = 0; i < BUCKET_COUNT; i++) {
    const { x, y } = irisCenter(
      { kind: "open", angle: bucketToAngle(i), mag: 1 },
      cx,
      cy,
      R,
    );
    const distFromCenter = Math.hypot(x - cx, y - cy);
    // Iris edge must stay strictly inside the disc.
    assert.ok(
      distFromCenter + irisR <= R + 1e-9,
      `bucket ${i}: iris edge ${distFromCenter + irisR} > disc ${R}`,
    );
  }
});

test("irisCenter is at the disc center for the centered pose", () => {
  const { x, y } = irisCenter({ kind: "open", angle: 0, mag: 0 }, 16, 16, 8);
  assert.equal(x, 16);
  assert.equal(y, 16);
});

test("BUCKET_CLOSED is distinct from BUCKET_CENTER and from numeric buckets", () => {
  assert.notEqual(BUCKET_CLOSED, BUCKET_CENTER);
  for (let i = 0; i < BUCKET_COUNT; i++) {
    assert.notEqual(BUCKET_CLOSED, i);
    assert.notEqual(BUCKET_CENTER, i);
  }
});

test("isNightTime handles a window that wraps past midnight", () => {
  // Evening and early morning are night; daytime is not.
  assert.equal(isNightTime(21, 21, 6), true);  // start hour is inclusive
  assert.equal(isNightTime(23, 21, 6), true);
  assert.equal(isNightTime(0, 21, 6), true);
  assert.equal(isNightTime(5, 21, 6), true);
  assert.equal(isNightTime(6, 21, 6), false); // end hour is exclusive
  assert.equal(isNightTime(7, 21, 6), false);
  assert.equal(isNightTime(20, 21, 6), false);
});

test("isNightTime handles a same-day window", () => {
  assert.equal(isNightTime(9, 9, 17), true);
  assert.equal(isNightTime(12, 9, 17), true);
  assert.equal(isNightTime(17, 9, 17), false); // exclusive end
  assert.equal(isNightTime(8, 9, 17), false);
  assert.equal(isNightTime(20, 9, 17), false);
});

test("isNightTime with a zero-length window (start === end) is never night", () => {
  for (let h = 0; h < 24; h++) {
    assert.equal(isNightTime(h, 12, 12), false, `hour ${h}`);
  }
});
