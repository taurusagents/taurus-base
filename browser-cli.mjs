#!/usr/bin/env node
/**
 * browser-cli.mjs — Thin CLI wrapper around Playwright for agentic use.
 *
 * Keeps Chromium alive between invocations via CDP. State lives in /tmp so the
 * rootful Taurus shell can reconnect and control the browser across tool calls,
 * while Chromium itself runs under a dedicated non-root user with its sandbox
 * enabled.
 *
 * Usage: node /usr/local/lib/browser-cli.mjs '{"action":"open","url":"https://example.com"}'
 */

import { createRequire } from 'module';
const require = createRequire('/usr/lib/node_modules/');
const { chromium } = require('playwright');

import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { execFileSync, spawn } from 'child_process';

const STATE_FILE = '/tmp/.browser-cli.json';
const CDP_PORT = 9222;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const MAX_VIEWPORT_DIM = 1568;
// Keep screenshot JSON/base64 payloads below the Browser tool's 5,000,000-character
// stdout transport budget. Random-noise probes showed 1280x900 remains safely under
// the limit while larger common viewports such as 1440x900 can exceed it.
const MAX_VIEWPORT_AREA = 1_152_000;
const BROWSER_USER = process.env.TAURUS_BROWSER_USER || 'taurus-browser';
const BROWSER_HOME = process.env.TAURUS_BROWSER_HOME || `/home/${BROWSER_USER}`;
const BROWSER_PROFILE_DIR = `${BROWSER_HOME}/.config/chromium-profile`;
const BROWSER_RUNTIME_DIR = process.env.TAURUS_BROWSER_RUNTIME_DIR || '/tmp/taurus-browser-runtime';
const USERNS_CLONE_SYSCTL = '/proc/sys/kernel/unprivileged_userns_clone';
const MAX_USER_NAMESPACES_SYSCTL = '/proc/sys/user/max_user_namespaces';

let browserIdentityCache = null;

function browserSandboxConfigurationError(detail) {
  return new Error(
    `Chromium sandbox prerequisites are not available (${detail}). Taurus keeps Chromium sandboxing enabled and does not fall back to --no-sandbox. Ensure the Docker host allows unprivileged user namespaces (kernel.unprivileged_userns_clone=1 and user.max_user_namespaces > 0) and that the container runtime security policy is compatible with Chromium's user-namespace sandbox (especially the seccomp profile, not just the sysctls), then recreate the container if needed.`,
  );
}

function resolveBrowserIdentity() {
  if (browserIdentityCache) return browserIdentityCache;

  const uid = Number(execFileSync('id', ['-u', BROWSER_USER], { encoding: 'utf-8' }).trim());
  const gid = Number(execFileSync('id', ['-g', BROWSER_USER], { encoding: 'utf-8' }).trim());
  browserIdentityCache = { uid, gid };
  return browserIdentityCache;
}

function browserEnv() {
  return {
    ...process.env,
    HOME: BROWSER_HOME,
    USER: BROWSER_USER,
    LOGNAME: BROWSER_USER,
    XDG_CACHE_HOME: `${BROWSER_HOME}/.cache`,
    XDG_CONFIG_HOME: `${BROWSER_HOME}/.config`,
    XDG_STATE_HOME: `${BROWSER_HOME}/.local/state`,
    XDG_DATA_HOME: `${BROWSER_HOME}/.local/share`,
    XDG_RUNTIME_DIR: BROWSER_RUNTIME_DIR,
  };
}

