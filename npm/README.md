# Pinned npm dependency sets

Each directory here is a small manifest plus its lockfile for one set of npm
packages baked into an image. The Dockerfiles install them with `npm ci`, which
installs exactly the versions and tarball hashes recorded in the lockfile and
contacts the registry only to fetch those exact tarballs.

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

Commit `package.json` and `package-lock.json` together. A lockfile that
disagrees with its manifest fails `npm ci`, and therefore fails the build.

The subscription set duplicates two versions that also appear in
`subscription-runtime-versions.json`, the manifest baked into that image and
checked by the workflow smoke. The image build compares the two and fails if
they drift, so update both in the same commit.
