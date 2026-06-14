# Contributing to NexTmux

Thanks for your interest in improving NexTmux.

## Before you start

- Open an issue first for large changes so we can align on scope.
- Keep pull requests focused and small when possible.

## Local setup

```bash
npm install
cp config.example.json config.json
echo -e "PORT=8081\nDASHBOARD_PASSWORD=yourpass" > .env
npm start
```

## Development guidelines

- Follow the existing code style and file structure.
- Avoid unrelated refactors in the same pull request.
- Update `README.md` and related `/docs` files if behavior or setup changes.

## Commit and PR guidelines

- Use clear commit messages that explain what and why.
- Include a short PR description, testing notes, and screenshots for UI changes.
- Link related issues (for example: `Closes #12`).

## Testing

Run the automated test suite before submitting pull requests:

```bash
npm test
```

Also validate core flows manually:
- Spawn a new session
- Attach an existing tmux session
- Switch Tab/Split layout
- Stop and remove workers
- Include your manual test steps in the PR description.

## Code of conduct

Be respectful and constructive in discussions and reviews.
