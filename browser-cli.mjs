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
  renameSync,
  writeFileSync,
} from 'fs';
import { execFileSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';

const STATE_FILE = '/tmp/.browser-cli.json';
const CDP_PORT = 9222;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const MAX_VIEWPORT_DIM = 3840;
// Screenshots stay lossless PNG at every size, so the ceiling is purely a
// transport question: a worst-case incompressible-noise PNG at 2560x1440 is
// roughly 15M base64 characters, safely inside the Browser tool's 20,000,000
// character stdout budget, and real pages encode far smaller. Shrinking the
// image for the model is handled on the Taurus side, not here.
const MAX_VIEWPORT_AREA = 3_686_400;
const CONSOLE_SETTLE_MS = 300;
const MAX_CONSOLE_ENTRIES = 200;
const MAX_CONSOLE_ENTRY_LENGTH = 500;
// The in-page console buffer is page-writable, so bound what we are willing to
// pull out of it per capture: enough to cover the entries we could display,
// small enough that a page cannot make the helper transfer an arbitrary payload.
const MAX_PAGE_CONSOLE_ENTRIES_READ = 500;
const MAX_PAGE_CONSOLE_ENTRY_READ_LENGTH = 2_000;
// Console entry types the in-page shim can produce. Applied when reading the
// buffer so a page cannot mint a type that reads as browser-attested.
const SHIM_CONSOLE_ENTRY_TYPES = new Set([
  'debug', 'log', 'info', 'warn', 'error', 'dir', 'dirxml', 'trace', 'table',
  'group', 'groupCollapsed', 'groupEnd', 'assert', 'count', 'timeEnd', 'timeLog', 'timeStamp',
]);
// Wall-clock slack when clamping page-reported timestamps against the
// browser-reported navigation start, which are sampled from different clocks a
// few milliseconds apart.
const NAVIGATION_START_TOLERANCE_MS = 1_000;
// Fallback lower bound when the browser cannot tell us when the document
// started: still bounds the past, just less tightly.
const MAX_UNVERIFIED_DOCUMENT_AGE_MS = 24 * 60 * 60 * 1_000;
// Console output is trimmed for readability before it ever reaches the protocol
// envelope. The envelope itself has a much larger separate transport budget.
const MAX_CONSOLE_OUTPUT_LENGTH = 100_000;
// Text Browser results are expected to stay comfortably below a megabyte in real
// use. Keep the protocol envelope itself to a modest size so one hostile page
// cannot make either the helper or the daemon allocate tens of megabytes just to
// carry a forged wall of text.
const MAX_TEXT_PROTOCOL_STDOUT_BYTES = 4_000_000;
const TRUNCATED_PROTOCOL_OUTPUT_SUFFIX = '\n\n[Browser helper truncated the rest of this output to keep the protocol envelope within Taurus transport limits.]';
const TRUNCATED_SCREENSHOT_FIELD_SUFFIX = '…[truncated]';
const MAX_SCREENSHOT_TITLE_SUMMARY_CHARS = 2_048;
const MAX_SCREENSHOT_URL_SUMMARY_CHARS = 4_096;
const DEVTOOLS_HTTP_TIMEOUT_MS = 2_000;
const ATTACH_RETRY_TIMEOUT_MS = 3_000;
const ATTACH_RECOVERY_TIMEOUT_MS = 5_000;
const ATTACH_RECOVERY_BACKOFF_MS = 750;
// Best-effort guard for the one shared default session used by manual CLI
// callers. When that session opens extra tabs, foregrounding its own page keeps
// screenshots and snapshots usable without reintroducing cross-run interference
// for the protocol-controlled per-run sessions.
const BRING_TO_FRONT_TIMEOUT_MS = 2_000;
// Closing the browser is only done once per session, so waiting a few seconds
// for it to exit is cheap next to attaching to a half-dead browser.
const BROWSER_EXIT_POLL_ATTEMPTS = 50;
const BROWSER_EXIT_POLL_INTERVAL_MS = 100;
// Discarding a restored tab must not become the slowest part of a launch.
const PAGE_CLOSE_TIMEOUT_MS = 2_000;
const LOCKED_BROWSER_CONNECTION_TIMEOUT_MS = 15_000;
const LOCKED_PAGE_SETUP_TIMEOUT_MS = 5_000;
const FRESH_BROWSER_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_DRAG_STEPS = 10;
const MAX_DRAG_STEPS = 1_000;
const MAX_WAIT_MS = 60_000;
// Ceiling for one page action. Most of what an action does already carries its
// own timeout — navigation, clicks, fills, screenshots — but several steps have
// none to give: `evaluate` accepts no timeout option at all, and mouse and
// keyboard input is dispatched to the page without one. A page that spins its
// renderer, or an expression that simply never returns, would otherwise keep
// this helper and whoever is waiting on it alive indefinitely. A `wait` action
// may legitimately sleep for MAX_WAIT_MS, so the ceiling clears that with room
// for the page work around it.
const ACTION_TIMEOUT_MS = MAX_WAIT_MS + 60_000;
// Dropping a CDP connection is a local operation, but it also happens after an
// action was abandoned at its deadline, and the abandoned call still holds that
// connection. Bounded so teardown cannot inherit the hang it is cleaning up.
const CONNECTION_CLOSE_TIMEOUT_MS = 5_000;
// Destroying a browser context is asked of the browser process, not of the page
// being destroyed, so it answers even when that page is unresponsive — unless
// the browser process itself is the problem, which is exactly the situation the
// callers below are trying to recover from.
const DISPOSE_CONTEXT_TIMEOUT_MS = 5_000;
// The action lock is only ever held across session setup or session finalising,
// both of which are bounded well inside this. Waiting longer means the holder is
// stuck, or that something outside this helper holds the lock file; saying so
// beats waiting for a caller to give up on a silent process.
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const VALID_MOUSE_BUTTONS = new Set(['left', 'right', 'middle']);
const SESSION_KEY_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const INVALID_SESSION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
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
    if (existsSync(STATE_FILE)) {
      return normalizeState(JSON.parse(readFileSync(STATE_FILE, 'utf-8')));
    }
  } catch { /* corrupt state */ }
  return normalizeState(null);
}