function readOptionalIntegerFile(filePath) {
  try {
    const rawValue = readFileSync(filePath, 'utf-8').trim();
    if (rawValue.length === 0) return null;
    const parsed = Number.parseInt(rawValue, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function ensureWritableBrowserDirs() {
  const dirs = [
    BROWSER_HOME,
    `${BROWSER_HOME}/.cache`,
    `${BROWSER_HOME}/.config`,
    `${BROWSER_HOME}/.local`,
    `${BROWSER_HOME}/.local/state`,
    `${BROWSER_HOME}/.local/share`,
    BROWSER_PROFILE_DIR,
    BROWSER_RUNTIME_DIR,
  ];

  const { uid, gid } = resolveBrowserIdentity();
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    if (process.getuid?.() === 0) {
      chownSync(dir, uid, gid);
    }
  }

  chmodSync(BROWSER_RUNTIME_DIR, 0o700);
}

function assertBrowserLaunchUser() {
  const currentUid = process.getuid?.();
  if (currentUid === undefined) return;

  const { uid } = resolveBrowserIdentity();
  if (currentUid === 0 || currentUid === uid) {
    return;
  }

  throw new Error(`Browser helper must run as root or ${BROWSER_USER} to launch Chromium securely`);
}

function assertBrowserSandboxPrerequisites() {
  const unprivilegedUsernsClone = readOptionalIntegerFile(USERNS_CLONE_SYSCTL);
  if (unprivilegedUsernsClone === 0) {
    throw browserSandboxConfigurationError(`${USERNS_CLONE_SYSCTL}=0 on the Docker host kernel`);
  }

  const maxUserNamespaces = readOptionalIntegerFile(MAX_USER_NAMESPACES_SYSCTL);
  if (maxUserNamespaces !== null && maxUserNamespaces < 1) {
    throw browserSandboxConfigurationError(
      `${MAX_USER_NAMESPACES_SYSCTL}=${maxUserNamespaces} on the Docker host kernel`,
    );
  }

  const unsharePath = '/usr/bin/unshare';
  if (!existsSync(unsharePath)) return;

  const identity = resolveBrowserIdentity();
  try {
    execFileSync(unsharePath, ['--user', '--map-root-user', '/bin/true'], {
      stdio: 'pipe',
      env: browserEnv(),
      ...(process.getuid?.() === 0 ? { uid: identity.uid, gid: identity.gid } : {}),
    });
  } catch (err) {
    const detail = err && typeof err === 'object' && 'stderr' in err && err.stderr
      ? String(err.stderr).trim() || err.message
      : err instanceof Error
        ? err.message
        : String(err);
    throw browserSandboxConfigurationError(`user-namespace sandbox probe failed: ${detail}`);
  }
}

// ── State persistence ──

function loadState() {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch { /* corrupt state */ }
  return null;
}

function saveState(state) {
  const viewport = normalizeViewport(state?.viewport) || DEFAULT_VIEWPORT;
  const nextState = { viewport };
  if (typeof state?.cdpUrl === 'string' && state.cdpUrl.length > 0) {
    nextState.cdpUrl = state.cdpUrl;
  }
  writeFileSync(STATE_FILE, JSON.stringify(nextState), 'utf-8');
}

function clearState() {
  try { unlinkSync(STATE_FILE); } catch { /* ignore */ }
}

function closeBrowserProcess() {
  try {
    execFileSync('pkill', ['-u', BROWSER_USER, '-f', `chrome.*--remote-debugging-port=${CDP_PORT}`], { stdio: 'ignore' });
  } catch {
    /* browser already gone */
  }
}

function normalizeViewport(value) {
  const width = Number(value?.width);
  const height = Number(value?.height);
  if (getViewportValidationError(width, height)) {
    return null;
  }
  return { width, height };
}

function getViewportValidationError(width, height) {
  if (
    !Number.isInteger(width)
    || width < 1
    || width > MAX_VIEWPORT_DIM
    || !Number.isInteger(height)
    || height < 1
    || height > MAX_VIEWPORT_DIM
    || width * height > MAX_VIEWPORT_AREA
  ) {
    return `"width" and "height" are required integers between 1 and ${MAX_VIEWPORT_DIM}, and width × height must not exceed ${MAX_VIEWPORT_AREA} CSS pixels so screenshot payloads stay within the current transport budget.`;
  }
  return null;
}

function throwValidationError(message) {
  throw new Error(message);
}

function getPersistedViewport(state) {
  return normalizeViewport(state?.viewport) || DEFAULT_VIEWPORT;
}

async function ensurePageViewport(page, viewport) {
  const current = page.viewportSize();
  if (!current || current.width !== viewport.width || current.height !== viewport.height) {
    await page.setViewportSize(viewport);
  }
  return page.viewportSize() || viewport;
}

async function getRealViewport(page) {
  return page.viewportSize()
    || normalizeViewport(await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })))
    || DEFAULT_VIEWPORT;
}

async function ensurePrimaryPage(browser, viewport) {
  const contexts = browser.contexts();
  const ctx = contexts[0] || await browser.newContext({ viewport, userAgent: USER_AGENT });
  const pages = ctx.pages();
  const page = pages[0] || await ctx.newPage();
  const appliedViewport = await ensurePageViewport(page, viewport);
  return { page, viewport: appliedViewport };
}

// ── Launch or connect to Chromium ──

