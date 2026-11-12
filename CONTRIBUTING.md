# Contributing

- Branch from `main`: `feat/…`, `fix/…`, `chore/…`. No direct pushes to `main`.
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`).
- Open a PR; CI (server tests, Flutter analyze) must pass; one review required.
- Never commit secrets, `cameras.json`, databases or build output (see `.gitignore`).
- Test risky changes against a throwaway server first:
  `PORT=3100 DATA_DIR=$(mktemp -d) RTMP_PORT=1936 FLV_PORT=8100 node server.js`