function saveState(state) {
  const normalizedState = normalizeState(state);
  const tempPath = `${STATE_FILE}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(normalizedState), 'utf-8');
  renameSync(tempPath, STATE_FILE);
}

function readPositiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isValidSessionKey(value) {
  return isNonEmptyString(value) && SESSION_KEY_PATTERN.test(value) && !INVALID_SESSION_KEYS.has(value);
}

function normalizeTimestamp(value, fallback) {
  return isNonEmptyString(value) ? value : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function createLease() {
  return {
    leaseId: randomUUID(),
    pid: process.pid,
    startedAt: nowIso(),
  };
}

function normalizeLease(value) {
  const pid = Number(value?.pid);
  if (!isNonEmptyString(value?.leaseId) || !Number.isInteger(pid) || pid < 1) {
    return null;
  }
  return {
    leaseId: value.leaseId,
    pid,
    startedAt: normalizeTimestamp(value?.startedAt, nowIso()),
  };
}

function normalizeSession(value) {
  if (!value || typeof value !== 'object') return null;
  if (!isNonEmptyString(value.browserContextId) || !isNonEmptyString(value.targetId)) return null;

  return {
    browserContextId: value.browserContextId,
    targetId: value.targetId,
    viewport: normalizeViewport(value.viewport) || DEFAULT_VIEWPORT,
    createdAt: normalizeTimestamp(value.createdAt, nowIso()),
    lastSeenAt: normalizeTimestamp(value.lastSeenAt, nowIso()),
    inFlight: Array.isArray(value.inFlight)
      ? value.inFlight.map(normalizeLease).filter(Boolean)
      : [],
  };
}

function normalizeState(value) {
  const sessions = Object.create(null);
  const sourceSessions = value?.sessions && typeof value.sessions === 'object' ? value.sessions : null;
  if (sourceSessions) {
    for (const [sessionKey, sessionValue] of Object.entries(sourceSessions)) {
      if (!isValidSessionKey(sessionKey)) continue;
      const normalizedSession = normalizeSession(sessionValue);
      if (normalizedSession) {
        sessions[sessionKey] = normalizedSession;
      }
    }
  }

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    cdpUrl: isNonEmptyString(value?.cdpUrl) ? value.cdpUrl : null,
    sessions,
  };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isLeaseExpired(lease, nowMs) {
  const startedAtMs = Date.parse(lease.startedAt);
  return !Number.isFinite(startedAtMs) || (nowMs - startedAtMs) > MAX_SESSION_LEASE_AGE_MS;
}

function pruneDeadSessionLeases(state, nowMs = Date.now()) {
  // PID liveness alone is not enough: the kernel can eventually reuse a dead
  // helper process ID, so an orphaned lease also needs an age limit or a later
  // unrelated process could keep that session blocked forever.
  for (const session of Object.values(state.sessions)) {
    session.inFlight = session.inFlight.filter(lease => !isLeaseExpired(lease, nowMs) && isProcessAlive(lease.pid));
  }
}

function sessionHasActiveLease(session) {
  return session.inFlight.length > 0;
}

function removeSessionLease(session, leaseId) {
  session.inFlight = session.inFlight.filter(lease => lease.leaseId !== leaseId);
}

function getSessionLastSeenMs(session) {
  const parsed = Date.parse(session.lastSeenAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

const BROWSER_PROCESS_PATTERN = `chrome.*--remote-debugging-port=${CDP_PORT}`;
const BROWSER_RESULT_MARKER = 1;
const BROWSER_PROTOCOL_VERSION = 2;
const STATE_SCHEMA_VERSION = 2;
const BROWSER_ACTION_LOCK = '/tmp/.browser-cli.action.lock';
const DEFAULT_SHARED_SESSION_KEY = 'default';
const DEFAULT_SESSION_IDLE_TTL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_BROWSER_MAX_SESSIONS = 8;
const MAX_SESSION_LEASE_AGE_MS = 10 * 60 * 1_000;
const SESSION_IDLE_TTL_MS = readPositiveIntegerEnv(
  'TAURUS_BROWSER_SESSION_IDLE_TTL_MS',
  DEFAULT_SESSION_IDLE_TTL_MS,
);
const MAX_BROWSER_SESSIONS = readPositiveIntegerEnv(
  'TAURUS_BROWSER_MAX_SESSIONS',
  DEFAULT_BROWSER_MAX_SESSIONS,
);

function signalBrowserProcess(signalArgs) {
  try {
    execFileSync('pkill', [...signalArgs, '-u', BROWSER_USER, '-f', BROWSER_PROCESS_PATTERN], { stdio: 'ignore' });
  } catch {
    /* no matching process */
  }
}

function isBrowserProcessRunning() {
  try {
    execFileSync('pgrep', ['-u', BROWSER_USER, '-f', BROWSER_PROCESS_PATTERN], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminates the browser and waits for it to actually be gone.
 *
 * Waiting matters: the next launch binds the same debugging port, and a browser
 * that is still shutting down still answers on it. The helper would then attach
 * to the dying session — inheriting its tabs and losing whatever it does next —
 * instead of to the fresh browser it just started.
 */
async function closeBrowserProcess() {
  signalBrowserProcess([]);

  for (let attempt = 0; attempt < BROWSER_EXIT_POLL_ATTEMPTS; attempt += 1) {
    if (!isBrowserProcessRunning()) return;
    await sleep(BROWSER_EXIT_POLL_INTERVAL_MS);
  }

  // Refused to leave on request; stop asking.
  signalBrowserProcess(['-9']);
  for (let attempt = 0; attempt < BROWSER_EXIT_POLL_ATTEMPTS; attempt += 1) {
    if (!isBrowserProcessRunning()) return;
    await sleep(BROWSER_EXIT_POLL_INTERVAL_MS);
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

/**
 * Playwright's own wording for "the JavaScript context you were talking to no
 * longer exists", which in practice is always a navigation racing the call.
 *
 * Anchored deliberately. A page can throw an error whose message says exactly
 * the same thing, and Playwright renders a thrown Error as
 * `page.evaluate: Error: <the page's text>` — so the form *without* that inner
 * prefix is the one where the browser, not the page, is speaking. Matching the
 * phrase anywhere would replace a page's real error text with a navigation
 * explanation that does not apply to it.
 *
 * One shape stays indistinguishable: a page that throws a bare string rather
 * than an Error is rendered without the inner prefix, so a page can still
 * arrange for this rewrite by mimicking the wording. That is accepted, because
 * it gains the page nothing it does not already have — the text of an error it
 * throws is its own, and it could simply throw the rewritten sentence. Ruling
 * it out would mean tracking document identity across the call to prove
 * whether a navigation actually happened.
 */
const EXECUTION_CONTEXT_DESTROYED_PATTERN = new RegExp(
  '^page\\.evaluate: (?:'
  + 'Execution context was destroyed'
  + '|Cannot find context with specified id'
  + '|Frame was detached'
  + '|Target (?:page, context or browser has been )?closed'
  + '|Navigating and changing the document'
  + ')',
  'i',
);

function isExecutionContextDestroyedError(err) {
  const message = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
  return EXECUTION_CONTEXT_DESTROYED_PATTERN.test(message);
}

class BrowserAttachBlockedError extends Error {
  constructor() {
    super(
      'Could not attach to the existing Chromium instance in this container while it is still running. '
      + 'Another browser page may be unresponsive. Use the Browser close action on the affected session to force that page closed. '
      + 'If Browser still cannot recover after that, recreate the container.',
    );
    this.name = 'BrowserAttachBlockedError';
  }
}

function isBrowserAttachBlockedError(err) {
  return err instanceof BrowserAttachBlockedError;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Rejects if `promise` has not settled within `ms`. Used for best-effort steps
 * that must never turn into a hang; the underlying call is simply abandoned.
 * `description` names the abandoned step, for the callers whose timeout is
 * reported to the agent rather than swallowed.
 */
function withTimeout(promise, ms, description = null) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`${description ? `${description} ` : ''}timed out after ${ms}ms`)),
        ms,
      ).unref();
    }),
  ]);
}

function parseInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function hasOwnInput(input, key) {
  return Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
}

function requireInteger(input, key, message) {
  const parsed = parseInteger(input[key]);
  if (parsed === null) {
    throwValidationError(message ?? `"${key}" is required and must be an integer.`);
  }
  return parsed;
}

function requireNonNegativeInteger(input, key) {
  const parsed = requireInteger(input, key, `"${key}" is required and must be a non-negative integer.`);
  if (parsed < 0) {
    throwValidationError(`"${key}" is required and must be a non-negative integer.`);
  }
  return parsed;
}

function requireCoordinatePair(input, xKey, yKey, actionName) {
  const hasX = hasOwnInput(input, xKey);
  const hasY = hasOwnInput(input, yKey);
  if (!hasX || !hasY) {
    throwValidationError(`"${actionName}" requires both "${xKey}" and "${yKey}".`);
  }
  return {
    [xKey]: requireNonNegativeInteger(input, xKey),
    [yKey]: requireNonNegativeInteger(input, yKey),
  };
}

function validateSingleKeyAction(action, key) {
  if (typeof key !== 'string' || key.length === 0) {
    throwValidationError('"key" is required.');
  }
  if (key.includes('+') && key !== '+') {
    throwValidationError(`"${action}" accepts only a single key. Use "press" for key chords such as "Control+a".`);
  }
}

function validateMouseButton(button) {
  if (button === undefined) return;
  if (!VALID_MOUSE_BUTTONS.has(button)) {
    throwValidationError('"button" must be one of "left", "right", or "middle".');
  }
}

function validateActionInput(input) {
  switch (input.action) {
    case 'resize': {
      const validationError = getViewportValidationError(Number(input.width), Number(input.height));
      if (validationError) {
        throwValidationError(validationError);
      }
      break;
    }

    case 'click': {
      const hasSelector = typeof input.selector === 'string' && input.selector.length > 0;
      const hasX = hasOwnInput(input, 'x');
      const hasY = hasOwnInput(input, 'y');
      if (hasX !== hasY) {
        throwValidationError('"click" coordinate mode requires both "x" and "y".');
      }
      if (hasSelector === (hasX && hasY)) {
        throwValidationError('"click" requires exactly one target: either "selector", or both "x" and "y".');
      }
      if (hasX && hasY) {
        requireCoordinatePair(input, 'x', 'y', 'click');
      }
      break;
    }

    case 'mousemove': {
      requireCoordinatePair(input, 'x', 'y', 'mousemove');
      break;
    }

    case 'mousedown':
    case 'mouseup': {
      validateMouseButton(input.button);
      const hasX = hasOwnInput(input, 'x');
      const hasY = hasOwnInput(input, 'y');
      if (hasX !== hasY) {
        throwValidationError(`"${input.action}" coordinate mode requires both "x" and "y".`);
      }
      if (hasX && hasY) {
        requireCoordinatePair(input, 'x', 'y', input.action);
      }
      break;
    }

    case 'drag': {
      requireCoordinatePair(input, 'x', 'y', 'drag');
      requireCoordinatePair(input, 'x2', 'y2', 'drag');
      if (input.steps !== undefined) {
        const steps = requireInteger(input, 'steps');
        if (steps < 1 || steps > MAX_DRAG_STEPS) {
          throwValidationError(`"steps" must be an integer between 1 and ${MAX_DRAG_STEPS}.`);
        }
      }
      break;
    }

    case 'keydown':
    case 'keyup': {
      validateSingleKeyAction(input.action, input.key);
      break;
    }

    case 'wait': {
      if (input.ms !== undefined) {
        const ms = requireInteger(input, 'ms');
        if (ms < 0 || ms > MAX_WAIT_MS) {
          throwValidationError(`"ms" must be an integer between 0 and ${MAX_WAIT_MS}.`);
        }
      }
      break;
    }
  }
}

