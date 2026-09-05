# Taurus Base image
# Build: docker build -t taurus-base .
# Usage: use this image as the default Taurus agent container image.

# Keep this on the newest Ubuntu LTS that Playwright officially supports.
# Ubuntu 26.04 LTS is released, but Playwright 1.59 does not yet support
# bundled Chromium on ubuntu26.04-x64; revisit after Playwright support lands.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# The uv, Go and asdf archives below are pinned to a version and compared
# against a SHA-256 written down beside them, and those checksums are of the
# amd64 builds. amd64 is the only architecture this image is built for, so stop
# here rather than reach the first comparison with a file it was never computed
# from. This says nothing about the rest of what the build fetches: the npm
# installs carry their own hashes in their lockfiles, while the pip packages and
# the Chromium download carry no committed digest at all.
RUN [ "$(dpkg --print-architecture)" = amd64 ] \
    || { echo "taurus-base is built for amd64 only; the pinned checksums do not cover $(dpkg --print-architecture)." >&2; exit 1; }

# ── Core utilities ──
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    bc \
    file \
    git \
    curl \
    wget \
    jq \
    dnsutils \
    whois \
    tree \
    vim \
    less \
    htop \
    time \
    lsof \
    iproute2 \
    netcat-openbsd \
    iputils-ping \
    traceroute \
    psmisc \
    moreutils \
    unzip \
    zip \
    p7zip-full \
    make \
    build-essential \
    sqlite3 \
    poppler-utils \
    imagemagick \
    openssh-client \
    ca-certificates \
    gnupg \
    ripgrep \
    fd-find \
    uuid-runtime \
    rsync \
    && ln -s $(which fdfind) /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# ── Python 3 + common libraries ──
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    && ln -s /usr/bin/python3 /usr/local/bin/python \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir \
    requests==2.34.2 \
    beautifulsoup4==4.14.3 \
    lxml==6.1.1 \
    pandas==2.3.3 \
    numpy==2.2.6 \
    matplotlib==3.10.9 \
    pyyaml==6.0.3 \
    flask==3.1.3 \
    pytest==9.0.3 \
    ruff==0.15.14 \
    black==26.5.1 \
# uv's convenience installer fetches whatever release is current and drops the
# binaries in root's home, where only login shells find them. Take the release
# archive instead: it is a fixed version whose checksum Astral publishes beside
# it, and /usr/local/bin is on every shell's PATH.
    && curl -fsSL -o /tmp/uv.tar.gz https://github.com/astral-sh/uv/releases/download/0.12.9/uv-x86_64-unknown-linux-gnu.tar.gz \
    && echo "ec7a99cd05e0cd7f80243f135ce1361c76835cb0ee60055d14d20eba8eba1460  /tmp/uv.tar.gz" | sha256sum -c - \
    && tar xzf /tmp/uv.tar.gz -C /usr/local/bin --strip-components=1 \
        uv-x86_64-unknown-linux-gnu/uv uv-x86_64-unknown-linux-gnu/uvx \
    && rm -f /tmp/uv.tar.gz \
    && uv --version

