# Taurus Base image
# Build: docker build -t taurus-base .
# Usage: use this image as the default Taurus agent container image.

# Keep this on the newest Ubuntu LTS that Playwright officially supports.
# Ubuntu 26.04 LTS is released, but Playwright 1.59 does not yet support
# bundled Chromium on ubuntu26.04-x64; revisit after Playwright support lands.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

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
    && curl -LsSf https://astral.sh/uv/install.sh | sh

# ── Node.js 24 (NodeSource) ──
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs=24.15.0-1nodesource1 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g typescript@6.0.3 prettier@3.8.3 eslint@10.4.0

# ── Go ──
RUN curl -fsSL https://go.dev/dl/go1.24.3.linux-$(dpkg --print-architecture).tar.gz \
    | tar xz -C /usr/local
ENV PATH="/usr/local/go/bin:${PATH}"

# ── asdf version manager ──
RUN curl -fsSL https://github.com/asdf-vm/asdf/releases/download/v0.18.1/asdf-v0.18.1-linux-$(dpkg --print-architecture).tar.gz \
    | tar xz -C /usr/local/bin \
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
RUN npm install -g playwright@1.60.0 \
    && playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright

# ── Browser CLI helper ──
COPY browser-cli.mjs /usr/local/lib/browser-cli.mjs
ENV NODE_PATH=/usr/lib/node_modules

WORKDIR /workspace