function stripAnsiSequences(text) {
  return text
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B[@-_]/g, '');
}

function escapeControlCharacters(text) {
  return text.replace(/[\x00-\x1F\x7F-\x9F\u2028\u2029]/g, char => {
    switch (char) {
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      case '\0': return '\\0';
      // Keep each console entry on one physical line. Unicode line and paragraph
      // separators do not look like control bytes, but they still split rendered
      // lines and can spoof extra console entries, so escape them explicitly.
      case '\u2028':
      case '\u2029': return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
      default: return `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`;
    }
  });
}

function escapeLineIntegrityCharacters(text) {
  return String(text ?? '').replace(/[\x85\u2028\u2029]/g, char => {
    switch (char) {
      // Preserve ordinary newlines in page-derived output, but escape the three
      // non-printing separators that can still split rendered lines.
      case '\x85': return '\\x85';
      case '\u2028': return '\\u2028';
      case '\u2029': return '\\u2029';
      default: return char;
    }
  });
}

function sanitizeConsoleText(text) {
  return escapeControlCharacters(stripAnsiSequences(String(text ?? '')));
}

function truncateConsoleText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function truncateSummaryField(text, maxLength) {
  if (text.length <= maxLength) {
    return { text, truncated: false };
  }

  const keptLength = Math.max(0, maxLength - TRUNCATED_SCREENSHOT_FIELD_SUFFIX.length);
  return {
    text: `${text.slice(0, keptLength)}${TRUNCATED_SCREENSHOT_FIELD_SUFFIX}`,
    truncated: true,
  };
}

/**
 * A page controls both document.title and, via navigations and fragments, the
 * URL we report alongside a screenshot. Bound those summary fields before they
 * enter the envelope so a hostile page cannot turn a valid screenshot into an
 * oversized JSON blob that the shell cuts mid-envelope.
 */
function buildScreenshotSummary(title, url, viewport, byteLength) {
  const boundedTitle = truncateSummaryField(
    escapeLineIntegrityCharacters(title),
    MAX_SCREENSHOT_TITLE_SUMMARY_CHARS,
  );
  const boundedUrl = truncateSummaryField(
    escapeLineIntegrityCharacters(url),
    MAX_SCREENSHOT_URL_SUMMARY_CHARS,
  );
  return {
    text: `Screenshot of "${boundedTitle.text}" (${boundedUrl.text})\nViewport: ${viewport.width}x${viewport.height}, ${byteLength} bytes`,
    outputTruncated: boundedTitle.truncated || boundedUrl.truncated,
  };
}

/**
 * The daemon only trusts a nonce-matched JSON envelope. If shell-side capture
 * truncates that JSON first, a matched helper looks indistinguishable from a
 * mismatched one. Trim oversized text outputs here instead, while preserving an
 * explicit in-band marker and a boolean flag the daemon can turn into a clear
 * partial-output notice.
 */
function jsonStringUnitInfo(text, index) {
  const code = text.charCodeAt(index);
  if (code === 0x22 || code === 0x5C) {
    return { byteLength: 2, codeUnitLength: 1 };
  }

  switch (code) {
    case 0x08:
    case 0x09:
    case 0x0A:
    case 0x0C:
    case 0x0D:
      return { byteLength: 2, codeUnitLength: 1 };
    default:
      break;
  }

  if (code <= 0x1F) {
    return { byteLength: 6, codeUnitLength: 1 };
  }

  if (code >= 0xD800 && code <= 0xDBFF) {
    const next = text.charCodeAt(index + 1);
    if (next >= 0xDC00 && next <= 0xDFFF) {
      return { byteLength: 4, codeUnitLength: 2 };
    }
    return { byteLength: 6, codeUnitLength: 1 };
  }

  if (code >= 0xDC00 && code <= 0xDFFF) {
    return { byteLength: 6, codeUnitLength: 1 };
  }

  if (code <= 0x7F) {
    return { byteLength: 1, codeUnitLength: 1 };
  }
  if (code <= 0x7FF) {
    return { byteLength: 2, codeUnitLength: 1 };
  }
  return { byteLength: 3, codeUnitLength: 1 };
}

function jsonStringContentByteLength(text) {
  let total = 0;
  for (let index = 0; index < text.length;) {
    const unit = jsonStringUnitInfo(text, index);
    total += unit.byteLength;
    index += unit.codeUnitLength;
  }
  return total;
}

function truncateJsonStringContentToByteBudget(text, byteBudget) {
  let total = 0;
  let end = 0;
  for (let index = 0; index < text.length;) {
    const unit = jsonStringUnitInfo(text, index);
    if (total + unit.byteLength > byteBudget) break;
    total += unit.byteLength;
    index += unit.codeUnitLength;
    end = index;
  }
  return text.slice(0, end);
}

function buildBoundedProtocolTextEnvelope(nonce, isError, output) {
  const baseEnvelope = {
    __taurusBrowserResult: BROWSER_RESULT_MARKER,
    nonce,
    isError,
    output,
    outputTruncated: false,
  };
  const emptyBaseEnvelope = {
    __taurusBrowserResult: BROWSER_RESULT_MARKER,
    nonce,
    isError,
    output: '',
    outputTruncated: false,
  };
  const baseEnvelopeOverhead = Buffer.byteLength(JSON.stringify(emptyBaseEnvelope), 'utf8');
  if (baseEnvelopeOverhead + jsonStringContentByteLength(output) <= MAX_TEXT_PROTOCOL_STDOUT_BYTES) {
    return baseEnvelope;
  }

  const truncatedEnvelope = {
    __taurusBrowserResult: BROWSER_RESULT_MARKER,
    nonce,
    isError,
    output: TRUNCATED_PROTOCOL_OUTPUT_SUFFIX,
    outputTruncated: true,
  };
  const emptyTruncatedEnvelope = {
    __taurusBrowserResult: BROWSER_RESULT_MARKER,
    nonce,
    isError,
    output: '',
    outputTruncated: true,
  };
  const truncatedEnvelopeOverhead = Buffer.byteLength(JSON.stringify(emptyTruncatedEnvelope), 'utf8');
  const suffixByteLength = jsonStringContentByteLength(TRUNCATED_PROTOCOL_OUTPUT_SUFFIX);
  const availableOutputBytes = MAX_TEXT_PROTOCOL_STDOUT_BYTES - truncatedEnvelopeOverhead - suffixByteLength;
  if (availableOutputBytes < 0) {
    throw new Error('Browser protocol truncation marker does not fit within the text transport budget.');
  }

  const keptOutput = truncateJsonStringContentToByteBudget(output, availableOutputBytes);
  const boundedEnvelope = {
    __taurusBrowserResult: BROWSER_RESULT_MARKER,
    nonce,
    isError,
    output: `${keptOutput}${TRUNCATED_PROTOCOL_OUTPUT_SUFFIX}`,
    outputTruncated: true,
  };
  if (Buffer.byteLength(JSON.stringify(boundedEnvelope), 'utf8') > MAX_TEXT_PROTOCOL_STDOUT_BYTES) {
    throw new Error('Browser protocol truncation exceeded the text transport budget.');
  }
  return boundedEnvelope;
}

/**
 * Installed in the page so console arguments can be rendered while the real
 * objects are still alive (CDP only replays previews to a session that was
 * already attached when the call happened, so a reconnecting helper would
 * otherwise print "Object" instead of {hp: 3, name: "hero"}).
 *
 * `installedAtDocumentStart` records whether this copy was installed before any
 * page script ran. Only then does the buffer describe the whole document, and
 * only then may the reader prefer it over CDP replay.
 */
