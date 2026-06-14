# AI Development Rules

When working in this repository, follow these developer guidelines to maintain consistency and prevent regressions:

## Core Guidelines

- **Architecture Integrity**: Keep the server-side code modular and avoid adding third-party framework dependencies. Build on top of native Node.js structures.
- **Dry/Deduplication**: Do not duplicate existing command executors or pattern parsing. Use the existing CLI pattern matching files (`lib/patternEngine.js` and `lib/messageProcessor.js`).
- **TDD (Test-Driven)**: Update existing tests inside `tests/` when modifying pattern matching, auto-recovery timers, or REST endpoints.
- **Single Source of Truth**: Refer to the `VERSION` file for the current project release version. Never hardcode version strings.
- **Configuration Precedence**: Environment variables in `.env` override values in `config.json`, which in turn override defaults.
- **Relative Pathing**: Avoid absolute hardcoding of workspace paths on the server. Always resolve relative to `__dirname`.
