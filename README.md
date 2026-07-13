# Taurus Base Images

Standalone Docker image definitions used by Taurus-managed containers.

## Images in this repo

- `ghcr.io/taurusagents/taurus-base` — default user-visible Taurus agent container image
- `ghcr.io/taurusagents/taurus-base-subscription` — hidden Taurus-managed subscription sidecar image

## Contents

- `Dockerfile` — the default Taurus agent image definition
- `Dockerfile.subscription` — the dedicated subscription sidecar image definition
- `subscription-runtime-versions.json` — pinned Claude/Codex/MCP SDK contract baked into the subscription image
- `codex-app-server-smoke.mjs` — build-time JSON-RPC smoke test for `codex app-server --listen stdio://`
- `patches/codex-local-compaction.patch` — Taurus staging patch that forces local compaction and exposes the plaintext summary on the app-server v2 wire
- `browser-cli.mjs` — Playwright-backed browser helper copied into the main `taurus-base` image

## `taurus-base`

The default agent image includes:

- Ubuntu 22.04 base
- Core CLI tools: bash, git, curl, jq, ripgrep, fd, rsync, vim, htop, etc.
- Python 3 + common data / web libraries
- Node.js 24 + common JS tooling
- Go toolchain
- asdf version manager
- GitHub CLI
- Playwright + Chromium
- Browser helper at `/usr/local/lib/browser-cli.mjs`

Pull it with:

```bash
docker pull ghcr.io/taurusagents/taurus-base:latest
```

Build it locally with:

```bash
docker build -t taurus-base .
```

Smoke test it with:

```bash
docker run --rm -it ghcr.io/taurusagents/taurus-base:latest bash
python3 --version
node --version
go version
rg --version
fd --version
```

## `taurus-base-subscription`

The subscription sidecar image exists specifically for Taurus-managed hidden
subscription providers. It intentionally bakes the pinned runtime/toolchain that
Taurus expects inside the sidecar:

- Node.js 24
- Python 3
- `@anthropic-ai/claude-code@2.1.207`
- patched source build of `openai/codex` `rust-v0.144.1` (remote compaction forced local for Taurus staging)
- `@modelcontextprotocol/sdk@1.29.0`
- version manifest at `/usr/local/lib/taurus-subscription/runtime-versions.json`

The subscription Dockerfile now clones the pinned upstream Codex source,
applies [`patches/codex-local-compaction.patch`](patches/codex-local-compaction.patch),
builds the `codex` binary in a throwaway builder stage, and then runs
[`codex-app-server-smoke.mjs`](codex-app-server-smoke.mjs) to smoke-test
`/usr/bin/codex --version` plus a real `/usr/bin/codex app-server --listen
stdio://` JSON-RPC `initialize`/`getAuthStatus` probe inside the final image so
publish/builds fail fast if the patched binary cannot start on the same path
and argv Taurus uses at runtime.

The builder defaults to `CODEX_BUILD_JOBS=1` for memory-constrained hosts; pass
`--build-arg CODEX_BUILD_JOBS=4` (or similar) on larger builders to speed up the
Rust compile.

Pull it with:

```bash
docker pull ghcr.io/taurusagents/taurus-base-subscription:latest
```

Build it locally with:

```bash
docker build -f Dockerfile.subscription -t taurus-base-subscription .
# or, on a roomier builder:
docker build -f Dockerfile.subscription --build-arg CODEX_BUILD_JOBS=4 -t taurus-base-subscription .
```

Smoke test it with:

```bash
docker run --rm -it ghcr.io/taurusagents/taurus-base-subscription:latest bash
python3 --version
node --version
claude --version
codex --version
node -e "require.resolve('@modelcontextprotocol/sdk/server/index.js')"
cat /usr/local/lib/taurus-subscription/runtime-versions.json
```

