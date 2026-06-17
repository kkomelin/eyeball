# Eyeball - plan

An eye in the Chrome toolbar that follows the cursor on the page. MV3, no
network, no tracking.

## Concept

The toolbar icon is a **single eye**. Its pupil tracks the user's cursor on
the active tab. On pages where a content script can't run (PDFs, `chrome://`,
Web Store, new-tab restricted contexts), the eye falls into an **idle
"looking around"** animation - not blank, not broken, just glancing about on
its own. Same for when the browser is unfocused or no tab is active.

### Why one eye, not two

The toolbar icon is 16 px at standard density (32 px on HiDPI). The math:

| Layout   | Disc diameter (16 px) | Pupil diameter | Pupil travel  |
| -------- | --------------------- | -------------- | ------------- |
| One eye  | ~14 px                | 4-5 px         | ±3-4 px       |
| Two eyes | ~7 px each            | 2-3 px each    | ±1 px each    |

At two eyes, the pupil travel collapses to roughly one pixel - that doesn't
read as tracking, it reads as two static dots. One eye keeps enough pupil
travel that movement is unambiguous. It also makes a stronger logo, matches
the singular name, and keeps the centered and blink/sleeping frames legible.

## States

| State                  | Trigger                                                                 | Behavior                                           |
| ---------------------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| `open`                 | Default mode - showing some open pose                                   | Pupil follows the cursor; freezes at last pose when the cursor stops on a supported tab; **centers** when the active tab is unsupported (PDF, `chrome://`, Web Store) |
| `sleeping`             | Browser window unfocused (`windows.onFocusChanged === WINDOW_ID_NONE`)  | Eye closed (horizontal line)                       |
| `blinking`             | Periodic (every 1 min) and on toolbar-icon click                        | Brief eye-closed frame, then restore to last open pose |

There is no look-around / glancing state. While on a supported tab, the eye
either tracks the cursor or holds its last pose - it doesn't wander. The
**only** trigger to re-center is the active tab having no connected content
script (i.e. it's unsupported, or was just closed/navigated to an
unsupported URL). `sleeping` and `blinking` restore to the exact prior pose
via the `lastOpenBucket` cache - no re-centering on wake.

Address-bar typing detection is **not directly possible** without an omnibox
keyword. We don't try to approximate it. Page blur just keeps the current
pose and resets the idle watchdog.

### Fixating the cursor like a human eye (smooth pursuit)

A human eye tracks a moving target with *smooth pursuit*: it rotates to keep
the target's image on the fovea - it always points **at** the object, and
when the object approaches it stays locked on (convergence / the near
response), never drifting to neutral or looking the opposite way.

We model that. Chrome's toolbar icons sit at the **top-right** of the window,
above and to the right of the page - so the content script anchors the
virtual eye there: near the right edge (`EYE_X_FRAC * w`, default the right
edge) and a little **above** the top edge (`-EYE_ABOVE`, `EYE_ABOVE =
EYE_ABOVE_FRAC * h`, ~25% of viewport height). Because every cursor on the
page is then below-and-to-the-left of the eye, the gaze always points
**down / down-left toward the cursor** - it never flips up and never veers
off to the right. As the cursor approaches the icon (toward the top-right),
the eye keeps fixating it, converging toward straight-down, instead of
re-centering, looking "away", or sliding sideways.

The eye stays locked on: the content script sends a full magnitude, so the
pupil always points at the cursor while it is on the page and never relaxes
to the centered pose mid-track. (At icon size the pupil only has a "centered"
vs. "fully toward the cursor" distinction anyway - all 16 directional sprites
are rendered at full pupil travel.) The eye only re-centers on tabs with no
content script, which the service worker handles separately.

`EYE_ABOVE_FRAC` is the one tuning knob: smaller makes the eye turn more
sharply to follow (more dramatic, but more sensitive near the top); larger
makes the gaze flatter and calmer.

## Architecture

```
eyeball/
├── manifest.json
├── background.js      # service worker: sprite atlas + setIcon dispatcher
├── content.js         # throttled mousemove, posts over Port
├── eye.js             # shared geometry: angle bucketing, drawEye(), sprite atlas builder
├── icons/             # static brand icons (eye-open at center)
├── PRIVACY.md
├── LICENSE
├── NOTICE
├── README.md
├── package.json
├── scripts/
├── tests/
├── dev/               # preview.html: sprite atlas viewer + live tracking pad
└── store-assets/
```

`eye.js` is the single source of geometry, driving both the toolbar disc
(OffscreenCanvas → ImageData) and the dev preview canvas. **No popup**: this
is a pure toolbar experiment - the only UI surface is the icon itself.

## Render pipeline

1. **At install / startup**, `background.js` pre-renders an **eye-sprite atlas**:
   N pupil angles × {16, 32} px → cached `ImageData` objects.
   Typical N: 16 directions + 1 centered + 1 closed = 18 sprites per size.
2. **Content script** listens to `mousemove`, `blur`, `focus`, `visibilitychange`.
   `mousemove` is throttled to ~10-15 Hz (every ~70-100ms) and converted to a
   viewport-relative angle: `atan2(mouseY - vh/2, mouseX - vw/2)`. Posts
   `{type: 'gaze', angle, mag}` over a long-lived
   `chrome.runtime.connect({name: 'eye'})` Port.
