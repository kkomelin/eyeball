# Investigation: the toolbar eye freezes in place after idle

> Renamed from `icon-recenter-investigation.md` on 2026-06-23. The original
> framing ("drifts to the centered pose") was too narrow: the new observations
> show the eye freezes at *whatever* pose it was in, not specifically center.

**Original report (macOS), 2026-06-22:**
1. The toolbar eye drifts to the centered (neutral) pose on supported pages after some time.
2. Once centered, moving the mouse does not bring tracking back.
3. Clicking the toolbar icon does not react either.

**New observations, 2026-06-23 (these supersede the framing above):**
1. The eye **freezes at whatever state it is in** after a few minutes of
   inactivity - **not only the centered pose**. It just stops updating and holds
   its current pose.
2. **Moving the cursor does not bring tracking back** (confirmed by the user).
3. **Clicking the eye does not unfreeze it.**
4. The **service worker is active** (not terminated) at the time of observation.
5. **No error** in the service-worker console.
6. **No error** in the page's main console.

**Status:** root cause **confirmed** and **fixed** (2026-06-23). The new evidence
refutes the two mechanisms in the previous writeup; the decisive test (does the
cursor recover it? - no) confirms a **silently-stale Port** between a live content
script and a live service worker. Fixes #1-#4 are implemented with **no new manifest
permissions**; the optional orphan-recovery (#5) is intentionally deferred. See
[Fix](#fix-implemented-2026-06-23).

---

## TL;DR

The previous writeup blamed two things: (A) the MV3 service worker terminating and
**force-centering** the eye on cold start, and (B) the content script being
**orphaned** ("Extension context invalidated"). **The 2026-06-23 observations rule
both out:**

- The eye freezes **in place, not at center** -> the force-center / "no port means
  unsupported" paths are not what is being hit.
- The **service worker is active** -> not a termination cold-start at observation time.
- There are **no errors anywhere** -> the content-script context is still valid
  (no "Extension context invalidated"), so it is not orphaned.

What is left is a **silent break in the gaze pipeline between two healthy
endpoints**: a live content script and a live service worker that have stopped
talking, with nothing thrown to flag it. The confirmed cause is a **stale `Port`** -
the content script holds a port object it believes is still connected, but its
service-worker peer is gone; `postMessage` on it neither throws nor triggers a
reconnect, so gaze is dropped silently and the eye holds its last pose forever. **The
user confirmed moving the cursor does not recover it**, which rules out the benign
"port rebuilds on the next move" path and pins the diagnosis here.

Clicking can't fix it **by design**: `onClicked` only runs `blinkOnce()` (a 140ms
blink back to the same pose), never a reconnect - so "clicking does nothing visible"
is expected no matter what the underlying cause is.

---

## New observations and what each one rules out

| Observation (2026-06-23) | What it implies |
| --- | --- |
| Freezes at **whatever pose**, not center | The `BUCKET_CENTER` paths (`background.js:175`, `background.js:281`) are **not** the cause. The eye is simply not receiving new gaze and is holding its last pose. |
| **Service worker active** | Not a termination cold-start *at the moment of observation*. (It may still have terminated/restarted earlier in the idle window - see below - but it is alive now.) |
| **No error in SW console** | The service worker is not crashing or throwing. |
| **No error in page console** | The content script is **not orphaned** - `chrome.runtime` is still valid, otherwise `connect()` / `postMessage` would throw "Extension context invalidated". |
| **Moving the cursor does not recover it** | The content script never rebuilds its port - a rebuilt port would re-register and gaze would flow again. The port is stuck non-null and dead. **This is the decisive datum.** |
| **Clicking does not unfreeze** | Consistent with the code working as written: click -> `blinkOnce()` only (`background.js:295`), which never restores tracking. Tells us nothing about the root cause. |

The decisive datum is now in: **moving the cursor does not bring it back.** A healthy
content script would rebuild its port on the next `mousemove` (`content.js:42-50`)
and recover; this one does not, so it is holding a non-null port that is silently
dead. Confirmed root cause, not just a hypothesis.

---

## How the eye is supposed to work

No DOM is injected into the page; the only UI surface is the toolbar icon.

1. `content.js` listens for `mousemove`, throttles to ~30 Hz (`content.js:14`,
   `content.js:81-92`), computes a gaze `(angle, mag)` and posts it over a
   long-lived `Port` to the SW (`content.js:42-50`).
2. `background.js` maps the angle to a pose bucket and calls `chrome.action.setIcon`
   only when the pose changes (`background.js:44-55`, `background.js:187-206`).
3. **The eye intentionally holds its last pose when the cursor stops on a supported
   page** - it never drifts back to neutral while tracking (`content.js:69-76`).
4. The eye **centers** (`BUCKET_CENTER`) only when the active tab is deemed
   "unsupported" (`background.js:167-177`).

Point 3 matters for the new report: **"frozen in place during inactivity" is, on a
healthy path, partly the designed behavior.** The eye is *supposed* to hold its last
pose when you stop moving. The actual defect is that it never **resumes** when you
move again (and, if you watch long enough, may not even do its 1-minute idle blink).

---

## Refined root cause: a silently-stale Port

Both consoles are clean and the SW is alive, so the failure is not an exception and
not a dead SW - it is **gaze silently failing to cross a port that both sides still
think is fine.** Here is how the code gets there.

During a few minutes of cursor idle, the SW very likely **does** terminate and
restart at least once (idle kills it in ~30s; the 1-minute alarm and any
`connect()` wake it again - so by the time you open the inspector it reads as
"active"). Note too that **opening the SW inspector pins it alive**, which is exactly
the state you are observing in.

On each SW termination the content-script port is meant to disconnect, and
`content.js:33-35` nulls `port` so the next `send()` rebuilds it:

```js
// content.js:29-50
let port = null;
function ensurePort() {
  if (port) return port;                 // <-- returns a stale port if it was never nulled
  try {
    port = chrome.runtime.connect({ name: "eyeball" });
    port.onDisconnect.addListener(() => { port = null; });
  } catch { port = null; }
  return port;
}
function send(msg) {
  const p = ensurePort();
  if (!p) return;
  try { p.postMessage(msg); }
  catch { port = null; }                 // <-- only nulls if postMessage THROWS
}
```

The failure mode that matches every observation: the content side ends up holding a
**non-null port whose SW peer no longer exists**, and `postMessage` on it **does not
throw**. Then:

- `ensurePort()` short-circuits on the truthy `port` and never reconnects.
- `send()`'s `postMessage` silently goes nowhere; the `catch` never fires, so `port`
  is never nulled.
- The new SW instance's `portsByTab` never learns about this tab, so no gaze is ever
  applied. The eye holds its last pose. **No error on either side.**

This is the only shape consistent with: *SW alive + no errors + frozen in place +
no recovery.* It also explains why it is **not** center-specific: nothing forces a
pose at all - the pipeline just goes quiet.

The root design gap: **there is no heartbeat and no reconnect/backoff.** The content
script trusts a single port object and only ever rebuilds it lazily inside `send()`,
gated on the port being falsy. A port that dies without nulling itself is invisible
to this code forever.

> Confirmed: in the common MV3 case, SW termination *does* fire the content-side
> `onDisconnect`, which nulls `port`, and the next `mousemove` reconnects fine. The
> user reports moving the cursor does **not** recover tracking, so that is **not**
> what is happening here - `onDisconnect` did not null the port, leaving a non-null
> dead port that `ensurePort()` keeps handing back. The stale-port path is confirmed.

---

## Why the previously-documented mechanisms no longer fit

- **Mechanism A (cold-start force-center).** Premise was "SW terminated -> module
  init runs `setBucket(BUCKET_CENTER, force)` (`background.js:281`) and the no-port
  check centers the eye (`background.js:175`)." Refuted by **"freezes in place, not
  center"** and **"SW active."** The force-center paths are not being exercised.
- **Mechanism B (orphaned content script / "Extension context invalidated").**
  Refuted by **"no error in the page console."** A truly orphaned content script
  throws on every `connect()`/`postMessage`; here it does not. So the tab is **not**
  orphaned by an extension reload/update in this report.

What remains valid from the old writeup: the underlying **design flaw is the same** -
the gaze link is fragile and support is *inferred* from port presence rather than
measured. The new evidence just relocates the break from "SW died / context
invalidated" to "two live endpoints, one dead port, no signal."

---

## Why clicking can never unfreeze it (independent of root cause)

`chrome.action.onClicked` -> `blinkOnce()` (`background.js:295`, `:110-119`). That
forces `BUCKET_CLOSED` for 140ms, then restores `lastOpenBucket` - the *same* frozen
pose. It does not reconnect the port, does not request fresh gaze, and the flash back
to an identical image is easy to miss. So "clicking does nothing" is expected behavior
and is not diagnostic. (Worse: if the SW is mid-restart, the 140ms `setTimeout` reopen
can be lost, leaving the icon stuck CLOSED - a second, smaller freeze hazard at
`background.js:114-118`.)

---

## Open questions (targeted tests)

The decisive question is now **answered**:

1. ~~When frozen, does moving the cursor bring tracking back?~~ **Answered: no.**
   Confirms the **stale-port** root cause. Fix = heartbeat + reconnect.

Remaining, lower-priority confirmations (nice-to-have, not blocking the fix):

2. While frozen, does the eye still do its **~1-minute idle blink**? (If no blink at
   all for 2-3 minutes, the SW is either not staying alive between alarms or `mode`
   is wedged in `blinking`/`sleeping` - a second issue independent of the dead port.)
3. Does **reloading the tab** (Cmd+R) restore tracking? (Expected: yes - a fresh
   content script gets a fresh port. This is the current manual workaround.)
4. Was the **SW inspector open** when you saw "SW active"? (An open inspector pins
   the SW alive, so "active" may be the inspector's doing, not the steady state -
   worth noting so we don't mistake the observation tool for normal behavior.)

---

## Fix (implemented 2026-06-23)

Re-prioritized around the silent-port defect. #1-#4 are **done**; #5 is deferred.

1. **[done] Self-healing port in `content.js`.** The content script now rebuilds a
   port that has gone quiet longer than `PORT_STALE_MS` (20s, under the SW's ~30s
   idle-out) and tears the port down on any send failure, so it can never sit on a
   dead port silently dropping gaze. The SW sends a `hello` ack on connect
   (`background.js` onConnect) that the content script uses to refresh its staleness
   clock. **Deviation from the original proposal:** no periodic ping/timer - that
   would pin the SW alive against its idle-out design. Reconnection is lazy, on the
   next real event (a mouse move), which is exactly when recovery is needed. This is
   what kills the freeze.

2. **[done] Center on URL, not port presence.** `scheduleCenterCheck` now reads the
   active tab's URL via `chrome.tabs.get` and centers only when `isUnsupportedUrl`
   (non-http/https, or the Chrome Web Store) is true, instead of the
   `!portsByTab.has(activeTabId)` heuristic. Reliable across SW restarts, and it
   keeps the #1 reconnect from briefly flickering the eye to center. `tab.url` comes
   from the existing `<all_urls>` host permission - no new permission.

3. **[done] No force-center on every wake.** Dropped the unconditional
   `setBucket(BUCKET_CENTER, force)` at module init. The toolbar icon persists across
   SW restarts, so a live or recently-rendered eye keeps its real pose; the active-tab
   probe centers only when the tab is actually unsupported. (The brand `default_icon`
   is itself the centered eye, so a fresh install/browser-restart looks unchanged.)
   *Residual, accepted:* without persisting the pose to storage - which would need the
   `storage` permission - a cold-started idle SW still re-centers via the 1-minute
   blink (its `lastOpenBucket` defaults to center). Harmless now that #1 makes a mouse
   move resume tracking instantly.

4. **[done] Recover a stranded mode.** A gaze now resets any non-open mode (not just
   `sleeping`), and the 1-minute alarm resets a lingering `blinking` before blinking,
   so a 140ms reopen lost to an SW teardown can no longer leave the eye stuck CLOSED.

5. **[deferred] Recover orphaned tabs** (production auto-update / dev-reload case,
   which this report ruled out): would add the `scripting` permission and re-inject
   `content.js` into open http/https tabs from `chrome.runtime.onInstalled`. Skipped
   to keep the manifest unchanged.

**Permissions impact:** the confirmed-freeze fix (#1-#4) needs **no new manifest
permissions** - `runtime.connect`/port messaging, `action.setIcon`, and reading
`tab.url` via `chrome.tabs.get` are all already available under the current
`["alarms"]` + `host_permissions: ["<all_urls>"]` (`manifest.json:26-27`). Only the
optional orphan-recovery (#5) adds one: **`scripting`**. Since #5 addresses a
scenario this report ruled out, we can ship #1-#4 with the manifest untouched.

---

## Key references (code)

| What | Location |
| --- | --- |
| Content-script port: lazy, no heartbeat, no reconnect | `content.js:29-50` |
| `send()` only nulls the port on a thrown `postMessage` | `content.js:42-50` |
| mousemove throttle/flush -> gaze | `content.js:53-92` |
| "no port on active tab means unsupported" heuristic | `background.js:167-177` |
| `BUCKET_CENTER` center-check | `background.js:175` |
| Module-init force-center (every wake) | `background.js:281` |
| onConnect / onDisconnect (port registry) | `background.js:182-224` |
| `blinkOnce()` 140ms reopen (can be lost on SW teardown) | `background.js:110-119` |
| 1-minute idle blink alarm | `background.js:283-290` |
| Toolbar click -> blink only (never reconnects) | `background.js:295` |
| Manifest permissions (`alarms` only, no `scripting`) | `manifest.json:26` |