function installConsoleCaptureInPage(installedAtDocumentStart) {
  if (globalThis.__taurusConsoleCapture) return;

  const ENTRY_LIMIT = 1_000;
  const originalConsole = globalThis.console;
  const buffer = [];
  const counters = new Map();
  const timers = new Map();
  let sequence = 0;

  function nowMs() {
    try {
      return typeof performance === 'object' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    } catch {
      return Date.now();
    }
  }

  function appendEntry(type, text) {
    buffer.push({
      type,
      text,
      timestamp: Date.now(),
      sequence,
    });
    sequence += 1;
    if (buffer.length > ENTRY_LIMIT) {
      buffer.shift();
    }
  }

  function formatValue(value, depth = 0, quoteStrings = false) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';

    const valueType = typeof value;
    if (valueType === 'string') return quoteStrings ? JSON.stringify(value) : value;
    if (valueType === 'number' || valueType === 'boolean' || valueType === 'bigint') return String(value);
    if (valueType === 'symbol') return String(value);
    if (valueType === 'function') return value.name ? `[Function: ${value.name}]` : '[Function]';

    if (value instanceof Error) {
      const name = value.name || 'Error';
      return value.message ? `${name}: ${value.message}` : name;
    }

    if (value instanceof Date || value instanceof RegExp) {
      return String(value);
    }

    if (ArrayBuffer.isView(value)) {
      const length = typeof value.length === 'number' ? value.length : value.byteLength;
      return `${value.constructor?.name || 'TypedArray'}(${length})`;
    }

    if (Array.isArray(value)) {
      if (depth > 0) return `Array(${value.length})`;
      const items = value.slice(0, 10).map(item => formatValue(item, depth + 1, true));
      if (value.length > 10) items.push('…');
      return `[${items.join(', ')}]`;
    }

    if (value instanceof Map) {
      if (depth > 0) return `Map(${value.size})`;
      const entries = [];
      let index = 0;
      for (const [key, entryValue] of value) {
        if (index >= 10) {
          entries.push('…');
          break;
        }
        entries.push(`${formatValue(key, depth + 1, true)} => ${formatValue(entryValue, depth + 1, true)}`);
        index += 1;
      }
      return `Map(${value.size}) {${entries.join(', ')}}`;
    }

    if (value instanceof Set) {
      if (depth > 0) return `Set(${value.size})`;
      const entries = [];
      let index = 0;
      for (const entryValue of value) {
        if (index >= 10) {
          entries.push('…');
          break;
        }
        entries.push(formatValue(entryValue, depth + 1, true));
        index += 1;
      }
      return `Set(${value.size}) {${entries.join(', ')}}`;
    }

    const constructorName = value?.constructor?.name;
    if (depth > 0) {
      return constructorName && constructorName !== 'Object' ? constructorName : 'Object';
    }

    try {
      const entries = Object.entries(value);
      const properties = entries.slice(0, 10).map(([key, entryValue]) => `${key}: ${formatValue(entryValue, depth + 1, true)}`);
      if (entries.length > 10) properties.push('…');
      if (properties.length === 0) {
        return constructorName && constructorName !== 'Object' ? constructorName : '{}';
      }
      return `{${properties.join(', ')}}`;
    } catch {
      return constructorName && constructorName !== 'Object' ? constructorName : 'Object';
    }
  }

  function renderArguments(args) {
    return args.map(arg => formatValue(arg)).join(' ');
  }

  function labelOf(args) {
    return args.length === 0 || args[0] === undefined ? 'default' : String(args[0]);
  }

  /**
   * `render` turns a console call into the entry text, or returns null when the
   * call should not produce an entry (console.time, a passing assertion, ...).
   * The page's own console call always runs, whatever we do with it.
   */
  function wrapConsoleMethod(methodName, render = renderArguments) {
    const original = typeof originalConsole[methodName] === 'function'
      ? originalConsole[methodName].bind(originalConsole)
      : null;
    if (!original) return;

    originalConsole[methodName] = (...args) => {
      try {
        const text = render(args);
        if (text !== null) appendEntry(methodName, text);
      } catch {
        /* capture must never break the page's own console call */
      }
      return original(...args);
    };
  }

  globalThis.__taurusConsoleCapture = {
    installedAtDocumentStart: installedAtDocumentStart === true,
    buffer,
  };

  wrapConsoleMethod('debug');
  wrapConsoleMethod('log');
  wrapConsoleMethod('info');
  wrapConsoleMethod('warn');
  wrapConsoleMethod('error');
  wrapConsoleMethod('dir');
  wrapConsoleMethod('dirxml');
  wrapConsoleMethod('trace');
  wrapConsoleMethod('table');
  // Grouping is rendered flat: the entry text is what the group header said,
  // and groupEnd is kept as a marker so nesting is still visible in sequence.
  wrapConsoleMethod('group');
  wrapConsoleMethod('groupCollapsed');
  wrapConsoleMethod('groupEnd', () => '');
  wrapConsoleMethod('assert', args => {
    const [condition, ...rest] = args;
    if (condition) return null;
    const detail = renderArguments(rest);
    return detail ? `Assertion failed: ${detail}` : 'Assertion failed';
  });
  wrapConsoleMethod('count', args => {
    const label = labelOf(args);
    const next = (counters.get(label) ?? 0) + 1;
    counters.set(label, next);
    return `${label}: ${next}`;
  });
  wrapConsoleMethod('countReset', args => {
    counters.delete(labelOf(args));
    return null;
  });
  wrapConsoleMethod('time', args => {
    timers.set(labelOf(args), nowMs());
    return null;
  });
  wrapConsoleMethod('timeEnd', args => {
    const label = labelOf(args);
    if (!timers.has(label)) return `${label}: timer does not exist`;
    const elapsed = nowMs() - timers.get(label);
    timers.delete(label);
    return `${label}: ${elapsed.toFixed(2)}ms`;
  });
  wrapConsoleMethod('timeLog', args => {
    const label = labelOf(args);
    if (!timers.has(label)) return `${label}: timer does not exist`;
    const elapsed = nowMs() - timers.get(label);
    const detail = renderArguments(args.slice(1));
    return `${label}: ${elapsed.toFixed(2)}ms${detail ? ` ${detail}` : ''}`;
  });
  wrapConsoleMethod('timeStamp', args => labelOf(args));
  wrapConsoleMethod('clear', () => {
    buffer.length = 0;
    sequence = 0;
    return null;
  });
}

function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function takeFirstRenderedLine(text) {
  return String(text ?? '').split(/[\r\n\x85\u2028\u2029]/, 1)[0];
}

function formatConsoleErrorSummary(preview, description) {
  const name = preview?.properties?.find(property => property?.name === 'name' && typeof property.value === 'string')?.value;
  const message = preview?.properties?.find(property => property?.name === 'message' && typeof property.value === 'string')?.value;
  if (name && message) {
    return `${name}: ${message}`;
  }
  if (name) {
    return name;
  }
  return takeFirstRenderedLine(description || 'Error');
}

function formatPreviewPrimitive(type, description) {
  if (type === 'string') return JSON.stringify(description ?? '');
  if (type === 'undefined') return 'undefined';
  if (type === 'symbol') return description || 'Symbol()';
  if (type === 'function') return description || 'function';
  return description ?? String(type);
}

function formatPropertyPreviewValue(property) {
  if (!property || typeof property !== 'object') return '[unserializable value]';
  if (property.type === 'string') return JSON.stringify(property.value ?? '');
  if (property.type === 'undefined') return 'undefined';
  if (property.type === 'symbol') return property.value || 'Symbol()';
  if (property.type === 'function') return property.value || 'function';
  if (property.type === 'accessor') return '[accessor]';
  if (property.type === 'object' && property.subtype === 'null') return 'null';
  if (property.type === 'object' && property.subtype === 'error') {
    return formatConsoleErrorSummary(property.valuePreview, property.value);
  }
  if (property.type === 'object') {
    return property.value
      || property.valuePreview?.description
      || property.subtype
      || 'Object';
  }
  return property.value ?? '[unserializable value]';
}

function formatPreviewValue(preview) {
  if (!preview || typeof preview !== 'object') return '[unserializable value]';
  if (preview.type !== 'object') {
    return formatPreviewPrimitive(preview.type, preview.description);
  }
  if (preview.subtype === 'null') {
    return 'null';
  }
  if (preview.subtype === 'error') {
    return formatConsoleErrorSummary(preview, preview.description);
  }
  if (preview.subtype === 'array') {
    const items = (preview.properties ?? [])
      .filter(property => /^\d+$/.test(property?.name ?? ''))
      .map(formatPropertyPreviewValue);
    if (preview.overflow) items.push('…');
    return `[${items.join(', ')}]`;
  }
  if (preview.subtype === 'map') {
    const entries = (preview.entries ?? []).map(entry => `${formatPreviewValue(entry?.key)} => ${formatPreviewValue(entry?.value)}`);
    if (preview.overflow) entries.push('…');
    const prefix = preview.description || 'Map';
    return `${prefix} {${entries.join(', ')}}`;
  }
  if (preview.subtype === 'set') {
    const entries = (preview.entries ?? []).map(entry => formatPreviewValue(entry?.value ?? entry?.key));
    if (preview.overflow) entries.push('…');
    const prefix = preview.description || 'Set';
    return `${prefix} {${entries.join(', ')}}`;
  }

  const properties = (preview.properties ?? []).map(property => `${property.name}: ${formatPropertyPreviewValue(property)}`);
  if (preview.overflow) properties.push('…');
  if (properties.length === 0) {
    return preview.description && preview.description !== 'Object' ? preview.description : '{}';
  }
  return `{${properties.join(', ')}}`;
}