Important: this image does **not** bake Taurus's `resources/subscription-mcp/*`
wrapper/helper programs. Taurus keeps shipping those app-owned helpers via the
mounted `/provider/taurus-mcp` runtime directory so wrapper changes can roll out
without rebuilding the image.

## Automatic publishing

GitHub Actions publishes both images when `main` changes, when `v*` tags are
pushed, on manual dispatch, and on a daily scheduled rebuild. The scheduled
rebuild uses fresh base pulls so patched Ubuntu/package layers can flow into new
images even when this repository has no source changes.

Tags for both images:

- `latest` — current `main` image
- `sha-<commit>` — immutable commit image for push builds
- `v*` — release tags

## Runtime refresh / rollout model

Runtime node refresh/retag automation is deployment-specific and intentionally
not maintained in this public image repository. Taurus operators should pull
both `ghcr.io/taurusagents/taurus-base:latest` and
`ghcr.io/taurusagents/taurus-base-subscription:latest` into their deployment
environment using their private ops automation.

Existing running containers keep using the image/layers they started with;
recreate them if you need an urgent security patch applied immediately. That is
especially important for subscription sidecars, because Taurus treats sidecar
image adoption as a deliberate pin/update event rather than a silent drift to
whatever `latest` became later.

## Ubuntu LTS base policy

The main Taurus image should move to the newest Ubuntu LTS once the browser
stack supports it. Ubuntu 26.04 LTS is released and supported until April 2031,
but Playwright 1.59 currently does not officially support bundled Chromium on
`ubuntu26.04-x64`. Because Taurus agents rely on the Browser tool, keep
`ubuntu:22.04` until a CI image build and Browser smoke test pass on 26.04, or
until Playwright ships official 26.04 support.

The subscription sidecar image currently stays on the same Ubuntu base so Taurus
can move both managed image families forward deliberately instead of creating a
surprise distro mismatch between normal agents and hidden sidecars.

## Browser helper

The main `taurus-base` image includes a small Playwright wrapper:

```bash
node /usr/local/lib/browser-cli.mjs '{"action":"open","url":"https://example.com"}'
```

Taurus containers remain rootful overall so agents can keep using `apt-get` and
normal root-owned workflows. Chromium itself is launched under a dedicated
`taurus-browser` user with writable home/cache/profile/state directories, so
the browser sandbox stays enabled and Taurus no longer relies on `--no-sandbox`.

That browser sandbox depends on both host kernel settings and container runtime
policy. The host must allow unprivileged user namespaces
(`kernel.unprivileged_userns_clone=1` and a positive
`user.max_user_namespaces`), and the container runtime must use a seccomp policy
that permits Chromium's required `unshare(CLONE_NEWUSER)` /
`clone(...CLONE_NEWUSER...)` sandbox paths. Taurus fails fast when the probe is
blocked so operators are not misled into blaming sysctls alone.

Taurus's runtime fix is to keep the default Docker AppArmor profile, keep
`no-new-privileges` and the reduced capability allowlist, and supply a
Taurus-managed seccomp profile for agent containers. That profile is derived
from Docker's upstream `moby/profiles` default seccomp policy (currently pinned
to commit `836ae4d37ef2ec995c77c99fc55f5b5f3af3a897`) with only the narrow
Chromium sandbox syscalls added, and Taurus stamps the expected seccomp digest
into each container's metadata so reuse checks can prove which profile bytes
were applied at create time. Do not switch to `seccomp=unconfined`,
`apparmor=unconfined`, or `--no-sandbox` as the steady-state fix.

Helper-level validation failures and unknown actions exit nonzero so Taurus can
surface them as tool errors. The `resize` action accepts viewport dimensions
only in the range `1..1568` per axis, and also requires
`width × height <= 1,152,000` so screenshot JSON/base64 payloads stay within
the Browser tool's current 5,000,000-character output budget.

## Notes

- This repo currently has **no license**.
- If the Taurus application changes its expectations of either managed image,
  update this repo accordingly.
