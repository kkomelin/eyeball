// Eyeball - content script.
// Throttles mousemove to ~10 Hz and posts viewport-relative (angle, mag) to
// the service worker over a long-lived Port. Also relays window blur/focus
// and tab visibility so the SW can drive its open/sleeping states.
//
// Not a module: content scripts can't be ES modules under MV3. We inline a
// tiny pose helper here rather than try to share eye.js via importScripts.

(() => {
  // Skip in non-top frames - the SW only needs one gaze stream per tab, and
  // child iframes would race for it.
  if (window.top !== window) return;

  const THROTTLE_MS = 33; // ~30 Hz - feels responsive; the SW caps setIcon further.

  // Virtual eye position: where the toolbar icon physically sits - up in the
  // browser chrome at the TOP-RIGHT, a little above the page. We anchor the
  // virtual eye a bit above the top edge (EYE_ABOVE_FRAC) and at the icon's
  // horizontal column (EYE_X_FRAC). The gaze vector runs from this anchor to
  // the cursor, so the eye fixates the cursor like a human eye in smooth
  // pursuit - and stays locked on as the cursor moves in close, the way both
  // our eyes converge on an object approaching the face. Because the anchor
  // sits ABOVE the page the cursor is always below it, so the eye only ever
  // looks DOWNward - but it leans down-LEFT or down-RIGHT depending on which
  // side of the icon's column the cursor is on. Cursor left of the column ->
  // look left; right of it -> look right; straight below -> look straight down.
  //
  // EYE_ABOVE_FRAC is kept small on purpose - roughly where the real toolbar
  // floats above the page. If it's too large the virtual eye sits far above the
  // real icon, so as the cursor climbs toward the top the gaze keeps sliding
  // straight down instead of staying ON the cursor (it "drops" off the target
  // just as the cursor gets close). Small keeps the eye pointing right at the
  // cursor up to the top edge, and turning sharply there - the way your eye
  // swings to stay locked on something moving in close.
  const EYE_ABOVE_FRAC = 0.08; // eye height above the viewport top, as a fraction of viewport height (about the real toolbar offset). Larger = calmer but drifts downward off the cursor up close; smaller = sharper, truer tracking but twitchy along the very top.
  const EYE_X_FRAC = 0.85;     // eye's horizontal column as a fraction of width, where the toolbar icon roughly sits. Cursors right of it make the eye look right; left of it, left. Nudge toward 1.0 if your icon is pinned hard against the right edge, lower if it sits further left.

  // A long-lived Port carries gaze/focus events to the service worker. The MV3
  // catch: the SW idles out after ~30s of quiet, which kills this port - and the
  // content-side `onDisconnect` is not guaranteed to fire, so we can end up
  // holding a *dead* port whose `postMessage` neither throws nor delivers. That is
  // the "eye freezes and never recovers" bug: gaze is dropped silently forever.
  //
  // Guard against it two ways: rebuild a port that has been quiet long enough that
  // the SW may have idled out underneath it, and tear the port down on any send
  // failure. We deliberately do NOT ping on a timer - that would pin the SW alive
  // against its idle-out design. Reconnecting lazily on the next real event (a
  // mouse move, a focus change) is enough to recover, and a fresh connect wakes
  // the SW anyway.
  let port = null;
  let lastContactAt = 0; // last time we sent or received anything on `port`
  const PORT_STALE_MS = 20000; // treat as stale past this; SW idles out around 30s

  function teardownPort() {
    if (port) {
      try { port.disconnect(); } catch { /* already gone */ }
    }
    port = null;
  }

  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: "eyeball" });
      lastContactAt = Date.now();
      // Any inbound message (the SW's "hello" ack) proves the port is live and
      // refreshes the staleness clock.
      port.onMessage.addListener(() => { lastContactAt = Date.now(); });
      // Read chrome.runtime.lastError so a bfcache-induced channel close
      // (Chrome 123+ severs open ports when the page is cached) isn't logged as
      // an "Unchecked runtime.lastError". See the back/forward cache section below.
      port.onDisconnect.addListener(() => { void chrome.runtime.lastError; port = null; });
    } catch {
      // chrome.runtime is gone - an orphaned content script after an extension
      // reload/update. Nothing to reconnect to; a tab reload re-injects us fresh.
      port = null;
    }
    return port;
  }

  function ensurePort() {
    // Rebuild when we have no port, or when the current one has gone quiet long
    // enough that the SW may have died underneath it. The rebuild is cheap and
    // idempotent, so erring toward reconnecting is safe.
    if (!port || Date.now() - lastContactAt > PORT_STALE_MS) {
      teardownPort();
      return connectPort();
    }
    return port;
  }

  function send(msg) {
    const p = ensurePort();
    if (!p) return;
    try {
      p.postMessage(msg);
      lastContactAt = Date.now();
    } catch {
      // The port was dead after all - drop it so the next event reconnects.
      teardownPort();
    }
  }

  // ---------- mousemove -> pose ----------
  let lastSent = 0;
  let pending = null;
  let flushTimer = null;

  function flush() {
    flushTimer = null;
    if (!pending) return;
    const { x, y } = pending;
    pending = null;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w <= 0 || h <= 0) return;
    const eyeAbove = h * EYE_ABOVE_FRAC;
    // Signed horizontal offset: cursor left of the icon's column -> dx < 0 (eye
    // looks left), right of it -> dx > 0 (eye looks right), under it -> dx == 0.
    const dx = x - w * EYE_X_FRAC;
    const dy = y + eyeAbove;       // eye sits above the top edge, so dy > 0 for any in-page cursor -> always looks down
    const angle = Math.atan2(dy, dx); // down-left .. straight-down .. down-right
    // The eye stays locked on the cursor: full fixation, never drifting back
    // to the neutral/centered pose while the cursor is on the page. (mag is
    // effectively binary at icon size - any value above the centering
    // threshold renders the pupil fully toward the cursor - so we send 1 to
    // guarantee the eye keeps following everywhere, on either side and near
    // the top. It only re-centers on tabs with no content script, which the
    // service worker handles separately.)
    const mag = 1;
    lastSent = Date.now();
    send({ type: "gaze", angle, mag });
  }

  window.addEventListener(
    "mousemove",
    (e) => {
      pending = { x: e.clientX, y: e.clientY };
      const now = Date.now();
      const wait = Math.max(0, THROTTLE_MS - (now - lastSent));
      if (flushTimer) return;
      if (wait === 0) flush();
      else flushTimer = setTimeout(flush, wait);
    },
    { passive: true },
  );

  // ---------- Focus / visibility ----------
  window.addEventListener("blur", () => send({ type: "blur" }), { passive: true });
  window.addEventListener("focus", () => send({ type: "focus" }), { passive: true });
  document.addEventListener(
    "visibilitychange",
    () => send({ type: document.hidden ? "hidden" : "visible" }),
    { passive: true },
  );

  // ---------- Back/forward cache ----------
  // Chrome 123+ closes an open extension Port when the page is frozen into the
  // bfcache, and logs "Unchecked runtime.lastError: The page keeping the
  // extension port is moved into back/forward cache..." against the surviving
  // end (the service worker). Get ahead of it: drop the Port as the page is
  // hidden so Chrome severs nothing, and re-establish it when the page is
  // restored from the cache so gaze resumes without waiting for the first
  // mousemove. This mirrors the lazy-reconnect design - it just makes the
  // bfcache round-trip explicit instead of relying on the next event.
  window.addEventListener("pagehide", () => teardownPort(), { passive: true });
  window.addEventListener(
    "pageshow",
    (e) => {
      if (!e.persisted) return; // a fresh load reconnects lazily on the first event
      teardownPort();           // defensive: ensure no stale port survives the round-trip
      connectPort();
      // Resync the SW's focus/visibility view for the just-restored page.
      send({ type: document.hidden ? "hidden" : "visible" });
    },
    { passive: true },
  );
})();