function formatConsoleValue(arg) {
  if (!arg || typeof arg !== 'object') return String(arg);
  if (typeof arg.unserializableValue === 'string') return arg.unserializableValue;
  if ('value' in arg && arg.value !== undefined) {
    return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
  }
  if (arg.preview) return formatPreviewValue(arg.preview);
  if (arg.subtype === 'error') return formatConsoleErrorSummary(null, arg.description);
  if (typeof arg.description === 'string' && arg.description.length > 0) return arg.description;
  if (typeof arg.type === 'string' && arg.type.length > 0) return arg.type;
  return '[unserializable value]';
}

function formatConsoleApiEntry(event) {
  const type = event.type === 'warning' ? 'warn' : event.type;
  const body = (event.args ?? []).map(formatConsoleValue).join(' ');
  return `[${type}] ${body}`.trimEnd();
}

function formatExceptionEntry(event) {
  const description = event.exceptionDetails?.exception?.description;
  const firstLine = (typeof description === 'string' && description.length > 0)
    ? takeFirstRenderedLine(description)
    : event.exceptionDetails?.text || 'Uncaught exception';
  return `[exception] ${firstLine}`;
}

function formatLogEntry(entry) {
  const source = entry?.source || 'log';
  const pieces = [];
  if (typeof entry?.text === 'string' && entry.text.length > 0) {
    pieces.push(entry.text);
  }
  if (typeof entry?.url === 'string' && entry.url.length > 0) {
    pieces.push(`(${entry.url})`);
  }
  return `[${source}] ${pieces.join(' ') || 'log entry'}`;
}

function formatConsoleOutput(entries) {
  if (entries.length === 0) {
    return 'No console or log entries captured since the current page loaded.';
  }

  const orderedEntries = entries
    .slice()
    .sort((left, right) => (left.timestamp - right.timestamp) || (left.arrivalOrder - right.arrivalOrder));

  const droppedBeforeFormatting = Math.max(0, orderedEntries.length - MAX_CONSOLE_ENTRIES);
  const visibleEntries = orderedEntries
    .slice(-MAX_CONSOLE_ENTRIES)
    .map(entry => truncateConsoleText(sanitizeConsoleText(entry.text), MAX_CONSOLE_ENTRY_LENGTH));
  let droppedByOutputCap = 0;

  while (true) {
    const summaryLines = [];
    if (droppedBeforeFormatting > 0) {
      summaryLines.push(`... ${droppedBeforeFormatting} older ${pluralize(droppedBeforeFormatting, 'entry', 'entries')} omitted.`);
    }
    if (droppedByOutputCap > 0) {
      summaryLines.push(`... ${droppedByOutputCap} additional ${pluralize(droppedByOutputCap, 'entry', 'entries')} omitted after reaching the output cap.`);
    }

    const output = summaryLines.concat(visibleEntries).join('\n');
    if (output.length <= MAX_CONSOLE_OUTPUT_LENGTH || visibleEntries.length === 0) {
      return output;
    }

    visibleEntries.shift();
    droppedByOutputCap += 1;
  }
}

/**
 * Reads the in-page console buffer. Everything here is page-writable, so the
 * shape is validated and bounded on the way out; meaning is assigned later, on
 * this side of the boundary.
 */
async function readPageConsoleCapture(page, maxEntries, maxEntryLength) {
  return page.evaluate(([entryLimit, textLimit]) => {
    const capture = globalThis.__taurusConsoleCapture;
    if (!capture || !Array.isArray(capture.buffer)) return null;
    const entries = capture.buffer.slice(-entryLimit).map(entry => ({
      type: typeof entry?.type === 'string' ? entry.type : '',
      text: typeof entry?.text === 'string' ? entry.text.slice(0, textLimit) : '',
      timestamp: typeof entry?.timestamp === 'number' ? entry.timestamp : null,
    }));
    return { installedAtDocumentStart: capture.installedAtDocumentStart === true, entries };
  }, [maxEntries, maxEntryLength]).catch(() => null);
}

/**
 * Window that page-reported console timestamps are clamped into, so a page
 * cannot position a forged entry among browser-attested ones by choosing an
 * arbitrary timestamp.
 *
 * The start of the document is read from an isolated world rather than from the
 * page: an isolated world shares the document but has its own JavaScript
 * globals, so its `performance.timeOrigin` is the browser's value even when the
 * page has redefined its own. Reading it this way deliberately avoids enabling
 * any instrumentation domain — enabling the Performance domain on a page has
 * been observed to leave later screenshots of that page hanging.
 */
async function resolveShimTimestampWindow(cdp) {
  let documentStart = null;
  try {
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const frameId = frameTree?.frame?.id;
    if (typeof frameId === 'string') {
      const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
        frameId,
        worldName: 'taurus-console-clock',
        grantUniveralAccess: false,
      });
      const { result } = await cdp.send('Runtime.evaluate', {
        expression: 'performance.timeOrigin',
        contextId: executionContextId,
        returnByValue: true,
      });
      if (Number.isFinite(result?.value)) documentStart = result.value;
    }
  } catch {
    /* fall back to the loose bound below */
  }

  const latest = Date.now();
  const earliest = documentStart === null
    ? latest - MAX_UNVERIFIED_DOCUMENT_AGE_MS
    : Math.min(documentStart - NAVIGATION_START_TOLERANCE_MS, latest);
  return { earliest, latest };
}

/**
 * Turns the page-reported timestamps of one buffer into timestamps worth
 * sorting browser-attested entries against.
 *
 * Two rules, both of which genuine entries already satisfy: a timestamp lies
 * within the life of the current document, and timestamps never go backwards
 * along the buffer, which is append-only and stamped at append time. Enforcing
 * them means a page can neither lift an entry out of its document's time
 * window, nor move an entry away from the position it was appended at.
 */
function clampShimTimestamps(entries, window) {
  let previous = window.earliest;
  return entries.map(entry => {
    const raw = Number.isFinite(entry.timestamp) ? entry.timestamp : previous;
    const clamped = Math.min(Math.max(raw, previous), window.latest);
    previous = clamped;
    return clamped;
  });
}

/** Renders one page-buffer entry, refusing any type the shim cannot produce. */
function formatShimConsoleEntry(entry) {
  const type = SHIM_CONSOLE_ENTRY_TYPES.has(entry.type) ? entry.type : 'log';
  return `[${type}] ${entry.text}`.trimEnd();
}

async function captureConsoleOutput(page) {
  const cdp = await page.context().newCDPSession(page);
  const entries = [];
  const replayedConsoleEntries = [];
  let arrivalOrder = 0;

  function recordEntry(text, timestamp) {
    entries.push({
      text,
      timestamp: Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY,
      arrivalOrder,
    });
    arrivalOrder += 1;
  }

  // Every console action attaches a fresh CDP client. Chromium replays buffered
  // console and exception events when Runtime.enable runs on a new session, so
  // this helper stays stateless across separate tool invocations. Replayed
  // console calls are held aside rather than recorded straight away: whether we
  // use them or the richer in-page buffer can only be decided after reading the
  // page, and using both would report every message twice.
  cdp.on('Runtime.consoleAPICalled', event => replayedConsoleEntries.push({
    text: formatConsoleApiEntry(event),
    timestamp: event.timestamp,
  }));
  cdp.on('Runtime.exceptionThrown', event => recordEntry(formatExceptionEntry(event), event.timestamp));
  cdp.on('Log.entryAdded', event => recordEntry(formatLogEntry(event.entry), event.entry?.timestamp));

  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await sleep(CONSOLE_SETTLE_MS);

    // The in-page buffer only describes the whole document when it was installed
    // before any page script ran. After a page-initiated navigation the helper
    // may have installed it late into an already-running document (or not at
    // all), and only CDP replay still has the earlier messages — so prefer
    // previews when they are complete, and completeness otherwise.
    const pageCapture = await readPageConsoleCapture(
      page,
      MAX_PAGE_CONSOLE_ENTRIES_READ,
      MAX_PAGE_CONSOLE_ENTRY_READ_LENGTH,
    );
    if (pageCapture?.installedAtDocumentStart) {
      const timestampWindow = await resolveShimTimestampWindow(cdp);
      const timestamps = clampShimTimestamps(pageCapture.entries, timestampWindow);
      pageCapture.entries.forEach((entry, index) => {
        recordEntry(formatShimConsoleEntry(entry), timestamps[index]);
      });
    } else {
      for (const entry of replayedConsoleEntries) {
        recordEntry(entry.text, entry.timestamp);
      }
    }

    return formatConsoleOutput(entries);
  } finally {
    await cdp.detach().catch(() => {});
  }
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

function getSessionViewport(session) {
  return normalizeViewport(session?.viewport) || DEFAULT_VIEWPORT;
}

