# Pinned npm dependency sets

Each directory here is a small manifest plus its lockfile for one set of npm
packages baked into an image. The Dockerfiles install them with `npm ci`, which
resolves nothing: it installs exactly the tree the lockfile records, fetching
each tarball from the `resolved` URL written there and refusing any bytes that
do not match the recorded `integrity` hash.

Without a lockfile a global `npm install typescript@6.0.3` pins one version and
re-resolves everything underneath it on every rebuild, so two builds a week
apart can ship different transitive code and no record exists of what any past
image actually contained. These lockfiles are that record.

| Directory | Installed into |
| --- | --- |
| `base-toolchain` | base image: `tsc`, `tsserver`, `prettier`, `eslint` |
| `playwright` | base image: the Playwright CLI and library |
| `subscription` | subscription image: the Claude Code CLI and the MCP SDK |

## Changing a version

Edit the version in `package.json`, then regenerate that directory's lockfile:

```
cd npm/<directory>
npm install --package-lock-only --ignore-scripts --min-release-age=3
```

`--package-lock-only` resolves version metadata and rewrites the lockfile
without downloading a tarball or running any package code, so regenerating is
safe to do outside a container. `--min-release-age=3` refuses versions
published in the last three days; a release younger than that fails resolution
until it ages in, which is deliberate. The flag has no effect during the image
build, because `npm ci` reads the lockfile instead of resolving.

Read the regenerated lockfile's `resolved` and `integrity` entries as part of
the diff, not just the version numbers. `npm ci` fixes *which version* is
installed, but those two fields are what fix *where the bytes are fetched from*
and *which bytes are accepted* — and a `resolved` URL pointing somewhere other
than the expected registry, or an `integrity` hash that moved under a version
that did not, is invisible in a version-number review. Regeneration rewrites
them without comment, so they are only ever seen by someone who looks.

Commit `package.json` and `package-lock.json` together. A lockfile that
disagrees with its manifest fails `npm ci`, and therefore fails the build.

The subscription set duplicates two versions that also appear in
`subscription-runtime-versions.json`, the manifest baked into that image. The
workflow smoke reads it back, and so does the Taurus application when it brings
a sidecar up, comparing it against its own copy of the same strings. The image
build compares the manifest against these files and fails if they drift, so
update both in the same commit.
