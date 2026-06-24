# Changelog

All notable changes to Eyeball are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-06-24

### Changed

- The eye tracks your cursor more faithfully. It now follows the cursor to the right of the toolbar icon, not just to the left and down. And as the cursor moves up close to the icon, the eye keeps pointing right at it instead of drifting downward off the target - the way your eyes stay locked on something approaching them.

### Fixed

- The toolbar eye no longer freezes after the browser sits idle. Chrome puts the extension to sleep after about 30 seconds of quiet, which could silently leave the eye holding a dead connection and dropping your cursor forever. It now reconnects on its own and recovers on the next mouse move, so the eye keeps tracking even after a long pause.
- The eye recovers cleanly when you move between pages with the browser's Back and Forward buttons. Chrome freezes recently visited pages into a back/forward cache, which severed the eye's connection and left a stray "port moved into back/forward cache" warning in the extension console. The eye now hands that connection back as a page is frozen and restores it the instant you navigate back, so it resumes following your cursor right away and the warning is gone.

## [0.2.0] - 2026-06-21

### Added

- Time-based night mode: in the evening (21:00-06:00, your local clock) the eye gets tired - the white turns faintly pink and it blinks more often - then it's rested again by morning. The switch is driven entirely by your device's clock; nothing is sent anywhere and no preference is stored.

## [0.1.0] - 2026-06-21

### Added

- Initial release of Eyeball - a curious eye in your toolbar that follows your cursor, centers on pages it can't read, and sometimes blinks. No network, no tracking.

[0.3.0]: https://github.com/kkomelin/eyeball/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kkomelin/eyeball/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kkomelin/eyeball/releases/tag/v0.1.0