# ── Node.js 24 (NodeSource) ──
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs=24.15.0-1nodesource1 \
    && rm -rf /var/lib/apt/lists/* \
# Ship a pinned pnpm in-image via Corepack so containers do not depend on a
# network fetch the first time pnpm is used. The trailing hash is part of the
# version string Corepack accepts: it hashes the downloaded tarball and refuses
# to install anything that does not match, instead of trusting whatever the
# registry serves for that version number. This is the same string Taurus
# projects pin, so a container's pnpm and its projects' pnpm are the same bytes.
    && corepack enable pnpm --install-directory /usr/bin \
    && corepack prepare pnpm@10.34.5+sha512.a4ee05f2f73658255bd6a89859c065a45c28a57daefae2c893a168ee2b73168c37b91e83e57ea67654ad03f03031746430e8bce38e362e042605fb8abc80192e --activate

# ── Go ──
# Checksum as published by go.dev/dl for this archive.
RUN curl -fsSL -o /tmp/go.tar.gz https://go.dev/dl/go1.24.3.linux-amd64.tar.gz \
    && echo "3333f6ea53afa971e9078895eaa4ac7204a8c6b5c68c10e6bc9a33e8e391bdd8  /tmp/go.tar.gz" | sha256sum -c - \
    && tar xzf /tmp/go.tar.gz -C /usr/local \
    && rm -f /tmp/go.tar.gz
ENV PATH="/usr/local/go/bin:${PATH}"

# ── asdf version manager ──
# asdf publishes only an MD5 next to its release archives, which is too weak to
# rely on, so this is GitHub's own SHA-256 of the stored release asset. It was
# checked against upstream's MD5 of the same bytes when it was written down.
RUN curl -fsSL -o /tmp/asdf.tar.gz https://github.com/asdf-vm/asdf/releases/download/v0.18.1/asdf-v0.18.1-linux-amd64.tar.gz \
    && echo "56141dc99eab75c140dcdd85cf73f3b82fed2485a8dccd4f11a4dc5cbcb6ea5c  /tmp/asdf.tar.gz" | sha256sum -c - \
    && tar xzf /tmp/asdf.tar.gz -C /usr/local/bin \
    && rm -f /tmp/asdf.tar.gz \
    && chmod +x /usr/local/bin/asdf

# ── GitHub CLI ──
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# ── Dedicated browser user/state ──
# Taurus containers stay rootful overall so agents can apt-get and own the box,
# but Chromium itself runs as a separate non-root user with its own writable
# home/cache/profile directories. The host kernel still needs unprivileged user
# namespaces enabled so Chromium's sandbox can start under no-new-privileges.
RUN useradd -r -m -d /home/taurus-browser -s /usr/sbin/nologin taurus-browser \
    && mkdir -p /home/taurus-browser/.cache \
        /home/taurus-browser/.config \
        /home/taurus-browser/.local/state \
        /home/taurus-browser/.local/share \
        /tmp/taurus-browser-runtime \
        /ms-playwright \
    && chown -R taurus-browser:taurus-browser /home/taurus-browser /tmp/taurus-browser-runtime /ms-playwright \
    && chmod 700 /tmp/taurus-browser-runtime

# ── Playwright + Chromium ──
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# `npm ci` installs exactly the tree recorded in the lockfile, so every version
# and tarball hash in it — not just the one named in package.json — is fixed at
# the moment the lockfile was committed and reviewed. Each set installs into its
# own directory: a shared one would hoist the trees together, and a dependency
# of one set could then quietly decide the version another set gets.
#
# `--ignore-scripts` blocks install hooks, which is how a hostile npm package
# normally gets to run code. The only hook anywhere in this set belongs to a
# macOS-only optional dependency that never installs here. Chromium is
# downloaded afterwards by the installed Playwright CLI rather than by a hook,
# so blocking hooks does not affect it.
#
# The symlinks put the results back where the rest of the system looks for them:
# NODE_PATH points at /usr/lib/node_modules, browser-cli.mjs resolves Playwright
# from that directory by name, and the CLI is called by absolute path. Node
# resolves a symlink to its real location before looking for a package's own
# dependencies, so each package still finds those inside its own set rather than
# across sets.
COPY npm/playwright/package.json npm/playwright/package-lock.json /opt/taurus-npm/playwright/
RUN npm ci --prefix /opt/taurus-npm/playwright --ignore-scripts \
    && ln -s /opt/taurus-npm/playwright/node_modules/playwright /usr/lib/node_modules/playwright \
    && ln -s /opt/taurus-npm/playwright/node_modules/playwright/cli.js /usr/bin/playwright \
    && playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright

# ── TypeScript / Prettier / ESLint ──
# Installed from its own lockfile into its own tree and symlinked into the same
# two places as the Playwright set above, for the same reasons. Nothing in this
# set declares an install hook at all. It comes after the Chromium download so
# that changing a version here does not repeat it.
COPY npm/base-toolchain/package.json npm/base-toolchain/package-lock.json /opt/taurus-npm/base-toolchain/
RUN npm ci --prefix /opt/taurus-npm/base-toolchain --ignore-scripts \
    && ln -s /opt/taurus-npm/base-toolchain/node_modules/typescript /usr/lib/node_modules/typescript \
    && ln -s /opt/taurus-npm/base-toolchain/node_modules/prettier /usr/lib/node_modules/prettier \
    && ln -s /opt/taurus-npm/base-toolchain/node_modules/eslint /usr/lib/node_modules/eslint \
    && ln -s /opt/taurus-npm/base-toolchain/node_modules/typescript/bin/tsc /usr/bin/tsc \
    && ln -s /opt/taurus-npm/base-toolchain/node_modules/typescript/bin/tsserver /usr/bin/tsserver \
    && ln -s /opt/taurus-npm/base-toolchain/node_modules/prettier/bin/prettier.cjs /usr/bin/prettier \
    && ln -s /opt/taurus-npm/base-toolchain/node_modules/eslint/bin/eslint.js /usr/bin/eslint \
    && tsc --version \
    && prettier --version \
    && eslint --version \
# tsserver reads a request stream rather than answering --version, so the most
# it can be asked at build time is whether the link leads to a runnable file.
    && test -x /usr/bin/tsserver

# ── Browser CLI helper ──
COPY browser-cli.mjs /usr/local/lib/browser-cli.mjs
ENV NODE_PATH=/usr/lib/node_modules

WORKDIR /workspace