async function acquireBrowserActionLock() {
  const readyToken = `__taurus_browser_lock_ready_${randomUUID()}__`;
  const child = spawn('flock', [
    '-x',
    BROWSER_ACTION_LOCK,
    'bash',
    '-c',
    'printf %s "$1"; cat >/dev/null',
    'bash',
    readyToken,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  return await new Promise((resolve, reject) => {
    let ready = false;
    let stderr = '';
    let stdout = '';

    // Nothing releases the lock on this helper's behalf, so a holder that never
    // finishes — or an unrelated process holding the same file — would leave
    // every Browser call in the container waiting with no output.
    const waitDeadline = setTimeout(() => {
      // Kill the queued `flock` child: left alive it could take the lock later,
      // with nobody here to release it.
      child.kill('SIGKILL');
      reject(new Error(`Could not acquire the browser action lock within ${LOCK_ACQUIRE_TIMEOUT_MS}ms. Another Browser call, or another process holding ${BROWSER_ACTION_LOCK}, has not released it.`));
    }, LOCK_ACQUIRE_TIMEOUT_MS);

    const onExit = (code, signal) => {
      clearTimeout(waitDeadline);
      if (!ready) {
        reject(new Error(`Could not acquire the browser action lock (code ${code ?? 'null'}, signal ${signal ?? 'none'}): ${stderr.trim() || 'no error output'}`));
      }
    };

    child.once('exit', onExit);
    child.once('error', err => {
      clearTimeout(waitDeadline);
      if (!ready) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (ready || !stdout.includes(readyToken)) return;
      ready = true;
      clearTimeout(waitDeadline);
      child.removeListener('exit', onExit);
      resolve({
        async release() {
          if (child.killed || child.exitCode !== null) return;
          child.stdin.end();
          await new Promise(resolveRelease => {
            child.once('exit', () => resolveRelease());
          });
        },
      });
    });
  });
}

// ── Launch or connect to Chromium ──

async function connectToBrowser(cdpUrl, timeout) {
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout });
  const rootCdp = await browser.newBrowserCDPSession();
  return { browser, rootCdp };
}

async function listDevtoolsTargets(cdpUrl) {
  try {
    const response = await fetch(`${cdpUrl}/json/list`, { signal: AbortSignal.timeout(DEVTOOLS_HTTP_TIMEOUT_MS) });
    if (!response.ok) return [];
    const targets = await response.json();
    return Array.isArray(targets) ? targets : [];
  } catch {
    return [];
  }
}

