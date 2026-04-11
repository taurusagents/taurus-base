# Taurus Base

Standalone base Docker image used for Taurus agent containers.


## Contents

- `Dockerfile` — the base image definition
- `browser-cli.mjs` — Playwright-backed browser helper copied into the image

## What the image includes

- Ubuntu 22.04 base
- Core CLI tools: bash, git, curl, jq, ripgrep, fd, rsync, vim, htop, etc.
- Python 3 + common data / web libraries
- Node.js 22 + common JS tooling
- Go toolchain
- asdf version manager
- GitHub CLI
- Playwright + Chromium
- Browser helper at `/usr/local/lib/browser-cli.mjs`

## Build

```bash
docker build -t taurus-base .
```

Example tagged build:

```bash
docker build -t ghcr.io/taurusagents/taurus-base:latest .
```

## Smoke test

```bash
docker run --rm -it taurus-base bash
python3 --version
node --version
go version
rg --version
fd --version
```

## Browser helper

The image includes a small Playwright wrapper:

```bash
node /usr/local/lib/browser-cli.mjs '{"action":"open","url":"https://example.com"}'
```

## Notes

- This repo currently has **no license**.
- If the Taurus application changes its expectations of the agent image, update this repo accordingly.
