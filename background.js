// Eyeball - background service worker (Manifest V3).
// Pre-renders an eye-pose sprite atlas at startup, then dispatches setIcon
// only when the active pose changes. No per-frame canvas work, no network,
// no storage. The sprite atlases live in module memory; if the service worker
// is terminated they are rebuilt on the next event (cheap - ~36 small canvas
// draws per theme).

import {
  buildAtlas,
  angleToBucket,
  BUCKET_CENTER,
  BUCKET_CLOSED,
  DAY,
  NIGHT,
  isNightTime,
  NIGHT_START_HOUR,
  NIGHT_END_HOUR,
} from "./eye.js";

const ICON_SIZES = [16, 32];

// theme name -> (bucket id ("c", "x", 0..15) -> { 16: ImageData, 32: ImageData }).
// Both palettes are pre-rendered eagerly at module init so switching between the
// day and night look at sundown is a zero-cost atlas swap, and the first gaze
// after a service-worker cold-start doesn't wait for canvas draws.
const mk = (w, h) => new OffscreenCanvas(w, h);
const atlases = {
  day: buildAtlas(mk, ICON_SIZES, DAY),
  night: buildAtlas(mk, ICON_SIZES, NIGHT),
};

// ---------- Theme (day / night) ----------
// The eye has two palettes. `theme` picks which atlas setBucket draws from.
// It's driven purely by the local clock against a configurable schedule - see
// the night-mode section below. Starts on a synchronously-computed value so the
// very first icon paint already matches the time of day (no day->night flash).
let theme = "day";

// ---------- Pose dispatch ----------
let currentBucket = null;
let lastSetIconAt = 0;
const SET_ICON_MIN_GAP_MS = 16; // Hard cap on setIcon rate (~60 Hz max).

function setBucket(bucket, { force = false } = {}) {
  if (!force && bucket === currentBucket) return;
  const now = Date.now();
  if (!force && now - lastSetIconAt < SET_ICON_MIN_GAP_MS) return;
  const imageData = atlases[theme][bucket];
  if (!imageData) return;
  currentBucket = bucket;
  lastSetIconAt = now;
  chrome.action.setIcon({ imageData }).catch(() => {
    // Ignore: tabs can close between dispatch and apply.
  });
}

// Switch palettes and immediately repaint the current pose in the new colors.
function setTheme(next) {
  if (next === theme || !atlases[next]) return;
  theme = next;
  // Re-render whatever the eye is currently showing, bypassing the "same
  // bucket" short-circuit and the rate cap so the swap is instant.
  if (currentBucket != null) setBucket(currentBucket, { force: true });
}

// ---------- Night-mode schedule ----------
// The eye's white goes bloodshot/tired during the hardcoded night window
// (NIGHT_START_HOUR -> NIGHT_END_HOUR in eye.js, currently 21:00-06:00).
// Evaluation is just a local clock read, driven by the 1-minute blink alarm plus
// startup/focus events - cheap, minute-resolution, no extra timers.

// The theme the clock says we should be in right now.
function scheduledTheme() {
  const hour = new Date().getHours();
  return isNightTime(hour, NIGHT_START_HOUR, NIGHT_END_HOUR) ? "night" : "day";
}

function evaluateTheme() {
  setTheme(scheduledTheme());
}

// ---------- Mode ----------
// The eye is in exactly one of three modes:
//   'open'     - showing some open pose (tracking the cursor, or frozen at the
//                last pose if the cursor has stopped on a supported tab).
//   'sleeping' - browser window is unfocused; eye is closed.
//   'blinking' - transient one-frame closed state for a spontaneous blink.
//
// `lastOpenBucket` remembers the most recent open pose so that when we exit
// `sleeping` or `blinking`, we restore exactly where the eye was looking.
let mode = "open";
let lastOpenBucket = BUCKET_CENTER;

function setOpenPose(bucket) {
  lastOpenBucket = bucket;
  if (mode === "open") setBucket(bucket);
}

function enterSleeping() {
  mode = "sleeping";
  setBucket(BUCKET_CLOSED, { force: true });
}

function exitSleeping() {
  if (mode !== "sleeping") return;
  mode = "open";
  setBucket(lastOpenBucket, { force: true });
}

