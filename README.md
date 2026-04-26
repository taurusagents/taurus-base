# Taurus Base

Standalone base Docker image used for Taurus agent containers.


## Contents

- `Dockerfile` — the base image definition
- `browser-cli.mjs` — Playwright-backed browser helper copied into the image

## What the image includes

- Ubuntu 22.04 base
- Core CLI tools: bash, git, curl, jq, ripgrep, fd, rsync, vim, htop, etc.
- Python 3 + common data / web libraries
- Node.js 24 + common JS tooling
- Go toolchain
- asdf version manager
- GitHub CLI
- Playwright + Chromium
- Browser helper at `/usr/local/lib/browser-cli.mjs`

## Pull

Published images are available from GitHub Container Registry:

```bash
docker pull ghcr.io/taurusagents/taurus-base:latest
```

## Build locally

```bash
docker build -t taurus-base .
```

Example tagged build:

```bash
docker build -t ghcr.io/taurusagents/taurus-base:latest .
```

## Smoke test

```bash
docker run --rm -it ghcr.io/taurusagents/taurus-base:latest bash
python3 --version
node --version
go version
rg --version
fd --version
```


## Automatic publishing

GitHub Actions publishes `ghcr.io/taurusagents/taurus-base` when `main` changes, when `v*` tags are pushed, on manual dispatch, and on a daily scheduled rebuild. The scheduled rebuild uses fresh base pulls so patched Ubuntu/package layers can flow into a new image even when this repository has no source changes.

Tags:

- `latest` — current `main` image
- `sha-<commit>` — immutable commit image for push builds
- `v*` — release tags

## Runtime refresh

Runtime node refresh/retag automation is deployment-specific and intentionally not maintained in this public image repository. Taurus operators should pull `ghcr.io/taurusagents/taurus-base:latest` into their deployment environment using their private ops automation. Existing running agent containers keep using the image/layers they started with; recreate them if you need an urgent security patch applied immediately.

## Ubuntu LTS base policy

The image should move to the newest Ubuntu LTS once the browser stack supports it. Ubuntu 26.04 LTS is released and supported until April 2031, but Playwright 1.59 currently does not officially support bundled Chromium on `ubuntu26.04-x64`. Because Taurus agents rely on the Browser tool, keep `ubuntu:22.04` until a CI image build and Browser smoke test pass on 26.04, or until Playwright ships official 26.04 support.

## Browser helper

The image includes a small Playwright wrapper:

```bash
node /usr/local/lib/browser-cli.mjs '{"action":"open","url":"https://example.com"}'
```

## Notes

- This repo currently has **no license**.
- If the Taurus application changes its expectations of the agent image, update this repo accordingly.
