# Changelog

All notable changes to Eyeball are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-06-24

### Fixed

- The toolbar eye no longer freezes after the browser sits idle. Chrome puts the extension to sleep after about 30 seconds of quiet, which could silently leave the eye holding a dead connection and dropping your cursor forever. It now reconnects on its own and recovers on the next mouse move, so the eye keeps tracking even after a long pause.

## [0.2.0] - 2026-06-21

### Added

- Time-based night mode: in the evening (21:00-06:00, your local clock) the eye gets tired - the white turns faintly pink and it blinks more often - then it's rested again by morning. The switch is driven entirely by your device's clock; nothing is sent anywhere and no preference is stored.

## [0.1.0] - 2026-06-21

### Added

- Initial release of Eyeball - a curious eye in your toolbar that follows your cursor, centers on pages it can't read, and sometimes blinks. No network, no tracking.

[0.2.1]: https://github.com/kkomelin/eyeball/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/kkomelin/eyeball/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kkomelin/eyeball/releases/tag/v0.1.0
