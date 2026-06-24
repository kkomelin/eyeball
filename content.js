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
  // browser chrome at the TOP-RIGHT, above and to the right of the page. We
  // anchor the virtual eye a little above the top edge (EYE_ABOVE_FRAC) and
  // near the right edge (EYE_X_FRAC). Because every cursor on the page is then
  // below-and-to-the-left of the eye, the gaze always points down / down-left
  // TOWARD the cursor - the eye fixates it like a human eye doing smooth
  // pursuit. As the cursor approaches the icon (top-right) the eye keeps
  // looking right at it, converging toward straight-down, instead of looking
  // up/away or veering off to the side.
  const EYE_ABOVE_FRAC = 0.25; // eye height above the viewport top, as a fraction of viewport height. Smaller = turns more sharply to follow; larger = calmer, flatter gaze.
  const EYE_X_FRAC = 1.0;      // eye horizontal position as a fraction of width; 1 = right edge, where Chrome's toolbar icons live. Lower it if your icon is pinned further left.

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
      port.onDisconnect.addListener(() => { port = null; });
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
    const dx = x - w * EYE_X_FRAC; // eye is near the right edge, so cursors are to its left (dx <= 0) or straight below
    const dy = y + eyeAbove;       // eye sits above the top edge, so dy > 0 for any in-page cursor -> always looks down
    const angle = Math.atan2(dy, dx);
    // The eye stays locked on the cursor: full fixation, never drifting back
    // to the neutral/centered pose while the cursor is on the page. (mag is
    // effectively binary at icon size - any value above the centering
    // threshold renders the pupil fully toward the cursor - so we send 1 to
    // guarantee the eye keeps following everywhere, including near the top.
    // It only re-centers on tabs with no content script, which the service
    // worker handles separately.)
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
})();
