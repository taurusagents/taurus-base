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
- `patches/codex-local-compaction.patch` — the Taurus fork patch applied to the pinned Codex source; see [Codex fork patch](#codex-fork-patch) for everything it changes
- `browser-cli.mjs` — Playwright-backed browser helper copied into the main `taurus-base` image
- `npm/` — the manifest and lockfile for each set of npm packages installed into an image; see [`npm/README.md`](npm/README.md)

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
- Browser helper support for WebGL2 via SwiftShader software rendering, console/log capture, and native keyboard/mouse input actions

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
- `@anthropic-ai/claude-code@2.1.260`
- patched source build of `openai/codex` `rust-v0.153.4` (the Taurus fork — see [Codex fork patch](#codex-fork-patch))
- `@modelcontextprotocol/sdk@1.29.0`
- version manifest at `/usr/local/lib/taurus-subscription/runtime-versions.json`

The manifest is not only a record. The `taurus-agents` repository keeps its own
copy of these version strings, and when Taurus brings a sidecar up it reads the
manifest out of the container and reports any disagreement instead of quietly
serving a runtime it was not written for. An image bump and the matching change
to those strings therefore belong in the same window; the check exists to make
the gap between them loud rather than to be relied on as normal.

⚠️ Bumping `@anthropic-ai/claude-code` has three prerequisites. None of them
runs in any automated suite, so whatever a bump leaves out is simply not checked
before the image ships.

- Run `tests/staging/cc-session-repair-canary.ts` from the `taurus-agents`
  repository against the new CLI binary, pointed at it via
  `CC_CANARY_CLAUDE_BIN`. Taurus ports the CLI's resume-time session-repair
  classifier, and this re-verifies every known session-tail shape against the
  real binary; a silent semantic change there can reintroduce transcript
  pollution.
- Run `tests/staging/claude-session-ownership-canary.ts` from the same
  repository, the same way. It covers the session fork and crash re-entry
  behaviour Taurus resumes on top of, which is undocumented in the same way and
  can break independently of the repair classifier.
- Re-verify that `CLAUDE_CODE_DISABLE_ATTACHMENTS` still disables the CLI's
  `@path` file-read pipeline. Taurus sets that variable in every sidecar and
  never exposes the attachment UX, and nothing observable at runtime reports
  whether the variable is still honoured, so only reading the new binary can
  answer it.

Both canaries carry that re-run requirement in their own headers too. The third
prerequisite has no such home, which is why it is written down here.

What reading the 2.1.260 binary established for that third item: both gates the
`@path` pipeline passes through are present and structurally identical to the
ones in 2.1.207, and the variable is now read through a centralised environment
accessor instead of at each gate — a refactor rather than a behaviour change.
Its reach has widened, though: at 2.1.260 the same variable also disables a
"kept deferred tools" feature it did not previously touch. Whether that
additional effect matters here was not established, and nothing above should be
read as saying it was.

The session-repair canary has one known-failing row. As of the 2026-09-07 run
for the 2.1.207 → 2.1.260 bump, `snapshot 2b: path-resume tip mirror survives a
trailing system child on the live branch` fails — and a baseline run of the same
canary against 2.1.207 fails the identical row. It is a pre-existing divergence
between the application's mirror of the CLI's resume-tip selection and the CLI
itself, not something the bump introduced, and it is tracked separately in the
`taurus-agents` repository. Every other row passed on both binaries. Exactly
that one row, by that name, is expected red; any other failing row is a real
signal, and a red run should be compared against this paragraph rather than
waved through.

⚠️ Bumping the pinned Codex source carries obligations too, and they are
quieter than the Claude ones because the config key they rest on fails open.
Taurus hands Codex a compaction prompt through
`experimental_compact_prompt_file` in the config it generates for the sidecar.
That key is experimental: if a later Codex renames or drops it, the line is
ignored — no validation error, no warning — and every run on this binary falls
back to Codex's own short built-in summarization prompt instead. Before moving
the pin, re-verify in the new source that:

1. `experimental_compact_prompt_file` still exists and still reaches local
   compaction. It is read once while the config loads and folded into the same
   field an inline `compact_prompt` would set, and both local entry points — a
   requested compaction and an automatic one — use that field, falling back to
   the built-in prompt when it is unset.
2. The rebuild shape that prompt describes to the model still holds: the
   retained tail is a roughly twenty-thousand-token budget of the most recent
   user messages, the oldest truncated to fit, and the summary is appended as
   the final message after that tail.
3. The summary preamble Codex prepends when it re-inserts a summary
   (codex-rs `prompts/templates/compact/summary_prefix.md`) still both marks the
   text as a summary and attributes it to the model itself. Note the preamble
   this image ships is the fork's reframed wording, not upstream's — see
   [Codex fork patch](#codex-fork-patch).
4. The `[skills]` keys the sidecar's generated config pins
   (`include_instructions`, `bundled.enabled`) still exist and still gate the
   skills instruction block and bundled-skill loading. Codex parses
   `bundled.enabled` fail-open, so a shape change re-enables bundled skills with
   nothing louder than a stderr warning.

All four were re-verified unchanged at `rust-v0.153.4`. They are pinned from the
other side as well: a tripwire test in the `taurus-agents` repository asserts the
Codex version recorded here and fails when it moves, so the obligations are
re-read rather than remembered.

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

### Codex fork patch

`patches/codex-local-compaction.patch` is applied to the pinned upstream source
before the build. The resulting binary is identified by `codexVariant` in
`subscription-runtime-versions.json`, whose trailing revision number names a
revision of this patch; bump that string whenever the patch changes.

`codexPatchSha256` in the same manifest is what makes that identification true
rather than merely intended. It is the SHA-256 of the patch file, and the build
hashes the patch it is about to apply and refuses to compile anything the
manifest does not name — before the toolchain is installed, so a mismatch is
reported in seconds instead of after the Rust build. Without it, "bump the
variant whenever the patch changes" was a rule written down only in this
paragraph, and prose does not stop anyone editing the patch and leaving the
string alone. Editing the patch therefore means updating both fields in the same
commit; `sha256sum patches/codex-local-compaction.patch` gives the new value.

What the patch does:

- **Forces local compaction.** The configured model provider reports remote
  compaction as unsupported. Both sites that dispatch on that capability — a
  requested compaction and an automatic one — therefore run Codex's own
  client-side summarization instead of the provider-side task. Everything below
  depends on it: on the remote path Codex never sees the summary text at all.
  The capability is not the only thing that decides, though. Both sites check
  Codex's `token_budget` feature before they look at it, and that path asks the
  provider nothing and produces no summary. It is off by default and this fork
  relies on it staying off; turning it on silently disables everything here.
- **Exposes the summary on the wire.** The app-server v2 `contextCompaction`
  item carries a `summary` field holding the plain summary body, without the
  `SUMMARY_PREFIX` boilerplate Codex prepends for the model's own benefit.
  This is a live-stream field only. Rebuilt thread history — a `threadItems/list`
  or a resume — materializes compaction items from the legacy compaction event,
  which has no summary on it, so those read the field back as absent. A client
  that needs the text has to keep it when it streams; asking for it later
  returns nothing, and nothing distinguishes that from a compaction that
  genuinely produced no summary.
- **Scopes the summary to the compaction turn.** The summary is read from the
  items that compaction request produced, not from a backwards scan of the whole
  session history — a compaction that answered with nothing would otherwise
  publish the last assistant message of the actual task as its "summary". When
  the compaction turn produced no assistant reply, `summary` is absent from the
  item and the replacement history says `(no summary available)`.
- **Reframes `SUMMARY_PREFIX` for self-continuity.** The preamble that
  introduces a carried-over summary used to describe it as the work of "another
  language model"; it now addresses the model as the author of its own earlier
  summary. Recognition of a summary (`is_summary_message`) is left exactly as
  upstream wrote it, matching the current preamble only — deployment replaces
  every sidecar at once, so no compatibility path is kept for the old wording.
  A thread that compacted before the swap carries an old-prefix summary in its
  rollout; when it compacts again on the new binary that summary is retained as
  an ordinary user message instead of being dropped. That is bounded and
  self-limiting: at most one such message per pre-swap thread, and every summary
  written afterwards matches again.
- **Drops Taurus post-compaction notes from rebuilt histories.** Messages
  starting with `<post-compaction-note` are filtered out alongside old
  summaries. Those notes describe the boundary they were written at, so
  retaining them into a later rebuild puts them somewhere they do not describe.
  The tag is a contract with the Taurus runtime, which writes the envelope in
  `wrapPostCompactionMaterial` (`src/agents/post-compaction-material.ts` in the
  `taurus-agents` repository); neither side may change it alone.

Adding `summary` to the compaction item makes any exhaustive match on that item
a compile error, so the patch also relaxes the one such match, in the TUI's
thread listing. That listing keeps upstream's output and leaves the summary out:
the summary is meant for app-server clients reading the thread stream, not for an
untruncated dump into a model-facing payload.

The tests this fork's own behaviour depends on are adapted rather than left to
fail: the provider-capability tests now expect forced-local compaction, the
app-server test that asserted remote dispatch now asserts that a provider
upstream would route remotely still compacts locally and never calls the compact
endpoint, and the local compaction test asserts the summary that reaches the
client.

Upstream's suite as a whole is *not* expected to pass on this fork, and adapting
it is not a goal. `codex-rs/core/tests/suite/compact_remote.rs` drives compaction
through the capability dispatch with an OpenAI-named provider across roughly
thirty tests that now take the local path; `codex-rs/core/tests/common/context_snapshot.rs`
hard-codes the old summary preamble; and the generated schema fixtures under
`codex-rs/app-server-protocol/schema/` do not know about the added `summary`
field, so the fixture-comparison tests fail too. None of it is compiled by the
`-p codex-cli --bin codex` build this image performs.

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
only in the range `1..3840` per axis, and also requires
`width × height <= 3,686,400` (2560x1440). Screenshots stay lossless PNG at
every viewport: even a worst-case incompressible-noise page at that ceiling
encodes to roughly 14.5M base64 characters, inside the Browser tool's
20,000,000-character output budget, and real pages are far smaller. Fitting the
image to what a model can read is the Taurus application's job, not the
helper's.

## Notes

- This repo currently has **no license**.
- If the Taurus application changes its expectations of either managed image,
  update this repo accordingly.