function blinkOnce() {
  if (mode !== "open") return; // don't blink while sleeping
  mode = "blinking";
  setBucket(BUCKET_CLOSED, { force: true });
  setTimeout(() => {
    if (mode !== "blinking") return; // sleeping took over during the blink
    mode = "open";
    setBucket(lastOpenBucket, { force: true });
  }, 140);
}

// ---------- Spontaneous blink ----------
// A calm human at a screen blinks irregularly, roughly every 7-13s. We run a
// self-rescheduling timer at that cadence, but ONLY while the eye is actively
// tracking (gaze arrived recently). During active tracking the gaze Port
// already keeps the service worker awake, so the loop costs nothing extra - no
// CPU to speak of (one setIcon swap every ~10s) and no added wake time. A short
// while after the cursor goes quiet the loop stops rescheduling and lets the SW
// idle out; the 1-minute alarm below is the low-cost idle heartbeat.
//
// At night the eye is tired, and a fatigued human blinks noticeably more often,
// so night mode uses a quicker cadence (~4.5-8.5s).
const BLINK_MIN_MS = 7000;
const BLINK_MAX_MS = 13000;
const NIGHT_BLINK_MIN_MS = 4500;
const NIGHT_BLINK_MAX_MS = 8500;
const BLINK_ACTIVE_WINDOW_MS = 15000; // keep blinking this long after the last gaze, then wind down
let blinkTimer = null;
let lastGazeAt = 0;

function nextBlinkDelay() {
  const min = theme === "night" ? NIGHT_BLINK_MIN_MS : BLINK_MIN_MS;
  const max = theme === "night" ? NIGHT_BLINK_MAX_MS : BLINK_MAX_MS;
  return min + Math.random() * (max - min);
}

function scheduleSpontaneousBlink() {
  if (blinkTimer != null) return; // loop already running
  const tick = () => {
    blinkTimer = null;
    // Don't keep the SW awake just to blink: stop once the cursor goes quiet.
    if (Date.now() - lastGazeAt > BLINK_ACTIVE_WINDOW_MS) return;
    blinkOnce();
    blinkTimer = setTimeout(tick, nextBlinkDelay());
  };
  blinkTimer = setTimeout(tick, nextBlinkDelay());
}

// ---------- Active tab tracking ----------
// Unsupported pages (PDFs, chrome://, Web Store) can't run a content script,
// so the eye centers on them. We used to infer "unsupported" from "the active
// tab has no connected eyeball port", but port presence is unreliable across
// service-worker restarts (portsByTab is wiped when the SW idles out) - which
// caused supported tabs to be misread as unsupported and centered on cold start.
// Instead we measure support directly from the active tab's URL.
let activeTabId = null;
const portsByTab = new Map(); // tabId -> Port

// A page is unsupported when a content script can't run and stream gaze there.
// Approximate from the URL: ordinary http/https pages are supported; chrome://,
// file://, data:, the new-tab page, the PDF viewer, and the Chrome Web Store
// (https but content-script-blocked) are not. A missing URL (no host permission,
// e.g. chrome:// tabs) also counts as unsupported, which is what we want.
function isUnsupportedUrl(url) {
  if (!url) return true;
  if (!/^https?:\/\//i.test(url)) return true;
  if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)\b/i.test(url)) return true;
  return false;
}

let centerCheckTimer = null;
function scheduleCenterCheck(delayMs = 200) {
  // Small debounce so rapid tab switches don't each fire a tabs.get; then read
  // the active tab's URL and center only if it's genuinely unsupported.
  if (centerCheckTimer) clearTimeout(centerCheckTimer);
  centerCheckTimer = setTimeout(async () => {
    centerCheckTimer = null;
    const tabId = activeTabId;
    if (tabId == null) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      // The active tab may have changed while we awaited; re-check before acting.
      if (activeTabId === tabId && isUnsupportedUrl(tab.url)) setOpenPose(BUCKET_CENTER);
    } catch {
      // Tab closed between scheduling and the check; ignore.
    }
  }, delayMs);
}