async function ensureBrowser() {
  const state = loadState();
  const desiredViewport = getPersistedViewport(state);

  // Try reconnecting to existing browser
  if (state?.cdpUrl) {
    try {
      const browser = await chromium.connectOverCDP(state.cdpUrl, { timeout: 3000 });
      const { page, viewport } = await ensurePrimaryPage(browser, desiredViewport);
      saveState({ cdpUrl: state.cdpUrl, viewport });
      return { browser, page };
    } catch {
      // Browser died — drop the stale connection details but preserve the last viewport choice.
      saveState({ viewport: desiredViewport });
    }
  }

  assertBrowserLaunchUser();
  ensureWritableBrowserDirs();
  assertBrowserSandboxPrerequisites();

  // Launch Chromium with remote debugging. The Taurus container stays rootful,
  // but the browser process itself drops to a dedicated non-root user so Chromium
  // can keep its sandbox enabled.
  const chromePath = chromium.executablePath();
  const identity = resolveBrowserIdentity();
  const child = spawn(chromePath, [
    '--headless', '--disable-gpu', '--disable-dev-shm-usage',
    `--user-agent=${USER_AGENT}`,
    `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${BROWSER_PROFILE_DIR}`,
  ], {
    stdio: 'ignore',
    detached: true,
    cwd: BROWSER_HOME,
    env: browserEnv(),
    ...(process.getuid?.() === 0 ? { uid: identity.uid, gid: identity.gid } : {}),
  });
  child.unref();

  // Wait for CDP to be ready
  const cdpUrl = `http://127.0.0.1:${CDP_PORT}`;
  for (let i = 0; i < 30; i++) {
    try {
      const resp = await fetch(`${cdpUrl}/json/version`);
      if (resp.ok) break;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 200));
  }

  const browser = await chromium.connectOverCDP(cdpUrl);
  const { page, viewport } = await ensurePrimaryPage(browser, desiredViewport);

  saveState({ cdpUrl, viewport });
  return { browser, page };
}

// ── Actions ──

async function handleAction(input) {
  const { action } = input;

  if (action === 'close') {
    closeBrowserProcess();
    clearState();
    return 'Browser closed.';
  }

  if (action === 'resize') {
    const validationError = getViewportValidationError(Number(input.width), Number(input.height));
    if (validationError) {
      throwValidationError(validationError);
    }
  }

  const { browser, page } = await ensureBrowser();

  try {
    switch (action) {
      case 'open': {
        if (!input.url) throwValidationError('"url" is required.');
        const response = await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const status = response?.status() ?? 'unknown';
        const title = await page.title();
        return `Navigated to ${input.url}\nTitle: ${title}\nStatus: ${status}`;
      }

      case 'snapshot': {
        const url = page.url();
        const title = await page.title();

        // Use CDP to get the accessibility tree
        const cdp = await page.context().newCDPSession(page);
        let nodes;
        try {
          ({ nodes } = await cdp.send('Accessibility.getFullAXTree'));
        } finally {
          await cdp.detach();
        }

        const tree = formatAXNodes(nodes);
        return `URL: ${url}\nTitle: ${title}\n\n${tree}`;
      }

      case 'click': {
        if (!input.selector) throwValidationError('"selector" is required.');
        await page.click(input.selector, { timeout: 5000 });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        return `Clicked: ${input.selector}`;
      }

      case 'type': {
        if (!input.selector) throwValidationError('"selector" is required.');
        if (input.text === undefined) throwValidationError('"text" is required.');
        await page.fill(input.selector, input.text, { timeout: 5000 });
        return `Typed into ${input.selector}: "${input.text}"`;
      }

      case 'select': {
        if (!input.selector) throwValidationError('"selector" is required.');
        if (!input.values?.length) throwValidationError('"values" is required.');
        await page.selectOption(input.selector, input.values, { timeout: 5000 });
        return `Selected ${input.values.join(', ')} in ${input.selector}`;
      }

      case 'hover': {
        if (!input.selector) throwValidationError('"selector" is required.');
        await page.hover(input.selector, { timeout: 5000 });
        return `Hovered: ${input.selector}`;
      }

      case 'screenshot': {
        const buffer = await page.screenshot({ fullPage: false });
        const title = await page.title();
        const url = page.url();
        const viewport = await getRealViewport(page);
        return JSON.stringify({
          __type: 'screenshot',
          text: `Screenshot of "${title}" (${url})\nViewport: ${viewport.width}x${viewport.height}, ${buffer.length} bytes`,
          base64: buffer.toString('base64'),
          mediaType: 'image/png',
        });
      }

      case 'resize': {
        const viewport = normalizeViewport(input);
        if (!viewport) {
          throwValidationError(getViewportValidationError(Number(input.width), Number(input.height)));
        }
        await page.setViewportSize(viewport);
        const appliedViewport = await getRealViewport(page);
        saveState({ ...loadState(), viewport: appliedViewport });
        return `Viewport resized to ${appliedViewport.width}x${appliedViewport.height}`;
      }

      case 'scroll': {
        const delta = input.direction === 'up' ? -(input.amount ?? 300) : (input.amount ?? 300);
        await page.mouse.wheel(0, delta);
        await new Promise(r => setTimeout(r, 300));
        return `Scrolled ${input.direction ?? 'down'} by ${Math.abs(delta)}px`;
      }

      case 'back': {
        await page.goBack({ waitUntil: 'domcontentloaded' });
        return `Navigated back to: ${page.url()}`;
      }

      case 'forward': {
        await page.goForward({ waitUntil: 'domcontentloaded' });
        return `Navigated forward to: ${page.url()}`;
      }

      case 'wait': {
        const ms = input.ms ?? 1000;
        await new Promise(r => setTimeout(r, ms));
        return `Waited ${ms}ms`;
      }

      case 'evaluate': {
        if (!input.expression) throwValidationError('"expression" is required.');
        const result = await page.evaluate(input.expression);
        return typeof result === 'string' ? result : JSON.stringify(result, null, 2) ?? 'undefined';
      }

      case 'press': {
        if (!input.key) throwValidationError('"key" is required.');
        if (input.selector) {
          await page.press(input.selector, input.key, { timeout: 5000 });
        } else {
          await page.keyboard.press(input.key);
        }
        return `Pressed: ${input.key}${input.selector ? ` on ${input.selector}` : ''}`;
      }

      case 'upload': {
        if (!input.selector) throwValidationError('"selector" is required.');
        if (!input.files?.length) throwValidationError('"files" is required (array of paths).');
        await page.setInputFiles(input.selector, input.files, { timeout: 5000 });
        return `Uploaded ${input.files.length} file(s) to ${input.selector}: ${input.files.join(', ')}`;
      }

      default:
        throwValidationError(`Unknown action "${action}"`);
    }
  } finally {
    // Disconnect CDP but leave Chromium running
    browser.close().catch(() => {});
  }
}

