# Privacy Policy

**EyeBar collects nothing, stores nothing about you, and sends nothing
anywhere.**

- **No data collection.** EyeBar does not collect, store, or transmit any
  personal or usage data.
- **No network requests.** The extension makes no requests to any server.
- **No accounts, no analytics, no cookies, no tracking.**
- **Cursor coordinates never leave your device.** The content script reads
  `mousemove` events on the page solely to compute the angle and distance of
  the cursor from the center of the viewport. Only those two numbers are
  forwarded to the extension's service worker, where they are used to pick
  which pre-rendered eye sprite to display in the toolbar. The coordinates
  are not stored anywhere - not in `chrome.storage`, not in `localStorage`,
  not in cookies. They are not sent over the network.

## Permissions

| Permission              | Why it is needed                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `alarms`                | Triggers a periodic soft "blink" of the toolbar eye, and keeps the icon visually alive when nothing else is happening. |
| `<all_urls>` (host)     | Lets the content script read cursor position on the active page so the eye can follow it. Required for the feature to work at all - see the note below on what data is and isn't read. |

EyeBar reads only the cursor's `clientX` / `clientY` coordinates from
`mousemove` events. It does not read page content, form data, URLs, history,
cookies, or any other information from the pages you visit.

On pages where extensions cannot run a content script (PDFs, the Chrome Web
Store, internal `chrome://` pages), EyeBar receives no cursor data at all -
the eye simply looks around on its own.

## Contact

Questions about this policy: open an issue at
https://github.com/kkomelin/eyebar/issues
