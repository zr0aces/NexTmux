# Coding Standards

Follow these code quality standards across the codebase:

## General Principles

- **Simplicity Over Cleverness**: Write readable, self-explanatory code. Avoid complex patterns when a simple loop or conditional suffices.
- **Minimal Dependencies**: The backend must only rely on `dotenv` and `ws`. Do not add libraries for utility operations.
- **Function Sizes**: Keep functions focused. Break up functions exceeding 100 lines into testable sub-methods.
- **Error Handling**: Always catch async block errors and log descriptive status signals. Ensure all subprocess executions (`execSync`, `spawn`) catch exceptions cleanly.

## Logging Guidelines

- **Structured Output**: Write logs in clean, concise terminal outputs.
- **Security Check**: Never log authorization tokens, API keys, passwords, or personal user data (PII).

## Security Hardenings

- **Execution Safety**: Do not construct plain shell strings for command execution. Use arrays with `execFileSync` to safeguard against parameter command injections.
- **Path Sanitization**: Restrict file lookups (such as git diff file fetches) using normalized paths and block directory traversal markers (`..`).
- **Timing Attack Prevention**: Use constant-time matching methods (`crypto.timingSafeEqual`) for passwords and token credentials verification.