// ---------- Content-script port ----------
// Long-lived Port keeps the SW alive while the user moves the cursor, and
// avoids per-message connection setup.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "eyeball") return;
  const tabId = port.sender?.tab?.id ?? null;
  if (tabId != null) portsByTab.set(tabId, port);
  // Ack the connection. The content script uses any inbound message to confirm
  // the port is live and reset its staleness timer, so it never sits on a dead
  // port silently dropping gaze (the freeze-after-idle bug).
  try { port.postMessage({ type: "hello" }); } catch { /* tab already gone */ }

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "gaze": {
        let { angle, mag } = msg;
        if (typeof angle !== "number" || !Number.isFinite(angle)) break;
        // The eye sits above the page and fixates the cursor below it, so it
        // must never look up - that would point it away from the cursor. The
        // content script already sends only downward angles; reflect any stray
        // upward angle to its downward mirror as a defensive backstop.
        if (Math.sin(angle) < 0) angle = -angle;
        const bucket = angleToBucket(angle, mag);
        // Gaze proves the window is active and the eye should be tracking, so
        // recover from any stale non-open mode: a leftover 'sleeping', or a
        // 'blinking' whose 140ms reopen timer was lost to an SW shutdown (which
        // would otherwise keep the eye shut and ignore every gaze).
        if (mode !== "open") mode = "open";
        setOpenPose(bucket);
        // Keep the calm spontaneous-blink rhythm going while tracking.
        lastGazeAt = Date.now();
        scheduleSpontaneousBlink();
        break;
      }
      case "focus":
      case "visible":
        exitSleeping();
        break;
      // 'blur' and 'hidden' are no-ops: the eye holds its last pose.
    }
  });

  port.onDisconnect.addListener(() => {
    if (tabId != null && portsByTab.get(tabId) === port) {
      portsByTab.delete(tabId);
      // If the active tab just lost its content script (navigation to an
      // unsupported URL within the same tab, or extension reload), give the
      // new page a moment to connect; if nothing arrives, center the eye.
      if (tabId === activeTabId) scheduleCenterCheck(1500);
    }
  });
});

// ---------- Active tab change ----------
chrome.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
  scheduleCenterCheck();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  portsByTab.delete(tabId);
  if (tabId === activeTabId) activeTabId = null;
});

// ---------- Window focus ----------
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    enterSleeping();
    return;
  }
  exitSleeping();
  evaluateTheme(); // a refocus may straddle the day/night boundary
  try {
    const tabs = await chrome.tabs.query({ active: true, windowId });
    if (tabs[0]) {
      activeTabId = tabs[0].id;
      scheduleCenterCheck();
    }
  } catch {
    // Ignore - the focused window may not be a normal browser window.
  }
});

// ---------- Initial active-tab probe ----------
// Runs at module init (every SW wake). If the user is currently on an
// unsupported tab, this ensures the eye is centered rather than holding a
// stale pose from a previous run.
chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
  if (tabs[0]) {
    activeTabId = tabs[0].id;
    scheduleCenterCheck();
  }
}).catch(() => {});

// ---------- Blink alarm ----------
// Idle heartbeat: a soft blink ~once a minute so the icon still feels alive
// when nobody is interacting (the fast spontaneous-blink loop above only runs
// while tracking). 1 minute is the alarms API minimum, which is exactly what
// we want here - rare wake-ups, negligible cost. We run init at MODULE LEVEL
// (not gated on onInstalled/onStartup) so every SW wake re-arms the alarm.
const BLINK_ALARM = "eyeball-blink";

// Pick the palette the clock implies so a fresh wake never flashes the wrong
// theme. We do NOT force-center here: the toolbar icon persists across SW
// restarts, so forcing center on every cold start would yank a supported tab's
// eye to neutral each time the SW idled out and woke. Instead the active-tab
// probe (above) centers only when the tab is actually unsupported, and a stale
// CLOSED frame (SW died mid-blink/sleep) is reopened by the next gaze or by the
// blink alarm below - both now recover a stranded mode.
theme = scheduledTheme();

chrome.alarms.create(BLINK_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== BLINK_ALARM) return;
  // The 1-minute heartbeat is also our day/night crossing check: re-evaluate
  // the schedule, then do the idle blink.
  evaluateTheme();
  // A real blink lasts 140ms; if we still see 'blinking' a minute later, its
  // reopen timer was lost to an SW shutdown - recover so the eye doesn't stay
  // shut (blinkOnce is a no-op unless mode is 'open').
  if (mode === "blinking") mode = "open";
  blinkOnce();
});

// ---------- Click ----------
// No popup is configured, so clicks on the toolbar icon fire onClicked - we
// use it as a cheap "make it blink on demand" affordance.
chrome.action.onClicked?.addListener?.(() => blinkOnce());