3. **Service worker** receives the gaze message, quantizes angle to the
   nearest sprite bucket, and only calls `chrome.action.setIcon({imageData})`
   when the bucket actually changes. Expected real-world rate: a few calls
   per second, not dozens.
4. **Centering** happens when the active tab has no connected content-script
   port (PDF, `chrome://`, Web Store, or a freshly-closed tab). The SW gives
   new tabs a short grace period to connect, then sets the centered sprite.
5. **Blink** is a single-frame `setIcon` swap to the closed sprite, then back.
   Spontaneous blinks run every 7-13s while a gaze has arrived recently; a
   1-minute alarm provides a low-cost heartbeat when nothing is happening.

## Why this respects Chrome's API guidance

Chrome's docs say `chrome.action.setIcon` is "for static images, don't
animate". We comply by:

- **Discrete state changes**, not a render loop. The pupil has ~16 positions;
  most cursor movements don't cross a bucket boundary, so updates are sparse.
- **Pre-baked `ImageData`** - no per-frame canvas work, just handing Chrome a
  cached buffer.
- **Hard cap** on update rate in the SW (drop messages that would cause
  another `setIcon` within ~40ms of the previous one).

## Manifest

```json
{
  "manifest_version": 3,
  "name": "Eyeball - an eye that follows your cursor",
  "version": "0.1.0",
  "minimum_chrome_version": "111",
  "background": { "service_worker": "background.js", "type": "module" },
  "action": {
    "default_title": "Eyeball",
    "default_popup": "popup.html",
    "default_icon": { "16": "icons/icon16.png", "32": "icons/icon32.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
  },
  "icons": { "16": "icons/icon16.png", "32": "icons/icon32.png", "48": "icons/icon48.png", "128": "icons/icon128.png" },
  "permissions": ["alarms"],
  "host_permissions": ["<all_urls>"],
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"],
    "run_at": "document_idle",
    "all_frames": false
  }]
}
```

`host_permissions: ["<all_urls>"]` is the meaningful privacy cost. Justified
in `PRIVACY.md` by: cursor coordinates never leave the device, are not stored,
and are used only to pick a sprite.

## Permissions

| Permission           | Why                                                                 |
| -------------------- | ------------------------------------------------------------------- |
| `alarms`             | Periodic blink + idle wake-up                                        |
| `<all_urls>` (host)  | Content script reads cursor position on the active tab               |

No network, no `storage`, no `tabs` URL access, no `cookies`.

## What's deliberately out of scope

- **Detecting omnibox keystrokes** - no Chrome API exposes this without a
  registered keyword. We don't try.
- **Tracking the cursor across the browser chrome** (tabs strip, bookmarks
  bar) - no API. We can't.
- **Working on `chrome://`, Web Store, and PDF tabs** - content scripts are
  blocked. We fall back to centering the eye.
- **Persistence of "last gaze"** - state is in-memory in the SW; on SW
  restart we reset to centered. No `chrome.storage` needed.

## Implementation phases

1. **Geometry spike** (`eye.js` + a standalone HTML demo)
   Sketch the pupil-positioning math, render a 16/32 px eye atlas to a page,
   verify it reads as an eye at icon size. Pick N (likely 16) and confirm
   discrete pupil steps don't look jumpy.

2. **Toolbar pipeline** (`background.js`, minimal `content.js`)
   Wire the Port, throttling, bucket-change gating, and `setIcon`. Test
   subjective smoothness on a typical browsing session. Confirm update rate
   stays in the single-digit-per-second range.

3. **Sleep and blink**
   Sleeping on window blur, spontaneous blink loop while tracking, 1-minute
   heartbeat blink alarm, click-to-blink.

4. **Unsupported-page handling**
   Verify the SW correctly centers the eye when the active tab switches to a
   `chrome://` URL, a PDF, or the Web Store. Use `chrome.tabs.onActivated`
   plus port disconnects to detect the active tab having no connected
   content-script port, with a brief grace period for a freshly-opened tab.

5. **Polish / store**
   Icons, `PRIVACY.md`, `README.md`, store assets, screenshots, the works.
   Set up the scripts/tests skeleton.

## Open decisions

- **N (pupil-bucket count)**: 8 is too coarse at 32 px, 32 is wasteful. Start
  at 16, revisit after the geometry spike.
- ~~Idle look-around~~ - **decided: no idle wander**. The eye either tracks
  the cursor, holds its last open pose, or (on unsupported tabs) centers.
- ~~Look-up heuristic for omnibox~~ - **decided: skip**. No reliable signal
  without a registered omnibox keyword, and the false-positive rate
  (alt-tab, devtools focus) isn't worth the small gain.
- **Eye style**: cartoony round eye, or stylized iris with detail? At 16 px
  the answer is forced (round + pupil); 32 px allows a hint of iris.
- ~~Single eye vs. two eyes~~ - **decided: single eye** (see Concept).
- **Virtual eye anchor** is near the right edge (`EYE_X_FRAC`, default the
  right edge) and `EYE_ABOVE_FRAC` (~25%) of viewport height *above* the top
  edge, mirroring where Chrome's toolbar icon sits (top-right, above the
  page). The eye fixates the cursor - always pointing down / down-left toward
  it, never up/away or sideways - and stays locked on while the cursor is on
  the page. `EYE_ABOVE_FRAC` trades follow sharpness against calmness;
  `EYE_X_FRAC` should match where the icon is pinned.