// ── Snapshot formatting (CDP AX tree) ──

function formatAXNodes(nodes) {
  if (!nodes?.length) return '(empty page)';

  // Build parent→children map
  const childMap = new Map();
  const nodeMap = new Map();
  for (const n of nodes) {
    nodeMap.set(n.nodeId, n);
    if (n.childIds) {
      childMap.set(n.nodeId, n.childIds);
    }
  }

  function prop(n, name) {
    return n.properties?.find(p => p.name === name)?.value?.value;
  }

  function render(nodeId, depth) {
    const n = nodeMap.get(nodeId);
    if (!n) return '';
    const role = n.role?.value || '';
    const name = n.name?.value || '';
    const value = n.value?.value;
    const children = childMap.get(nodeId) || [];

    // Skip noise — inline text, generics, and leaf StaticText (parent already has the name)
    const skip = ['none', 'generic', 'InlineTextBox', 'LineBreak'].includes(role)
      || (role === 'StaticText' && children.length === 0);
    const lines = [];
    const indent = '  '.repeat(depth);

    if (!skip && role) {
      const parts = [role];
      if (name) parts.push(`"${name}"`);
      if (value) parts.push(`value="${value}"`);
      const checked = prop(n, 'checked');
      if (checked) parts.push(`checked=${checked}`);
      const expanded = prop(n, 'expanded');
      if (expanded !== undefined) parts.push(`expanded=${expanded}`);
      lines.push(`${indent}${parts.join(' ')}`);
    }

    for (const cid of children) {
      const sub = render(cid, skip ? depth : depth + 1);
      if (sub) lines.push(sub);
    }
    return lines.join('\n');
  }

  // Root is typically nodeId of first node
  return render(nodes[0].nodeId, 0);
}

// ── Main ──

try {
  const input = JSON.parse(process.argv[2] || '{}');
  const result = await handleAction(input);
  process.stdout.write(result);
} catch (err) {
  process.stderr.write(`Browser error: ${err.message}\n`);
  process.exit(1);
}
