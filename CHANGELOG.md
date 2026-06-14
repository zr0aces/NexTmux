# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to Calendar Versioning (CalVer) with the format `YYYY.M.MINOR`.

## [2026.6.7] - 2026-06-10

### Changed
- Moved the single source of truth version definition to a `VERSION` file.
- Updated the version synchronization script to parse and sync the `VERSION` file value.
- Configured backend response headers to return `X-App-Version`.

### Fixed
- Fixed consistent version numbering synchronization inside `index.html`, `package.json`, and `package-lock.json`.
- Enhanced session scanning error handling robustness.

## [2026.6.4] - 2026-06-08

### Added
- Enhanced UI dashboard with empty state placeholders.
- Added closed tab management and session rename editing capability.

### Changed
- Simplified password management flow on the client side using synchronous `localStorage` caching.
- Enhanced HTML loader error recovery fallback logic.

## [2026.6.3] - 2026-06-06

### Added
- Integrated multi-CLI engine supporting Claude, Codex, and Google Agy.
- Automatic wait-state supervision and pattern detection.
- Outbound Telegram alert notification webhook system.
- Rate-limit auto-recovery sleep-timer rescheduling.