async function closeDevtoolsTarget(cdpUrl, targetId) {
  try {
    const response = await fetch(`${cdpUrl}/json/close/${encodeURIComponent(targetId)}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(DEVTOOLS_HTTP_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function canAttachToBrowser(cdpUrl, timeoutMs) {
  let browser = null;
  let rootCdp = null;
  try {
    ({ browser, rootCdp } = await connectToBrowser(cdpUrl, timeoutMs));
    return true;
  } catch {
    return false;
  } finally {
    await closeConnection(browser, rootCdp);
  }
}

async function canAttachToBrowserWithBackoff(cdpUrl) {
  if (await canAttachToBrowser(cdpUrl, ATTACH_RETRY_TIMEOUT_MS)) {
    return true;
  }
  await sleep(ATTACH_RECOVERY_BACKOFF_MS);
  return await canAttachToBrowser(cdpUrl, ATTACH_RETRY_TIMEOUT_MS);
}

/**
 * Closes page targets that never committed a document — a tab the page opened
 * whose navigation the browser then refused (`window.open` to a data: URL, for
 * example). Attaching to such a target never completes, which makes connecting
 * to the whole browser hang, so every later call would fail until the agent
 * gave up and closed the browser. They hold nothing the agent can be working
 * with: no document, no URL, no title.
 *
 * Returns whether anything was closed, i.e. whether reconnecting is worth a
 * second try.
 */
async function discardUncommittedPageTargets(cdpUrl) {
  const targets = await listDevtoolsTargets(cdpUrl);
  const uncommitted = targets.filter(target => target?.type === 'page' && typeof target.id === 'string' && !target.url);
  for (const target of uncommitted) {
    await closeDevtoolsTarget(cdpUrl, target.id);
  }
  return uncommitted.length > 0;
}

async function ensureBrowserConnection(state) {
  if (state.cdpUrl) {
    try {
      return { ...(await connectToBrowser(state.cdpUrl, ATTACH_RETRY_TIMEOUT_MS)), launchedFresh: false };
    } catch {
      try {
        if (await discardUncommittedPageTargets(state.cdpUrl)) {
          return { ...(await connectToBrowser(state.cdpUrl, ATTACH_RECOVERY_TIMEOUT_MS)), launchedFresh: false };
        }
      } catch {
        /* still unreachable — fall through to a fresh launch */
      }
      if (isBrowserProcessRunning()) {
        throw new BrowserAttachBlockedError();
      }
      state.cdpUrl = null;
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
    // This raw Chromium spawn bypasses Playwright's default launch arguments.
    // Playwright enables unsafe SwiftShader in headless Chromium so WebGL keeps
    // working there; keep this flag aligned with Playwright defaults when
    // Playwright is upgraded.
    '--enable-unsafe-swiftshader',
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
    await sleep(200);
  }

  const { browser, rootCdp } = await connectToBrowser(cdpUrl, FRESH_BROWSER_CONNECT_TIMEOUT_MS);
  state.cdpUrl = cdpUrl;
  return { browser, rootCdp, launchedFresh: true };
}

async function closeConnection(browser, rootCdp) {
  await withTimeout(rootCdp?.detach?.(), CONNECTION_CLOSE_TIMEOUT_MS).catch(() => {});
  await withTimeout(browser?.close?.(), CONNECTION_CLOSE_TIMEOUT_MS).catch(() => {});
}

async function discardAllPages(browser) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      await withTimeout(page.close(), PAGE_CLOSE_TIMEOUT_MS).catch(() => {});
    }
  }
}

async function discardOtherPages(primaryPage) {
  for (const context of primaryPage.context().browser().contexts()) {
    for (const page of context.pages()) {
      if (page === primaryPage) continue;
      await withTimeout(page.close(), PAGE_CLOSE_TIMEOUT_MS).catch(() => {});
    }
  }
}

async function findPageByTargetId(browser, targetId) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const cdp = await page.context().newCDPSession(page);
      try {
        const { targetInfo } = await cdp.send('Target.getTargetInfo');
        if (targetInfo?.targetId === targetId) {
          return page;
        }
      } catch {
        /* ignore pages that disappeared while enumerating */
      } finally {
        await cdp.detach().catch(() => {});
      }
    }
  }
  return null;
}

async function waitForPageByTargetId(browser, targetId, deadlineMs) {
  while (Date.now() < deadlineMs) {
    const page = await findPageByTargetId(browser, targetId);
    if (page) return page;
    await sleep(100);
  }
  return null;
}

async function createIsolatedSession(rootCdp, viewport) {
  const { browserContextId } = await rootCdp.send('Target.createBrowserContext', {});
  const { targetId } = await rootCdp.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId,
  });
  const timestamp = nowIso();
  return {
    browserContextId,
    targetId,
    viewport,
    createdAt: timestamp,
    lastSeenAt: timestamp,
    inFlight: [],
  };
}

async function replaceIsolatedTarget(rootCdp, session) {
  const { targetId } = await rootCdp.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId: session.browserContextId,
  });
  session.targetId = targetId;
}

async function recreateIsolatedSession(rootCdp, session) {
  const replacement = await createIsolatedSession(rootCdp, getSessionViewport(session));
  session.browserContextId = replacement.browserContextId;
  session.targetId = replacement.targetId;
  session.createdAt = replacement.createdAt;
  session.lastSeenAt = replacement.lastSeenAt;
  session.inFlight = replacement.inFlight;
}

async function prepareIsolatedPage(browser, rootCdp, session, persistSession, deadlineMs) {
  let page = await findPageByTargetId(browser, session.targetId);
  if (!page) {
    const { browserContextIds } = await rootCdp.send('Target.getBrowserContexts');
    if (browserContextIds.includes(session.browserContextId)) {
      await replaceIsolatedTarget(rootCdp, session);
    } else {
      await recreateIsolatedSession(rootCdp, session);
    }
    persistSession();
    page = await waitForPageByTargetId(browser, session.targetId, deadlineMs);
  }
  if (!page) {
    throw new Error('Could not attach to the isolated browser page for this run.');
  }

  return page;
}

async function primeIsolatedPage(page, session, sessionKey) {
  if (sessionKey === DEFAULT_SHARED_SESSION_KEY) {
    await withTimeout(page.bringToFront(), BRING_TO_FRONT_TIMEOUT_MS).catch(() => {});
  }
  // Per-run sessions deliberately do not steal the foreground from each other.
  // Forcing every run's page to the front would recreate the very cross-run
  // interference this isolation work is meant to remove.
  await page.addInitScript(installConsoleCaptureInPage, true);
  await withTimeout(page.evaluate(installConsoleCaptureInPage, false), BRING_TO_FRONT_TIMEOUT_MS).catch(() => {});
  const viewport = await ensurePageViewport(page, getSessionViewport(session));
  session.viewport = viewport;
}

/**
 * Destroys a browser context and everything running inside it, including pages
 * that have stopped answering: the request goes to the browser process, not to
 * the page. Every caller reaches this while cleaning up, so a browser that has
 * stopped answering entirely must not turn cleanup into the next thing to hang.
 */
async function disposeBrowserContext(rootCdp, browserContextId) {
  await withTimeout(
    rootCdp.send('Target.disposeBrowserContext', { browserContextId }),
    DISPOSE_CONTEXT_TIMEOUT_MS,
  ).catch(() => {});
}

async function disposeSession(rootCdp, state, sessionKey) {
  const session = state.sessions[sessionKey];
  if (!session) return false;
  await disposeBrowserContext(rootCdp, session.browserContextId);
  delete state.sessions[sessionKey];
  return true;
}

async function reapIdleSessions(rootCdp, state, protectedSessionKey, nowMs) {
  for (const [sessionKey, session] of Object.entries(state.sessions)) {
    if (sessionKey === protectedSessionKey || session.inFlight.length > 0) continue;
    if (nowMs - getSessionLastSeenMs(session) > SESSION_IDLE_TTL_MS) {
      await disposeSession(rootCdp, state, sessionKey);
    }
  }
}

async function evictOverflowSessions(rootCdp, state, protectedSessionKey, creatingNewSession) {
  const comparison = creatingNewSession
    ? () => Object.keys(state.sessions).length >= MAX_BROWSER_SESSIONS
    : () => Object.keys(state.sessions).length > MAX_BROWSER_SESSIONS;
  while (comparison()) {
    const candidate = Object.entries(state.sessions)
      .filter(([sessionKey, session]) => sessionKey !== protectedSessionKey && session.inFlight.length === 0)
      .sort((left, right) => getSessionLastSeenMs(left[1]) - getSessionLastSeenMs(right[1]))[0];
    if (!candidate) {
      throw new Error(`This container already has ${MAX_BROWSER_SESSIONS} active browser sessions. Close an idle browser session or wait for another Browser call to finish, then retry.`);
    }
    await disposeSession(rootCdp, state, candidate[0]);
  }
}

async function closeBrowserIfUnused(state) {
  if (Object.keys(state.sessions).length === 0) {
    await closeBrowserProcess();
    state.cdpUrl = null;
  }
}

// ── Actions ──

async function performActionOnPage(input, page, options = {}) {
  const { action } = input;
  switch (action) {
    case 'open': {
      if (!input.url) throwValidationError('"url" is required.');
      const response = await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const status = response?.status() ?? 'unknown';
      const title = escapeLineIntegrityCharacters(await page.title());
      const url = escapeLineIntegrityCharacters(input.url);
      return `Navigated to ${url}\nTitle: ${title}\nStatus: ${status}`;
    }

    case 'snapshot': {
      const url = page.url();
      const title = escapeLineIntegrityCharacters(await page.title());
      const cdp = await page.context().newCDPSession(page);
      let nodes;
      try {
        ({ nodes } = await cdp.send('Accessibility.getFullAXTree'));
      } finally {
        await cdp.detach().catch(() => {});
      }
      const tree = escapeLineIntegrityCharacters(formatAXNodes(nodes));
      return `URL: ${url}\nTitle: ${title}\n\n${tree}`;
    }

    case 'console':
      return await captureConsoleOutput(page);

    case 'click': {
      if (typeof input.selector === 'string' && input.selector.length > 0) {
        await page.click(input.selector, { timeout: 5000 });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        return `Clicked: ${input.selector}`;
      }

      const x = requireInteger(input, 'x');
      const y = requireInteger(input, 'y');
      await page.mouse.click(x, y);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return `Clicked at (${x}, ${y})`;
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

    case 'keydown': {
      await page.keyboard.down(input.key);
      return `Key down: ${input.key}`;
    }

    case 'keyup': {
      await page.keyboard.up(input.key);
      return `Key up: ${input.key}`;
    }

    case 'mousemove': {
      const { x, y } = requireCoordinatePair(input, 'x', 'y', 'mousemove');
      await page.mouse.move(x, y);
      return `Mouse moved to (${x}, ${y})`;
    }

    case 'mousedown': {
      const button = input.button ?? 'left';
      validateMouseButton(button);
      if (hasOwnInput(input, 'x') || hasOwnInput(input, 'y')) {
        const { x, y } = requireCoordinatePair(input, 'x', 'y', 'mousedown');
        await page.mouse.move(x, y);
      }
      await page.mouse.down({ button });
      return `Mouse down: ${button}`;
    }

    case 'mouseup': {
      const button = input.button ?? 'left';
      validateMouseButton(button);
      if (hasOwnInput(input, 'x') || hasOwnInput(input, 'y')) {
        const { x, y } = requireCoordinatePair(input, 'x', 'y', 'mouseup');
        await page.mouse.move(x, y);
      }
      await page.mouse.up({ button });
      return `Mouse up: ${button}`;
    }

    case 'drag': {
      const { x, y } = requireCoordinatePair(input, 'x', 'y', 'drag');
      const { x2, y2 } = requireCoordinatePair(input, 'x2', 'y2', 'drag');
      const steps = input.steps === undefined ? DEFAULT_DRAG_STEPS : requireInteger(input, 'steps');
      if (steps < 1 || steps > MAX_DRAG_STEPS) {
        throwValidationError(`"steps" must be an integer between 1 and ${MAX_DRAG_STEPS}.`);
      }
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x2, y2, { steps });
      await page.mouse.up();
      return `Dragged from (${x}, ${y}) to (${x2}, ${y2}) in ${steps} step${steps === 1 ? '' : 's'}`;
    }

    case 'screenshot': {
      const buffer = await page.screenshot({ fullPage: false });
      const title = await page.title();
      const url = page.url();
      const viewport = await getRealViewport(page);
      const summary = buildScreenshotSummary(title, url, viewport, buffer.length);
      return {
        __type: 'screenshot',
        text: summary.text,
        outputTruncated: summary.outputTruncated,
        base64: buffer.toString('base64'),
        mediaType: 'image/png',
      };
    }

    case 'resize': {
      const viewport = normalizeViewport(input);
      if (!viewport) {
        throwValidationError(getViewportValidationError(Number(input.width), Number(input.height)));
      }
      await page.setViewportSize(viewport);
      const appliedViewport = await getRealViewport(page);
      await options.onViewportChanged?.(appliedViewport);
      return `Viewport resized to ${appliedViewport.width}x${appliedViewport.height}`;
    }

    case 'scroll': {
      const delta = input.direction === 'up' ? -(input.amount ?? 300) : (input.amount ?? 300);
      await page.mouse.wheel(0, delta);
      await sleep(300);
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
      const ms = input.ms === undefined ? 1000 : requireInteger(input, 'ms');
      if (ms < 0 || ms > MAX_WAIT_MS) {
        throwValidationError(`"ms" must be an integer between 0 and ${MAX_WAIT_MS}.`);
      }
      await sleep(ms);
      return `Waited ${ms}ms`;
    }

    case 'evaluate': {
      if (!input.expression) throwValidationError('"expression" is required.');
      let result;
      try {
        result = await page.evaluate(input.expression);
      } catch (err) {
        if (isExecutionContextDestroyedError(err)) {
          throw new Error(
            'The page navigated while evaluating, which discards the result. '
            + 'Use the open action to (re)navigate, then retry the evaluate on the new page.',
          );
        }
        throw err;
      }
      return escapeLineIntegrityCharacters(
        typeof result === 'string' ? result : JSON.stringify(result, null, 2) ?? 'undefined',
      );
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
}

function getProtocolControl(input) {
  const control = input?._taurus;
  if (!control || typeof control !== 'object') return null;
  if (control.browserProtocolVersion !== BROWSER_PROTOCOL_VERSION) {
    throw new Error(`Unsupported Taurus browser protocol version: ${String(control.browserProtocolVersion)}`);
  }
  if (!isValidSessionKey(control.sessionKey)) {
    throw new Error('Browser session keys must be 1-200 characters of letters, digits, colon, underscore, or hyphen, and may not be reserved object property names.');
  }
  if (!isNonEmptyString(control.nonce)) {
    throw new Error('Browser protocol nonce is required.');
  }
  return control;
}

function getSessionRequest(input) {
  const control = getProtocolControl(input);
  return {
    sessionKey: control?.sessionKey ?? DEFAULT_SHARED_SESSION_KEY,
    nonce: control?.nonce ?? null,
  };
}

function buildProtocolEnvelope(nonce, outcome) {
  // The nonce comes from helper argv, which page JavaScript cannot read. Echoing
  // it back means page-controlled output on a mismatched old helper cannot forge
  // a plausible tool result for the daemon to trust.
  if (outcome && typeof outcome === 'object' && outcome.__type === 'screenshot') {
    return {
      __taurusBrowserResult: BROWSER_RESULT_MARKER,
      nonce,
      isError: false,
      output: outcome.text,
      outputTruncated: outcome.outputTruncated === true,
      screenshot: {
        base64: outcome.base64,
        mediaType: outcome.mediaType,
        text: outcome.text,
      },
    };
  }

  return buildBoundedProtocolTextEnvelope(nonce, false, String(outcome));
}

function buildProtocolErrorEnvelope(nonce, message) {
  return buildBoundedProtocolTextEnvelope(nonce, true, `Browser error: ${message}`);
}

function renderHelperSuccessOutput(sessionRequest, outcome) {
  if (sessionRequest.nonce === null) {
    return typeof outcome === 'string' ? outcome : JSON.stringify(outcome);
  }
  return JSON.stringify(buildProtocolEnvelope(sessionRequest.nonce, outcome));
}

async function recoverUnavailableBrowserForClose(state, sessionKey) {
  const session = state.sessions[sessionKey];
  if (!session) {
    return 'No browser session was found to close.';
  }

  const cdpUrl = state.cdpUrl;
  if (cdpUrl) {
    const recoveryCandidates = [
      sessionKey,
      ...Object.keys(state.sessions).filter(candidateKey => candidateKey !== sessionKey),
    ];
    let collateralTargetsClosed = 0;

    for (const candidateKey of recoveryCandidates) {
      const candidateSession = state.sessions[candidateKey];
      if (!candidateSession) continue;
      const targetClosed = await closeDevtoolsTarget(cdpUrl, candidateSession.targetId);
      if (targetClosed && candidateKey !== sessionKey) {
        collateralTargetsClosed += 1;
      }
      if (!await canAttachToBrowserWithBackoff(cdpUrl)) {
        continue;
      }

      let browser = null;
      let rootCdp = null;
      try {
        ({ browser, rootCdp } = await connectToBrowser(cdpUrl, ATTACH_RECOVERY_TIMEOUT_MS));
        await disposeBrowserContext(rootCdp, session.browserContextId);
      } catch {
        continue;
      } finally {
        await closeConnection(browser, rootCdp);
      }

      delete state.sessions[sessionKey];
      if (Object.keys(state.sessions).length === 0) {
        await closeBrowserProcess();
        state.cdpUrl = null;
        saveState(state);
        return collateralTargetsClosed === 0
          ? 'Browser session closed after forcing its browser page target to shut down. Chromium was then shut down because no browser sessions remained.'
          : 'Browser session closed after forcing additional browser page targets to shut down until the browser became reachable again. Chromium was then shut down because no browser sessions remained.';
      }

      saveState(state);
      return collateralTargetsClosed === 0
        ? 'Browser session closed after forcing its browser page target to shut down because the browser could not be attached normally.'
        : 'Browser session closed after forcing additional browser page targets to shut down until the browser became reachable again. Any other affected sessions will reopen fresh pages in their existing browser contexts on their next Browser call.';
    }
  }

  delete state.sessions[sessionKey];
  await closeBrowserProcess();
  state.cdpUrl = null;
  saveState(state);
  return 'Browser session closed by restarting Chromium because the browser could not be attached normally. Remaining sessions will reopen on their next Browser call.';
}

async function handleSessionClose(sessionRequest) {
  const lock = await acquireBrowserActionLock();
  let browser = null;
  let rootCdp = null;
  try {
    const state = loadState();
    pruneDeadSessionLeases(state);
    if (!state.sessions[sessionRequest.sessionKey]) {
      return 'No browser session was found to close.';
    }
    try {
      ({ browser, rootCdp } = await withTimeout(
        ensureBrowserConnection(state),
        LOCKED_BROWSER_CONNECTION_TIMEOUT_MS,
      ));
    } catch (err) {
      if (isBrowserAttachBlockedError(err)) {
        // Recovery deliberately ignores in-flight leases here. Once Chromium has
        // become unattachable, any Browser call still holding a lease is stuck
        // on that same broken browser, so waiting on the lease would only trap
        // the container in the already-failed state.
        return await recoverUnavailableBrowserForClose(state, sessionRequest.sessionKey);
      }
      throw err;
    }

    const session = state.sessions[sessionRequest.sessionKey];
    if (session && sessionHasActiveLease(session)) {
      throw new Error('This browser session already has another Browser call in flight. Wait for it to finish before closing the browser session.');
    }
    if (session) {
      await disposeSession(rootCdp, state, sessionRequest.sessionKey);
    }
    await closeBrowserIfUnused(state);
    saveState(state);
    return 'Browser session closed.';
  } finally {
    await closeConnection(browser, rootCdp);
    await lock.release();
  }
}

async function handleSessionAction(input, sessionRequest) {
  if (input.action === 'close') {
    return await handleSessionClose(sessionRequest);
  }

  validateActionInput(input);

  const lease = createLease();
  const lock = await acquireBrowserActionLock();
  let browser = null;
  let rootCdp = null;
  let page = null;
  let session = null;
  let createdSessionKey = null;
  let launchedFresh = false;
  const pageSetup = {
    abandoned: false,
    deadlineMs: 0,
  };
  try {
    const state = loadState();
    pruneDeadSessionLeases(state);
    ({ browser, rootCdp, launchedFresh } = await withTimeout(
      ensureBrowserConnection(state),
      LOCKED_BROWSER_CONNECTION_TIMEOUT_MS,
    ));
    if (launchedFresh) {
      await discardAllPages(browser);
    }
    await reapIdleSessions(rootCdp, state, sessionRequest.sessionKey, Date.now());

    session = state.sessions[sessionRequest.sessionKey];
    await evictOverflowSessions(rootCdp, state, sessionRequest.sessionKey, !session);
    if (!session) {
      session = await createIsolatedSession(rootCdp, DEFAULT_VIEWPORT);
      state.sessions[sessionRequest.sessionKey] = session;
      createdSessionKey = sessionRequest.sessionKey;
      saveState(state);
    }
    if (sessionHasActiveLease(session)) {
      throw new Error('This browser session already has another Browser call in flight. Wait for it to finish before issuing another Browser action.');
    }

    pageSetup.deadlineMs = Date.now() + LOCKED_PAGE_SETUP_TIMEOUT_MS;
    page = await withTimeout(
      prepareIsolatedPage(
        browser,
        rootCdp,
        session,
        () => {
          if (!pageSetup.abandoned) saveState(state);
        },
        pageSetup.deadlineMs,
      ),
      LOCKED_PAGE_SETUP_TIMEOUT_MS,
    );
    await withTimeout(
      primeIsolatedPage(page, session, sessionRequest.sessionKey),
      LOCKED_PAGE_SETUP_TIMEOUT_MS,
    );
    if (launchedFresh) {
      await discardOtherPages(page);
    }
    session.lastSeenAt = nowIso();
    session.inFlight.push(lease);
    saveState(state);
  } catch (err) {
    pageSetup.abandoned = true;
    if (rootCdp && createdSessionKey) {
      const cleanupState = loadState();
      if (cleanupState.sessions[createdSessionKey]?.browserContextId === session?.browserContextId) {
        await disposeSession(rootCdp, cleanupState, createdSessionKey);
        saveState(cleanupState);
      }
    }
    await closeConnection(browser, rootCdp);
    throw err;
  } finally {
    pageSetup.abandoned = true;
    await lock.release();
  }

  let viewportAfter = null;
  try {
    return await withTimeout(
      performActionOnPage(input, page, {
        async onViewportChanged(viewport) {
          viewportAfter = viewport;
        },
      }),
      ACTION_TIMEOUT_MS,
      `Browser action "${input.action}"`,
    );
  } finally {
    const finalizeLock = await acquireBrowserActionLock();
    try {
      const finalizeState = loadState();
      pruneDeadSessionLeases(finalizeState);
      const currentSession = finalizeState.sessions[sessionRequest.sessionKey];
      if (currentSession) {
        removeSessionLease(currentSession, lease.leaseId);
        currentSession.lastSeenAt = nowIso();
        if (viewportAfter) {
          currentSession.viewport = viewportAfter;
        }
      }
      saveState(finalizeState);
    } finally {
      await closeConnection(browser, rootCdp);
      await finalizeLock.release();
    }
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
  const sessionRequest = getSessionRequest(input);
  if (sessionRequest.nonce !== null) {
    try {
      const result = await handleSessionAction(input, sessionRequest);
      process.stdout.write(renderHelperSuccessOutput(sessionRequest, result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(JSON.stringify(buildProtocolErrorEnvelope(sessionRequest.nonce, message)));
    }
  } else {
    const result = await handleSessionAction(input, sessionRequest);
    process.stdout.write(renderHelperSuccessOutput(sessionRequest, result));
  }
} catch (err) {
  process.stderr.write(`Browser error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
