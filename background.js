// Eyeball - background service worker (Manifest V3).
// Pre-renders an eye-pose sprite atlas at startup, then dispatches setIcon
// only when the active pose changes. No per-frame canvas work, no network,
// no storage. The sprite atlas lives in module memory; if the service worker
// is terminated the atlas is rebuilt on the next event (cheap - ~36 small
// canvas draws total).

import {
  buildAtlas,
  angleToBucket,
  BUCKET_CENTER,
  BUCKET_CLOSED,
} from "./eye.js";

const ICON_SIZES = [16, 32];

// Bucket id ("c", "x", 0..15) -> { 16: ImageData, 32: ImageData }.
// Built eagerly at module init so the first gaze after a service-worker
// cold-start doesn't have to wait for ~36 small canvas draws.
const atlas = buildAtlas((w, h) => new OffscreenCanvas(w, h), ICON_SIZES);

// ---------- Pose dispatch ----------
let currentBucket = null;
let lastSetIconAt = 0;
const SET_ICON_MIN_GAP_MS = 16; // Hard cap on setIcon rate (~60 Hz max).

function setBucket(bucket, { force = false } = {}) {
  if (!force && bucket === currentBucket) return;
  const now = Date.now();
  if (!force && now - lastSetIconAt < SET_ICON_MIN_GAP_MS) return;
  const imageData = atlas[bucket];
  if (!imageData) return;
  currentBucket = bucket;
  lastSetIconAt = now;
  chrome.action.setIcon({ imageData }).catch(() => {
    // Ignore: tabs can close between dispatch and apply.
  });
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
const BLINK_MIN_MS = 7000;
const BLINK_MAX_MS = 13000;
const BLINK_ACTIVE_WINDOW_MS = 15000; // keep blinking this long after the last gaze, then wind down
let blinkTimer = null;
let lastGazeAt = 0;

function nextBlinkDelay() {
  return BLINK_MIN_MS + Math.random() * (BLINK_MAX_MS - BLINK_MIN_MS);
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
// so we detect "active tab is unsupported" as "the currently active tab has
// no connected eyeball port". When that happens the eye centers - the same
// behavior as before this change.
let activeTabId = null;
const portsByTab = new Map(); // tabId -> Port

let centerCheckTimer = null;
function scheduleCenterCheck(delayMs = 200) {
  // Brief grace period: switching to a previously-visited supported tab is
  // instant (its port already exists), but a freshly-opened tab needs ~tens
  // of ms for its content script to connect. Wait, then re-check.
  if (centerCheckTimer) clearTimeout(centerCheckTimer);
  centerCheckTimer = setTimeout(() => {
    centerCheckTimer = null;
    if (activeTabId == null) return;
    if (!portsByTab.has(activeTabId)) setOpenPose(BUCKET_CENTER);
  }, delayMs);
}

// ---------- Content-script port ----------
// Long-lived Port keeps the SW alive while the user moves the cursor, and
// avoids per-message connection setup.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "eyeball") return;
  const tabId = port.sender?.tab?.id ?? null;
  if (tabId != null) portsByTab.set(tabId, port);

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
        // Gaze proves the window is active; recover from a stale sleeping.
        if (mode === "sleeping") mode = "open";
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
// we want here - rare wake-ups, negligible cost. The Chrome Action toolbar
// icon persists across service-worker restarts, so we run init at MODULE LEVEL
// (not gated on onInstalled/onStartup) - this guarantees that an SW which died
// with the icon in BUCKET_CLOSED comes back open on its next wake instead of
// staying stuck closed.
const BLINK_ALARM = "eyeball-blink";

setBucket(BUCKET_CENTER, { force: true });

chrome.alarms.create(BLINK_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BLINK_ALARM) blinkOnce();
});

// ---------- Click ----------
// No popup is configured, so clicks on the toolbar icon fire onClicked - we
// use it as a cheap "make it blink on demand" affordance.
chrome.action.onClicked?.addListener?.(() => blinkOnce());
