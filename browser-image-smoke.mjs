#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';

const BROWSER_CLI_PATH = process.env.BROWSER_CLI_PATH || '/usr/local/lib/browser-cli.mjs';
const BROWSER_STATE_PATH = '/tmp/.browser-cli.json';
const BROWSER_ACTION_LOCK_PATH = '/tmp/.browser-cli.action.lock';
const SMOKE_SESSION_PREFIX = '__browser-smoke__:';
const SMOKE_SESSION_NAMES = [
  'isolated-alpha',
  'isolated-beta',
  'ttl-a',
  'ttl-b',
  'lease-a',
  'evict-a',
  'evict-b',
  'evict-c',
  'oversized-output',
  'abandoned-action',
  'abandoned-wedge',
  'budget-deadline',
  'hostile-wedge',
  'hostile-survivor',
  'hostile-escalation-closee',
  'hostile-escalation-survivor',
  'hostile-escalation-hidden',
];
const BROWSER_USER = process.env.TAURUS_BROWSER_USER || 'taurus-browser';
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const NEXT_LINE = String.fromCharCode(0x85);

// Screenshots at the largest supported viewport are several megabytes of
// base64, well past spawnSync's 1MB default, which would otherwise kill the
// helper mid-write and look like a helper failure.
const MAX_HELPER_OUTPUT_BYTES = 32 * 1024 * 1024;

// Nothing this smoke spawns is allowed to run forever. Without a bound the
// whole suite hangs on one stuck child, and CI only notices when the job hits
// the runner's own limit hours later.
//
// The helper gets the generous bound: a `wait` action alone can ask it to sleep
// for a minute, and it has its own deadlines well inside this one, so reaching
// this bound means the helper is stuck rather than merely slow.
const HELPER_TIMEOUT_MS = 240_000;
// The probes are a single CDP request or a `pgrep`: seconds, not minutes.
const PROBE_TIMEOUT_MS = 60_000;

const SMOKE_STARTED_AT_MS = Date.now();

/**
 * Announces what the smoke is about to do, with elapsed time. Individual checks
 * are silent unless they fail, so without these a hang leaves nothing in the CI
 * log but whatever command ran before this file started.
 */
function phase(description) {
  const elapsedSeconds = ((Date.now() - SMOKE_STARTED_AT_MS) / 1_000).toFixed(1);
  console.log(`[browser smoke +${elapsedSeconds}s] ${description}`);
}

// Keep failure reports readable: a failing screenshot carries megabytes.
function excerptStream(stream) {
  const text = stream || '';
  return `${text.slice(0, 2_000)}${text.length > 2_000 ? ' …(truncated)' : ''}`;
}

/**
 * Turns a child that never produced an exit status into a loud, specific
 * failure. `spawnSync` reports a timeout, a failure to spawn and an output
 * overflow the same way: `error` is set and `status` is null. A caller that
 * only looks at the status cannot tell any of those from an ordinary non-zero
 * exit — and `null !== 0`, so a hang would otherwise read as exactly the
 * failure some of the callers below are expecting.
 */
function assertChildCompleted(label, result, timeoutMs) {
  if (!result.error) return;
  const reason = result.error.code === 'ETIMEDOUT'
    ? `did not finish within ${timeoutMs}ms and was killed`
    : `could not be run: ${result.error.message}`;
  throw new Error([
    `${label} ${reason}`,
    'stdout:',
    excerptStream(result.stdout),
    'stderr:',
    excerptStream(result.stderr),
  ].join('\n'));
}

function browser(input, { expectFailure = false, env } = {}) {
  const result = spawnSync('node', [BROWSER_CLI_PATH, JSON.stringify(input)], {
    encoding: 'utf8',
    maxBuffer: MAX_HELPER_OUTPUT_BYTES,
    timeout: HELPER_TIMEOUT_MS,
    env: env ? { ...process.env, ...env } : process.env,
  });

  assertChildCompleted(`browser-cli for ${JSON.stringify(input)}`, result, HELPER_TIMEOUT_MS);

  if (expectFailure) {
    assert.notStrictEqual(result.status, 0, `Expected browser helper failure for ${JSON.stringify(input)}`);
    return `${result.stdout || ''}${result.stderr || ''}`;
  }

  if (result.status !== 0) {
    throw new Error([
      `browser-cli failed for ${JSON.stringify(input)} (status ${result.status}, signal ${result.signal}, error ${result.error?.message ?? 'none'})`,
      'stdout:',
      excerptStream(result.stdout),
      'stderr:',
      excerptStream(result.stderr),
    ].join('\n'));
  }

  return result.stdout;
}

let isolatedNonceCounter = 0;

function nextIsolatedNonce() {
  isolatedNonceCounter += 1;
  return `nonce-${isolatedNonceCounter}`;
}

function smokeSessionKey(name) {
  return `${SMOKE_SESSION_PREFIX}${name}`;
}

function callIsolatedBrowser(sessionKey, input, { expectFailure = false, env } = {}) {
  const nonce = nextIsolatedNonce();
  const rawOutput = browser({
    ...input,
    _taurus: {
      browserProtocolVersion: 2,
      sessionKey,
      nonce,
    },
  }, { env });

  const envelope = JSON.parse(rawOutput);
  assert.equal(envelope.__taurusBrowserResult, 1, `expected an isolated browser envelope for ${sessionKey}`);
  assert.equal(envelope.nonce, nonce, `expected the helper to echo nonce ${nonce}`);
  assert.equal(typeof envelope.output, 'string', 'isolated browser output should be textual');
  assert.equal(typeof envelope.outputTruncated, 'boolean', 'isolated browser envelopes must declare whether helper-side truncation happened');
  assert.equal(envelope.isError, expectFailure, `unexpected isolated browser error state for ${sessionKey}: ${envelope.output}`);
  return { rawOutput, envelope };
}

function isolatedBrowser(sessionKey, input, options) {
  return callIsolatedBrowser(sessionKey, input, options).envelope;
}

function isolatedText(sessionKey, input, options) {
  return isolatedBrowser(sessionKey, input, options).output;
}

function isolatedScreenshot(sessionKey, options) {
  const envelope = isolatedBrowser(sessionKey, { action: 'screenshot' }, options);
  assert.equal(envelope.isError, false, `isolated screenshot for ${sessionKey} should succeed`);
  assert.equal(envelope.screenshot?.mediaType, 'image/png');
  assert.ok(envelope.screenshot?.base64.length > 0, 'isolated screenshot payload should not be empty');
  return envelope;
}

function isolatedBrowserAsync(sessionKey, input, { env } = {}) {
  const nonce = nextIsolatedNonce();
  return new Promise((resolve, reject) => {
    const child = spawn('node', [BROWSER_CLI_PATH, JSON.stringify({
      ...input,
      _taurus: {
        browserProtocolVersion: 2,
        sessionKey,
        nonce,
      },
    })], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // Same bound as the synchronous calls, enforced by hand because this one is
    // a plain spawn. SIGKILL rather than SIGTERM: the point of reaching here is
    // that the helper stopped responding.
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, HELPER_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', error => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on('exit', code => {
      clearTimeout(deadline);
      if (timedOut) {
        reject(new Error(`isolated helper for ${sessionKey} did not finish within ${HELPER_TIMEOUT_MS}ms and was killed: ${stderr || stdout}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`isolated helper exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        const envelope = JSON.parse(stdout);
        assert.equal(envelope.__taurusBrowserResult, 1, 'expected an isolated browser envelope from the async helper');
        assert.equal(envelope.nonce, nonce, `expected the async helper to echo nonce ${nonce}`);
        assert.equal(typeof envelope.outputTruncated, 'boolean', 'async isolated-browser envelopes must declare whether helper-side truncation happened');
        resolve(envelope);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runLockedStateScript(script, args = [], { input } = {}) {
  const result = spawnSync(
    'flock',
    ['-x', BROWSER_ACTION_LOCK_PATH, 'node', '-e', script, BROWSER_STATE_PATH, ...args],
    // The lock is held for the length of a helper action, so this waits as long
    // as a helper call may take rather than as long as a probe may take.
    { encoding: 'utf8', input, timeout: HELPER_TIMEOUT_MS },
  );
  assertChildCompleted('locked state helper', result, HELPER_TIMEOUT_MS);
  if (result.status !== 0) {
    throw new Error(`locked state helper failed: ${result.stderr || result.stdout || result.error?.message || 'unknown error'}`);
  }
  return result.stdout || '';
}

function getPersistedSessions() {
  try {
    // The helper rewrites its state file while holding a flock on this lock
    // path. Read under the same lock so the smoke never mistakes a torn rewrite
    // for "no default session" and tears down someone else's idle browser.
    const state = JSON.parse(runLockedStateScript(`
      const fs = require('fs');
      try {
        process.stdout.write(fs.readFileSync(process.argv[1], 'utf8'));
      } catch {
        process.stdout.write('{}');
      }
    `) || '{}');
    return state && typeof state === 'object' && state.sessions && typeof state.sessions === 'object'
      ? state.sessions
      : {};
  } catch {
    return {};
  }
}

function defaultSessionExists() {
  return Object.prototype.hasOwnProperty.call(getPersistedSessions(), 'default');
}

/**
 * The smoke suite gets rerun in long-lived containers, including after a failed
 * attempt that may have left behind the sessions this suite uses. Reset by
 * asking the helper to close only those known sessions under its own lock, so a
 * rerun starts clean without deleting shared state or breaking another lock
 * holder's inode out from under it.
 */
function resetBrowserFixtureState({ closeDefaultSession } = {}) {
  closeBrowserTargetsMatching(/^http:\/\/127\.0\.0\.1:\d+\/wedge(?:-slow)?$/);
  if (closeDefaultSession) {
    try {
      browser({ action: 'close' });
    } catch {
      /* ignore a missing or already-broken shared smoke session during cleanup */
    }
  }
  for (const sessionName of SMOKE_SESSION_NAMES) {
    try {
      isolatedText(smokeSessionKey(sessionName), { action: 'close' });
    } catch {
      /* ignore a missing or already-broken isolated smoke session during cleanup */
    }
  }
}

/**
 * Serves fixture pages over http. Chromium refuses page-initiated top-frame
 * navigation to data: URLs, so the scenarios that need a page to navigate
 * itself need a real origin. The server has to live in its own process: this
 * driver blocks its own event loop on every spawnSync browser call and could
 * never answer a request otherwise.
 */
const PAGE_SERVER_SOURCE = `
const http = require('http');
const fs = require('fs');
const [portFile, routesJson] = process.argv.slice(1);
const routes = JSON.parse(routesJson);
const server = http.createServer((req, res) => {
  const body = routes[req.url.split('?')[0]];
  if (body === undefined) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, JSON.stringify({ port: server.address().port })));
setTimeout(() => process.exit(0), 300000).unref();
`;

function startPageServer(routes) {
  const portFile = `/tmp/.browser-smoke-pages-${process.pid}.json`;
  if (existsSync(portFile)) unlinkSync(portFile);

  const child = spawn('node', ['-e', PAGE_SERVER_SOURCE, portFile, JSON.stringify(routes)], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();

  let port = null;
  for (let attempt = 0; attempt < 200 && port === null; attempt += 1) {
    sleepSync(25);
    try { port = JSON.parse(readFileSync(portFile, 'utf8')).port; } catch { /* not listening yet */ }
  }
  if (port === null) throw new Error('fixture page server did not start');

  return {
    origin: `http://127.0.0.1:${port}`,
    stop() {
      try { process.kill(child.pid); } catch { /* already gone */ }
      try { if (existsSync(portFile)) unlinkSync(portFile); } catch { /* ignore */ }
    },
  };
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function listBrowserTargets() {
  const probe = spawnSync('node', ['-e', `
    fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(2000) })
      .then(response => response.json())
      .then(targets => console.log(JSON.stringify(Array.isArray(targets) ? targets : null)))
      .catch(() => console.log('null'));
  `], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  // A stuck probe must not be read as "the browser has no targets": callers
  // poll this one until it agrees with them, and a silent null would turn a
  // hang into a wait that only ends at the poll deadline.
  assertChildCompleted('devtools target listing', probe, PROBE_TIMEOUT_MS);
  try {
    const parsed = JSON.parse((probe.stdout || '').trim());
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getBrowserProcessSignature() {
  const probe = spawnSync('pgrep', ['-o', '-u', BROWSER_USER, '-f', 'chrome.*--remote-debugging-port=9222'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  assertChildCompleted('browser process lookup', probe, PROBE_TIMEOUT_MS);
  return probe.status === 0 ? (probe.stdout || '').trim() || null : null;
}

function getBrowserContextCount() {
  const probe = spawnSync('node', ['-e', `
    (async () => {
      const { createRequire } = require('module');
      const requireFromGlobal = createRequire('/usr/lib/node_modules/');
      const { chromium } = requireFromGlobal('playwright');
      const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 2000 });
      const root = await browser.newBrowserCDPSession();
      const { browserContextIds } = await root.send('Target.getBrowserContexts');
      await root.detach().catch(() => {});
      await browser.close().catch(() => {});
      console.log(String(browserContextIds.length));
    })().catch(error => console.log('failed:' + error.message));
  `], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  assertChildCompleted('browser context count probe', probe, PROBE_TIMEOUT_MS);
  const output = (probe.stdout || '').trim();
  assert.match(output, /^\d+$/, `could not read live browser context count: ${output || probe.stderr}`);
  return Number(output);
}

/**
 * The URLs of the pages the browser is holding, asked of the browser itself:
 * the helper only ever exposes the one page it drives, so the rest are
 * invisible from the actions alone.
 */
function listBrowserPageTargets() {
  const targets = listBrowserTargets();
  return targets ? targets.filter(target => target.type === 'page').map(target => target.url) : null;
}

function closeBrowserTargetsMatching(pattern) {
  const targets = listBrowserTargets() ?? [];
  for (const target of targets) {
    if (target?.type !== 'page' || typeof target?.url !== 'string' || typeof target?.id !== 'string') continue;
    if (!pattern.test(target.url)) continue;
    const closeResult = spawnSync('node', ['-e', `
      fetch(${JSON.stringify(`http://127.0.0.1:9222/json/close/${target.id}`)}, { method: 'PUT', signal: AbortSignal.timeout(2000) })
        .then(() => console.log('closed'))
        .catch(error => console.log('failed:' + error.message));
    `], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    assertChildCompleted(`close of browser target ${target.id}`, closeResult, PROBE_TIMEOUT_MS);
    assert.equal((closeResult.stdout || '').trim(), 'closed', `could not close browser target ${target.id} for ${target.url}`);
  }
}

function deletePersistedSessionRecord(sessionKey) {
  runLockedStateScript(`
    const fs = require('fs');
    const statePath = process.argv[1];
    const sessionKey = process.argv[2];
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state?.sessions && typeof state.sessions === 'object') {
      delete state.sessions[sessionKey];
    }
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
  `, [sessionKey]);
}

/**
 * Waits for the browser to reach a starting state — a tab it was told to open
 * having committed its first document, say. Deliberately used for setup only,
 * never for the behaviour under test: polling the behaviour would hand a broken
 * helper repeated chances to look right by accident.
 */
function waitForPageTargets(predicate, label, { timeoutMs = 5_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let urls = listBrowserPageTargets();
  while (!(urls && predicate(urls)) && Date.now() < deadline) {
    sleepSync(intervalMs);
    urls = listBrowserPageTargets();
  }
  assert.ok(urls && predicate(urls), `${label} (browser tabs: ${JSON.stringify(urls)})`);
  return urls;
}

function buildProbePage() {
  const html = `<!doctype html><title>browser smoke</title><style>html,body,canvas{margin:0;width:100%;height:100%}body{overflow:hidden}canvas{display:block;background:#111}</style><canvas id="game" width="320" height="200"></canvas><script>
const lineSeparator = String.fromCharCode(0x2028);
const paragraphSeparator = String.fromCharCode(0x2029);
const state = window.__probe = { keys: {}, keyEvents: [], mouseMoves: [], mouseDowns: [], mouseUps: [], clicks: [], dragTrail: [], dragging: false };
window.addEventListener("keydown", event => { state.keys[event.key] = true; state.keyEvents.push({ type: "down", key: event.key, shiftKey: event.shiftKey }); });
window.addEventListener("keyup", event => { state.keys[event.key] = false; state.keyEvents.push({ type: "up", key: event.key, shiftKey: event.shiftKey }); });
window.addEventListener("mousemove", event => { state.mouseMoves.push({ x: event.clientX, y: event.clientY, buttons: event.buttons }); if (state.dragging) state.dragTrail.push({ x: event.clientX, y: event.clientY, buttons: event.buttons }); });
window.addEventListener("mousedown", event => { state.dragging = true; state.mouseDowns.push({ x: event.clientX, y: event.clientY, button: event.button, buttons: event.buttons }); });
window.addEventListener("mouseup", event => { state.dragging = false; state.mouseUps.push({ x: event.clientX, y: event.clientY, button: event.button, buttons: event.buttons }); });
window.addEventListener("click", event => { state.clicks.push({ x: event.clientX, y: event.clientY, button: event.button }); });
console.log("boot log", 42);
console.log("unicode line integrity", "left" + lineSeparator + "middle" + paragraphSeparator + "right", "你好🙂");
console.log("player state", { hp: 3, name: "hero" });
console.log("inventory", [1, 2, 3]);
console.log("buff map", new Map([["hp", 3]]));
console.warn("a warning\\nwith newline\\tand tab\\u001b[31mRED\\u001b[0m");
console.error(new Error("combat fail"));
setTimeout(() => { throw new Error("boot crash"); }, 0);
new Image().src = "http://127.0.0.1:9/tex.png";
</script>`;
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
}

function buildEscapedOutputPage() {
  const title = `title${LINE_SEPARATOR}split${PARAGRAPH_SEPARATOR}again${NEXT_LINE}done`;
  const aria = `label${LINE_SEPARATOR}split${PARAGRAPH_SEPARATOR}again${NEXT_LINE}done`;
  const body = `body${LINE_SEPARATOR}split${PARAGRAPH_SEPARATOR}again${NEXT_LINE}done`;
  const html = `<!doctype html><title>${title}</title><button aria-label="${aria}">Play</button><h1>${body}</h1><script>
window.__unsafe = {
  title: ${JSON.stringify(title)},
  aria: ${JSON.stringify(aria)},
  body: ${JSON.stringify(body)},
};
</script>`;
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
}

function buildOrderingPage() {
  const html = '<!doctype html><title>ordering</title><script>fetch("http://127.0.0.1:9/missing.js").catch(() => setTimeout(() => console.log("after fetch failure"), 50));</script>';
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
}

// Console methods the shim has to render on its own: they either carry state
// (count/time) or only sometimes produce an entry (assert).
function buildConsoleMethodsPage() {
  const html = `<!doctype html><title>console methods</title><script>
console.assert(1 === 2, "hp mismatch", { hp: 3 });
console.assert(true, "passing assertion must stay silent");
console.count("wave");
console.count("wave");
console.countReset("wave");
console.count("wave");
console.time("boot");
console.timeLog("boot", "halfway");
console.timeEnd("boot");
console.timeEnd("never started");
console.group("phase one");
console.log("inside group");
console.groupEnd();
console.timeStamp("frame");
</script>`;
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
}

// A page that logs normally and then tampers with the capture buffer the helper
// reads, to check the helper assigns entry types and positions itself.
function buildForgedConsolePage() {
  const html = `<!doctype html><title>forged console</title><script>
console.log("genuine first");
console.log("genuine second");
</script>`;
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
}

// Realistic dense page content: text, borders and gradients across the whole
// viewport, so a screenshot at large viewports is a meaningful payload rather
// than a flat colour that compresses to nothing.
function buildContentHeavyPage() {
  const html = `<!doctype html><title>content heavy</title><style>
body{margin:0;font:12px/1.3 monospace;background:linear-gradient(135deg,#123,#987)}
div{display:inline-block;width:118px;height:64px;margin:1px;padding:2px;border:1px solid #fff;overflow:hidden;color:#fff}
</style><script>
const parts = [];
for (let index = 0; index < 900; index += 1) {
  const hue = (index * 37) % 360;
  parts.push('<div style="background:hsl(' + hue + ',70%,45%)">tile ' + index + ' lorem ipsum dolor sit amet consectetur ' + (index * 7919) + '</div>');
}
document.write(parts.join(""));
</script>`;
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
}

function evaluateJson(expression) {
  return JSON.parse(browser({ action: 'evaluate', expression }));
}

function assertNoUnsafeLineSeparators(text, label) {
  assert.equal(text.includes(LINE_SEPARATOR), false, `${label} should not contain raw 0x2028`);
  assert.equal(text.includes(PARAGRAPH_SEPARATOR), false, `${label} should not contain raw 0x2029`);
  assert.equal(text.includes(NEXT_LINE), false, `${label} should not contain raw 0x85`);
}

function assertEscapedUnsafeLineSeparators(text, label) {
  assert.equal(text.includes('\\u2028'), true, `${label} should escape 0x2028`);
  assert.equal(text.includes('\\u2029'), true, `${label} should escape 0x2029`);
  assert.equal(text.includes('\\x85'), true, `${label} should escape 0x85`);
}

function assertAppearsBefore(text, earlier, later, label) {
  const earlierIndex = text.indexOf(earlier);
  const laterIndex = text.indexOf(later);
  assert.equal(earlierIndex >= 0, true, `${label} should contain ${JSON.stringify(earlier)}`);
  assert.equal(laterIndex >= 0, true, `${label} should contain ${JSON.stringify(later)}`);
  assert.equal(earlierIndex < laterIndex, true, `${label} should keep ${JSON.stringify(earlier)} before ${JSON.stringify(later)}`);
}

async function runSmoke() {
  const defaultSessionOwnedBySmoke = !defaultSessionExists();
  if (!defaultSessionOwnedBySmoke) {
    console.log('Skipping shared default-session smoke because this container already has a default browser session. Running isolated-session checks only.');
  }

  if (defaultSessionOwnedBySmoke) {
  phase('shared session: page load and console capture');
  const openOutput = browser({ action: 'open', url: buildProbePage() });
  assert.match(openOutput, /Title: browser smoke/);

  const consoleOutput = browser({ action: 'console' });
  assert.match(consoleOutput, /\[log\] boot log 42/);
  assert.match(consoleOutput, /\[log\] unicode line integrity left\\u2028middle\\u2029right 你好🙂/);
  assert.match(consoleOutput, /\[log\] player state \{hp: 3, name: "hero"\}/);
  assert.match(consoleOutput, /\[log\] inventory \[1, 2, 3\]/);
  assert.match(consoleOutput, /\[log\] buff map Map\(1\) \{"hp" => 3\}/);
  assert.match(consoleOutput, /\[warn\] a warning\\nwith newline\\tand tabRED/);
  assert.match(consoleOutput, /\[error\] Error: combat fail/);
  assert.match(consoleOutput, /\[exception\] Error: boot crash/);
  assert.match(consoleOutput, /\[network\].*127\.0\.0\.1:9\/tex\.png/);
  assert.doesNotMatch(consoleOutput, /\u001b\[/);
  assert.doesNotMatch(consoleOutput, /^\[warn\].*\nwith newline/m);
  assertNoUnsafeLineSeparators(consoleOutput, 'console output');
  assert.equal(consoleOutput.includes('你好🙂'), true, 'console output should preserve non-control Unicode');
  // The in-page buffer and CDP replay both cover this load; exactly one of them
  // may be reported, or every message would show up twice.
  assert.equal(countOccurrences(consoleOutput, '[log] boot log 42'), 1, 'console entries must not be reported twice');
  assert.equal(countOccurrences(consoleOutput, '[exception] Error: boot crash'), 1, 'exceptions must not be reported twice');
  assert.match(browser({ action: 'console' }), /\[log\] boot log 42/);

  phase('shared session: keyboard and mouse input');
  browser({ action: 'keydown', key: 'w' });
  let state = evaluateJson('JSON.stringify(window.__probe)');
  assert.equal(state.keys.w, true);
  assert.deepEqual(state.keyEvents.at(-1), { type: 'down', key: 'w', shiftKey: false });

  browser({ action: 'keyup', key: 'w' });
  state = evaluateJson('JSON.stringify(window.__probe)');
  assert.equal(state.keys.w, false);
  assert.deepEqual(state.keyEvents.at(-1), { type: 'up', key: 'w', shiftKey: false });

  browser({ action: 'mousemove', x: 25, y: 35 });
  assert.deepEqual(evaluateJson('JSON.stringify(window.__probe.mouseMoves.at(-1))'), { x: 25, y: 35, buttons: 0 });

  browser({ action: 'mousedown', x: 30, y: 40, button: 'right' });
  assert.deepEqual(evaluateJson('JSON.stringify(window.__probe.mouseDowns.at(-1))'), { x: 30, y: 40, button: 2, buttons: 2 });

  browser({ action: 'mouseup', x: 30, y: 40, button: 'right' });
  assert.deepEqual(evaluateJson('JSON.stringify(window.__probe.mouseUps.at(-1))'), { x: 30, y: 40, button: 2, buttons: 0 });

  browser({ action: 'drag', x: 40, y: 50, x2: 90, y2: 95, steps: 4 });
  state = evaluateJson('JSON.stringify(window.__probe)');
  assert.deepEqual(state.mouseDowns.at(-1), { x: 40, y: 50, button: 0, buttons: 1 });
  assert.deepEqual(state.mouseUps.at(-1), { x: 90, y: 95, button: 0, buttons: 0 });
  assert.deepEqual(state.dragTrail.at(-1), { x: 90, y: 95, buttons: 1 });

  browser({ action: 'click', x: 55, y: 65 });
  assert.deepEqual(evaluateJson('JSON.stringify(window.__probe.clicks.at(-1))'), { x: 55, y: 65, button: 0 });

  assert.match(
    browser({ action: 'click', x: -5, y: 10 }, { expectFailure: true }),
    /"x" is required and must be a non-negative integer\./,
  );
  assert.match(
    browser({ action: 'click', x: null, y: 10 }, { expectFailure: true }),
    /"x" is required and must be a non-negative integer\./,
  );
  assert.match(
    browser({ action: 'mousemove', x: '25', y: 35 }, { expectFailure: true }),
    /"x" is required and must be a non-negative integer\./,
  );
  assert.match(
    browser({ action: 'mousedown', x: true, y: 10 }, { expectFailure: true }),
    /"x" is required and must be a non-negative integer\./,
  );
  assert.match(
    browser({ action: 'drag', x: 0, y: 0, x2: 10, y2: 10, steps: '4' }, { expectFailure: true }),
    /"steps" is required and must be an integer\./,
  );
  assert.match(
    browser({ action: 'drag', x: 0, y: 0, x2: 10, y2: 10, steps: null }, { expectFailure: true }),
    /"steps" is required and must be an integer\./,
  );
  assert.match(
    browser({ action: 'drag', x: 0, y: 0, x2: 10, y2: 10, steps: true }, { expectFailure: true }),
    /"steps" is required and must be an integer\./,
  );

  phase('shared session: snapshot, screenshot and viewport');
  const snapshot = browser({ action: 'snapshot' });
  assert.match(snapshot, /Title: browser smoke/);

  const screenshot = JSON.parse(browser({ action: 'screenshot' }));
  assert.equal(screenshot.__type, 'screenshot');
  assert.ok(screenshot.base64.length > 0, 'screenshot payload should not be empty');

  const resizeOutput = browser({ action: 'resize', width: 800, height: 600 });
  assert.match(resizeOutput, /800x600/);
  assert.deepEqual(evaluateJson('JSON.stringify({ width: window.innerWidth, height: window.innerHeight })'), { width: 800, height: 600 });

  const webglProbe = evaluateJson(`(async () => {
    const canvas = document.getElementById("game");
    const gl = canvas.getContext("webgl2");
    if (!gl) {
      return JSON.stringify({ webgl2: false, renderer: null, pixels: null, webgpuAdapter: "missing" });
    }

    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.25, 0.5, 0.75, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const pixels = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;

    return JSON.stringify({
      webgl2: true,
      renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null,
      pixels: Array.from(pixels),
      webgpuAdapter: adapter ? "present" : "null",
    });
  })()`);
  assert.equal(webglProbe.webgl2, true);
  assert.match(webglProbe.renderer, /SwiftShader/i);
  assert.deepEqual(webglProbe.pixels, [64, 128, 191, 255]);
  assert.equal(webglProbe.webgpuAdapter, 'null');

  phase('shared session: output escaping');
  const escapedOpenOutput = browser({ action: 'open', url: buildEscapedOutputPage() });
  assert.equal(escapedOpenOutput.includes('Title: title\\u2028split\\u2029again\\x85done'), true, 'open output should escape unsafe title separators');
  assertNoUnsafeLineSeparators(escapedOpenOutput, 'open output');

  // The echoed URL is the agent's own input, but it shares the rendered block
  // with page-derived lines, so it gets the same separator escaping.
  const fragmentUrl = `data:text/html;charset=UTF-8,${encodeURIComponent('<title>fragment</title>')}#a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c${NEXT_LINE}d`;
  const escapedUrlOutput = browser({ action: 'open', url: fragmentUrl });
  assert.equal(escapedUrlOutput.includes('#a\\u2028b\\u2029c\\x85d'), true, 'open output should escape unsafe URL separators');
  assertNoUnsafeLineSeparators(escapedUrlOutput, 'open url echo');
  browser({ action: 'open', url: buildEscapedOutputPage() });

  const escapedSnapshot = browser({ action: 'snapshot' });
  assert.equal(escapedSnapshot.includes('button "label\\u2028split\\u2029again\\x85done"'), true, 'snapshot should escape aria-label separators');
  assert.equal(escapedSnapshot.includes('heading "body\\u2028split\\u2029again\\x85done"'), true, 'snapshot should escape body text separators');
  assertEscapedUnsafeLineSeparators(escapedSnapshot, 'snapshot output');
  assertNoUnsafeLineSeparators(escapedSnapshot, 'snapshot output');

  const escapedEvaluate = browser({ action: 'evaluate', expression: 'window.__unsafe' });
  assertEscapedUnsafeLineSeparators(escapedEvaluate, 'evaluate output');
  assertNoUnsafeLineSeparators(escapedEvaluate, 'evaluate output');

  const multilineEvaluate = browser({ action: 'evaluate', expression: '(() => "line 1\\nline 2")()' });
  assert.equal(multilineEvaluate, 'line 1\nline 2');

  const escapedScreenshot = JSON.parse(browser({ action: 'screenshot' }));
  assert.equal(escapedScreenshot.__type, 'screenshot');
  assertEscapedUnsafeLineSeparators(escapedScreenshot.text, 'screenshot text');
  assertNoUnsafeLineSeparators(escapedScreenshot.text, 'screenshot text');

  phase('shared session: console ordering and caps');
  browser({ action: 'open', url: buildOrderingPage() });
  browser({ action: 'wait', ms: 500 });
  const orderedConsoleOutput = browser({ action: 'console' });
  assertAppearsBefore(orderedConsoleOutput, '[network]', '[log] after fetch failure', 'ordered console output');

  browser({
    action: 'open',
    url: `data:text/html;charset=UTF-8,${encodeURIComponent('<!doctype html><title>console cap</title>')}`,
  });
  evaluateJson(`(() => {
    const payload = "x".repeat(600);
    for (let index = 1; index <= 210; index += 1) {
      console.log("cap-line-" + String(index).padStart(3, "0"), payload);
    }
    return JSON.stringify(true);
  })()`);
  const cappedConsoleOutput = browser({ action: 'console' });
  const cappedConsoleLines = cappedConsoleOutput.split('\n');
  assert.equal(cappedConsoleLines[0], '... 10 older entries omitted.');
  assert.equal(cappedConsoleLines[1], '... 1 additional entry omitted after reaching the output cap.');
  assert.equal(cappedConsoleOutput.includes('[log] cap-line-210'), true, 'newest capped console entry should survive output trimming');
  assert.equal(cappedConsoleOutput.includes('[log] cap-line-011'), false, 'oldest retained console entry should be dropped first at the output cap');

  assert.match(
    browser({ action: 'keydown', key: 'Control+a' }, { expectFailure: true }),
    /Use "press" for key chords/,
  );

  runConsoleMethodSmoke();
  runForgedConsoleSmoke();
  runViewportScreenshotSmoke();
  }

  const pageServer = startPageServer(NAVIGATION_ROUTES);
  try {
    if (defaultSessionOwnedBySmoke) {
      runPageInitiatedNavigationSmoke(pageServer.origin);
      runStrandedTabSmoke(pageServer.origin);
      runExternalBlankTabSmoke(pageServer.origin);
      runSessionResetSmoke(pageServer.origin);
    }
    await runAbandonedActionRecoverySmoke(pageServer.origin);
    runHostilePageIsolationSmoke(pageServer.origin);
    runHostilePageEscalationSmoke(pageServer.origin);
    await runIsolatedSessionSmoke(pageServer.origin, { closeDefaultSession: defaultSessionOwnedBySmoke });
  } finally {
    phase('cleanup');
    pageServer.stop();
    resetBrowserFixtureState({ closeDefaultSession: defaultSessionOwnedBySmoke });
  }

  console.log('Base image browser smoke passed.');
}

/** Console methods beyond log/warn/error still reach the agent. */
function runConsoleMethodSmoke() {
  phase('console methods');
  browser({ action: 'open', url: buildConsoleMethodsPage() });
  const output = browser({ action: 'console' });

  assert.match(output, /\[assert\] Assertion failed: hp mismatch \{hp: 3\}/);
  assert.equal(output.includes('passing assertion'), false, 'a passing console.assert must not be reported');
  assert.equal(countOccurrences(output, '[count] wave: 1'), 2, 'console.countReset should restart the counter');
  assert.equal(countOccurrences(output, '[count] wave: 2'), 1, 'console.count should increment');
  assert.match(output, /\[timeLog\] boot: \d+\.\d\dms halfway/);
  assert.match(output, /\[timeEnd\] boot: \d+\.\d\dms/);
  assert.match(output, /\[timeEnd\] never started: timer does not exist/);
  assert.match(output, /\[group\] phase one/);
  assert.match(output, /\[groupEnd\]/);
  assert.match(output, /\[timeStamp\] frame/);
  assertAppearsBefore(output, '[group] phase one', '[log] inside group', 'grouped console output');
}

/**
 * The in-page buffer is writable by the page it captures, so entry types and
 * positions have to be decided by the helper, not by the page.
 */
function runForgedConsoleSmoke() {
  phase('forged console output');
  browser({ action: 'open', url: buildForgedConsolePage() });

  // Push entries claiming a browser-attested type, and timestamps far outside
  // the life of this document, after two genuine entries.
  evaluateJson(`(() => {
    const buffer = globalThis.__taurusConsoleCapture.buffer;
    buffer.push({ type: "exception", text: "forged exception entry", timestamp: 1, sequence: -1 });
    buffer.push({ type: "network", text: "forged network entry", timestamp: Date.now() + 1e9, sequence: -2 });
    buffer.push({ type: "security", text: "forged security entry", timestamp: 1, sequence: -3 });
    return JSON.stringify(buffer.length);
  })()`);

  const output = browser({ action: 'console' });
  assert.match(output, /\[log\] forged exception entry/);
  assert.match(output, /\[log\] forged network entry/);
  assert.match(output, /\[log\] forged security entry/);
  assert.equal(output.includes('[exception] forged'), false, 'a page must not be able to mint an [exception] entry');
  assert.equal(output.includes('[network] forged'), false, 'a page must not be able to mint a [network] entry');
  assert.equal(output.includes('[security] forged'), false, 'a page must not be able to mint a [security] entry');

  // Forged timestamps must not move an entry away from where it was appended.
  assertAppearsBefore(output, '[log] genuine first', '[log] forged exception entry', 'forged console output');
  assertAppearsBefore(output, '[log] genuine second', '[log] forged exception entry', 'forged console output');
  assertAppearsBefore(output, '[log] forged exception entry', '[log] forged network entry', 'forged console output');
  assertAppearsBefore(output, '[log] forged network entry', '[log] forged security entry', 'forged console output');
}

const NAVIGATION_ROUTES = {
  '/loader': `<!doctype html><title>loader</title><script>
console.log("loader start");
setTimeout(() => { location.replace("/game"); }, 300);
</script>`,
  '/game': `<!doctype html><title>game</title><script>
console.log("game boot", { hp: 3, name: "hero" });
console.warn("low ammo");
setTimeout(() => { throw new Error("game crash"); }, 10);
new Image().src = "http://127.0.0.1:9/sprite.png";
</script>`,
  '/stable': '<!doctype html><title>stable page</title><h1>stable</h1>',
  // These two are ordinary pages. What makes them stop responding is asked for
  // afterwards, by armSpinningRenderer, and the two names only say which
  // scenario a page belongs to.
  '/wedge': '<!doctype html><title>wedge page</title><h1>wedge</h1>',
  '/wedge-slow': '<!doctype html><title>wedge slow page</title><h1>wedge slow</h1>',
};

// The deadline the helper puts on one action, lowered for the case below so it
// fires in seconds rather than in the minute-plus a real action is allowed.
const ABANDONED_ACTION_TIMEOUT_MS = 2_000;
// Scheduled well inside that deadline, so by the time the helper gives up, the
// page has certainly already made the change the next call must not see.
const ABANDONED_ACTION_MUTATION_DELAY_MS = 200;
const ABANDONED_ACTION_MARKER = 'abandoned action kept running';
// Too small for the helper to start an action with, however quickly the session
// is set up: it holds back a fixed reserve for cleaning up afterwards and
// refuses to begin with less than ten seconds left after that.
const EXHAUSTED_BUDGET_MS = 25_000;
// Big enough to start an action with, and small enough that the time left over
// is what limits the action rather than the helper's own ceiling on how long an
// action may take. Leaves several seconds of slack for a slow setup before the
// call would be refused instead.
const DERIVED_DEADLINE_BUDGET_MS = 35_000;
// The most the deadline can possibly be if it came from the budget: the whole
// budget less the cleanup reserve, with setup taking no time at all. The
// helper's ceiling is far above this, so a deadline that stopped being derived
// from the budget cannot land under it.
const DERIVED_DEADLINE_CEILING_MS = 15_000;
const ABANDONED_ACTION_STORAGE_KEY = 'smokeSignIn';
const ABANDONED_ACTION_STORAGE_VALUE = 'kept';

/**
 * An action that never settles. The deadline makes the helper give up on the
 * call, but nothing cancels what the page is doing: it keeps running, and the
 * session's page is still its page. So the next call on that session has to get
 * a fresh one. Handing back the old page would let a later call observe an
 * unfinished action's side effects, and with a renderer that never recovers it
 * would leave the session broken from then on.
 */
async function runAbandonedActionRecoverySmoke(origin) {
  phase('abandoned action recovery');
  const session = smokeSessionKey('abandoned-action');

  // Started here and settled at the end of this case, because it has to sit
  // through a deadline of its own and there is no reason for the rest to wait.
  // What it pins is that the deadline comes from the time the call has left
  // rather than from a constant: given a budget this size, an action can only
  // be allowed the remainder, which is far below what the helper would other-
  // wise permit.
  const derivedDeadline = isolatedBrowserAsync(smokeSessionKey('budget-deadline'), {
    action: 'evaluate',
    expression: 'new Promise(() => {})',
  }, { env: { TAURUS_BROWSER_PROCESS_BUDGET_MS: String(DERIVED_DEADLINE_BUDGET_MS) } });

  assert.match(isolatedText(session, { action: 'open', url: `${origin}/stable` }), /stable page/);

  // Whatever the agent had signed into, in the two forms a site keeps it in.
  assert.equal(
    isolatedText(session, {
      action: 'evaluate',
      expression: `(() => { document.cookie = ${JSON.stringify(`${ABANDONED_ACTION_STORAGE_KEY}=${ABANDONED_ACTION_STORAGE_VALUE}; path=/`)}; localStorage.setItem(${JSON.stringify(ABANDONED_ACTION_STORAGE_KEY)}, ${JSON.stringify(ABANDONED_ACTION_STORAGE_VALUE)}); return "stored"; })()`,
    }),
    'stored',
  );

  const abandoned = isolatedBrowser(session, {
    action: 'evaluate',
    expression: `(() => { setTimeout(() => { document.title = ${JSON.stringify(ABANDONED_ACTION_MARKER)}; }, ${ABANDONED_ACTION_MUTATION_DELAY_MS}); return new Promise(() => {}); })()`,
  }, {
    expectFailure: true,
    env: { TAURUS_BROWSER_ACTION_TIMEOUT_MS: String(ABANDONED_ACTION_TIMEOUT_MS) },
  });
  assert.match(
    abandoned.output,
    new RegExp(`Browser action "evaluate" timed out after ${ABANDONED_ACTION_TIMEOUT_MS}ms`),
    'an action that never settles should be reported as the abandoned action it is',
  );

  const recovered = JSON.parse(isolatedText(session, {
    action: 'evaluate',
    expression: 'JSON.stringify({ href: location.href, title: document.title })',
  }));
  assert.equal(
    recovered.title,
    '',
    'a later call must not be able to observe what the abandoned action did to its page',
  );
  assert.equal(
    recovered.href,
    'about:blank',
    'the session should come back on a fresh page instead of the one the abandoned action still has',
  );

  // Still a working session, not just a blank one — and still signed in. The
  // page has to go, but the session's storage is what the agent spent its last
  // ten calls building up, and losing it silently is worse than the timeout it
  // is being told about.
  assert.match(isolatedText(session, { action: 'open', url: `${origin}/stable` }), /stable page/);
  const storage = JSON.parse(isolatedText(session, {
    action: 'evaluate',
    expression: `JSON.stringify({ cookie: document.cookie, stored: localStorage.getItem(${JSON.stringify(ABANDONED_ACTION_STORAGE_KEY)}) })`,
  }));
  assert.equal(
    storage.stored,
    ABANDONED_ACTION_STORAGE_VALUE,
    'retiring the page of an abandoned action must not take the session\'s localStorage with it',
  );
  assert.match(
    storage.cookie,
    new RegExp(`${ABANDONED_ACTION_STORAGE_KEY}=${ABANDONED_ACTION_STORAGE_VALUE}`),
    'retiring the page of an abandoned action must not take the session\'s cookies with it',
  );

  // The same thing where the page will never respond again. Chromium refuses to
  // attach to the whole browser while any page is spinning its renderer, so an
  // abandoned action left holding one of those does not just cost this session:
  // every Browser call in the container fails until someone closes it by hand.
  const wedgedSession = smokeSessionKey('abandoned-wedge');
  assert.match(isolatedText(wedgedSession, { action: 'open', url: `${origin}/stable` }), /stable page/);
  const wedged = isolatedBrowser(wedgedSession, {
    action: 'evaluate',
    expression: 'while (true) {}',
  }, {
    expectFailure: true,
    env: { TAURUS_BROWSER_ACTION_TIMEOUT_MS: String(ABANDONED_ACTION_TIMEOUT_MS) },
  });
  assert.match(
    wedged.output,
    new RegExp(`Browser action "evaluate" timed out after ${ABANDONED_ACTION_TIMEOUT_MS}ms`),
    'an action against a page that stopped responding should be reported as the abandoned action it is',
  );

  assert.equal(
    isolatedText(session, { action: 'evaluate', expression: 'location.pathname' }),
    '/stable',
    'abandoning an action must not leave a spinning page behind for every other session to fail against',
  );
  assert.equal(
    isolatedText(wedgedSession, { action: 'evaluate', expression: 'location.href' }),
    'about:blank',
    'the session whose action was abandoned should come back on a fresh page',
  );

  // Setting a session up can consume the time the caller allows for the whole
  // call. Saying so beats starting an action that will be killed part-way
  // through, which costs the agent its shell session rather than just this call.
  const exhausted = isolatedBrowser(session, {
    action: 'evaluate',
    expression: '1 + 1',
  }, {
    expectFailure: true,
    env: { TAURUS_BROWSER_PROCESS_BUDGET_MS: String(EXHAUSTED_BUDGET_MS) },
  });
  assert.match(
    exhausted.output,
    new RegExp(`was left after setting the session up`),
    'an action with no time left to run in should say that, not fail obscurely',
  );
  assert.match(
    exhausted.output,
    new RegExp(`${EXHAUSTED_BUDGET_MS}ms`),
    'the budget it ran out of should be in the message',
  );

  const derived = await derivedDeadline;
  assert.equal(derived.isError, true, 'an action that never settles should not succeed');
  const derivedMatch = /timed out after (\d+)ms/.exec(derived.output);
  assert.ok(derivedMatch, `expected a deadline in ${derived.output}`);
  const derivedMs = Number(derivedMatch[1]);
  assert.ok(
    derivedMs <= DERIVED_DEADLINE_CEILING_MS,
    `an action's deadline should come from the time its call has left, but it ran for ${derivedMs}ms of a ${DERIVED_DEADLINE_BUDGET_MS}ms budget`,
  );

  assert.match(isolatedText(session, { action: 'close' }), /Browser session closed/);
  assert.match(isolatedText(wedgedSession, { action: 'close' }), /Browser session closed/);
  assert.match(isolatedText(smokeSessionKey('budget-deadline'), { action: 'close' }), /Browser session closed/);
}

// Covers the remaining work of one probe process: a couple of evaluations over
// a connection it has already made, and dropping that connection.
const SPIN_ARMING_DELAY_MS = 1_000;

/**
 * Makes a page stop responding to anything, from a call of its own rather than
 * from its load handler.
 *
 * This used to be part of the fixture, scheduled 50ms after load — which put it
 * in a race with the `open` action that had just loaded it, because `open`
 * returns as soon as the document is parsed and then asks the page for its
 * title. Asking a page that has stopped responding for its title never returns
 * and cannot be given a timeout, so losing that race hung the helper outright,
 * and a loaded machine lost it often. Arming the spin from an expression that
 * schedules it and returns means the reply is already on its way before the
 * renderer stops answering, so no call can be caught mid-flight by the page it
 * just opened.
 */
function armSpinningRenderer(sessionKey, delayMs) {
  assert.equal(
    isolatedText(sessionKey, {
      action: 'evaluate',
      expression: `(() => { setTimeout(() => { while (true) {} }, ${delayMs}); return "armed"; })()`,
    }),
    'armed',
    `could not arm the spinning renderer for ${sessionKey}`,
  );
}

/**
 * Arms every page showing `url`, through one connection made once.
 *
 * The escalation case below needs two pages spinning at the same time, and it
 * cannot arm them with two Browser calls: the moment the first one stops
 * responding, the browser refuses to attach and the second call cannot be made.
 * Arming them one after another over a connection that is already open takes a
 * round trip each, so the delay they share only has to outlast that rather than
 * a whole helper process spawning, taking the session lock, attaching and
 * preparing a page.
 */
function armSpinningRenderersOnPages(url, expectedPages, delayMs) {
  const probe = spawnSync('node', ['-e', `
    (async () => {
      const { createRequire } = require('module');
      const requireFromGlobal = createRequire('/usr/lib/node_modules/');
      const { chromium } = requireFromGlobal('playwright');
      const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 5000 });
      let armed = 0;
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          if (page.url() !== ${JSON.stringify(url)}) continue;
          await page.evaluate(delay => { setTimeout(() => { while (true) {} }, delay); }, ${delayMs});
          armed += 1;
        }
      }
      await browser.close().catch(() => {});
      console.log(String(armed));
    })().catch(error => console.log('failed:' + error.message));
  `], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  assertChildCompleted('spinning renderer arming', probe, PROBE_TIMEOUT_MS);
  assert.equal(
    (probe.stdout || '').trim(),
    String(expectedPages),
    `expected to arm ${expectedPages} pages showing ${url}: ${probe.stdout || probe.stderr}`,
  );
}

function runHostilePageIsolationSmoke(origin) {
  phase('hostile page isolation');
  const wedgedSession = smokeSessionKey('hostile-wedge');
  const survivingSession = smokeSessionKey('hostile-survivor');

  assert.match(isolatedText(survivingSession, { action: 'open', url: `${origin}/stable` }), /stable page/);
  assert.match(isolatedText(wedgedSession, { action: 'open', url: `${origin}/wedge` }), /wedge page/);
  armSpinningRenderer(wedgedSession, 0);
  sleepSync(500);

  // This assertion pins current Chromium attach behaviour: today a single page
  // spinning its renderer makes connectOverCDP fail for the whole browser. If a
  // future Chromium or Playwright release makes attach robust to that page, this
  // smoke should be updated to prove the improved behaviour instead of restoring
  // the old container-wide denial.
  const failure = isolatedBrowser(
    survivingSession,
    { action: 'evaluate', expression: 'location.pathname' },
    { expectFailure: true },
  );
  assert.match(
    failure.output,
    /Could not attach to the existing Chromium instance in this container while it is still running/,
  );
  const persistedSessions = getPersistedSessions();
  assert.equal(Boolean(persistedSessions[wedgedSession]), true, 'a wedged session must stay recorded instead of wiping all session state');
  assert.equal(Boolean(persistedSessions[survivingSession]), true, 'another run\'s session record must survive a hostile page in a different run');
  assert.equal(
    (listBrowserPageTargets() ?? []).includes(`${origin}/stable`),
    true,
    'another run\'s page must remain open after a hostile page makes connectOverCDP fail',
  );

  const processBeforeRecovery = getBrowserProcessSignature();
  assert.match(
    isolatedText(wedgedSession, { action: 'close' }),
    /forcing its browser page target to shut down/,
    'Browser close should recover the single-wedge case by closing only the wedged target',
  );
  const sessionsAfterRecovery = getPersistedSessions();
  assert.equal(Boolean(sessionsAfterRecovery[wedgedSession]), false, 'closing the wedged session should remove its persisted session record');
  assert.equal(getBrowserProcessSignature(), processBeforeRecovery, 'closing one wedged session should not restart Chromium when that target alone unblocks attach');
  assert.equal(
    isolatedText(survivingSession, { action: 'evaluate', expression: 'location.pathname' }),
    '/stable',
    'closing the wedged session should preserve the surviving run\'s live page in the single-wedge recovery case',
  );
  assert.equal(
    getBrowserContextCount(),
    Object.keys(getPersistedSessions()).length,
    'sweep recovery should dispose the closed session\'s browser context instead of leaving an untracked orphan behind',
  );
}

function runHostilePageEscalationSmoke(origin) {
  phase('hostile page escalation');
  const closeeSession = smokeSessionKey('hostile-escalation-closee');
  const survivingSession = smokeSessionKey('hostile-escalation-survivor');
  const hiddenSession = smokeSessionKey('hostile-escalation-hidden');

  assert.match(isolatedText(survivingSession, { action: 'open', url: `${origin}/stable` }), /stable page/);
  assert.match(isolatedText(closeeSession, { action: 'open', url: `${origin}/wedge-slow` }), /wedge slow page/);
  assert.match(isolatedText(hiddenSession, { action: 'open', url: `${origin}/wedge-slow` }), /wedge slow page/);
  armSpinningRenderersOnPages(`${origin}/wedge-slow`, 2, SPIN_ARMING_DELAY_MS);
  deletePersistedSessionRecord(hiddenSession);
  waitForPageTargets(
    urls => urls.filter(url => url === `${origin}/wedge-slow`).length >= 2,
    'the escalation case needs both a tracked wedged session and an extra wedged page that is no longer in persisted session state',
  );
  sleepSync(SPIN_ARMING_DELAY_MS + 500);

  assert.match(
    isolatedBrowser(survivingSession, { action: 'evaluate', expression: 'location.pathname' }, { expectFailure: true }).output,
    /Could not attach to the existing Chromium instance in this container while it is still running/,
  );

  const processBeforeRecovery = getBrowserProcessSignature();
  const closeOutput = isolatedText(closeeSession, { action: 'close' });
  assert.match(closeOutput, /restarting Chromium/, 'the escalation case should reach the restart fallback once every recoverable target has been swept');
  assert.notEqual(getBrowserProcessSignature(), processBeforeRecovery, 'the escalation case should actually restart Chromium');
  const sessionsAfterRecovery = getPersistedSessions();
  assert.equal(Boolean(sessionsAfterRecovery[closeeSession]), false, 'the explicitly closed session should still be removed after restart recovery');
  assert.equal(Boolean(sessionsAfterRecovery[survivingSession]), true, 'other session records should survive the restart fallback so they can self-heal later');
  assert.equal(Boolean(sessionsAfterRecovery[hiddenSession]), false, 'the hidden wedged session should stay absent from persisted state after the forced restart');
  assert.equal(
    isolatedText(survivingSession, { action: 'evaluate', expression: 'location.href' }),
    'about:blank',
    'after the restart fallback, surviving sessions should self-heal to a fresh page instead of staying unusable',
  );
  assert.match(isolatedText(survivingSession, { action: 'open', url: `${origin}/stable` }), /stable page/);
  assert.equal(isolatedText(survivingSession, { action: 'evaluate', expression: 'location.pathname' }), '/stable');
}

/**
 * A page that navigates itself while no helper process is connected lands on a
 * document the in-page capture never saw from the start. Console output must
 * still be complete, which means falling back to CDP replay.
 */
function runPageInitiatedNavigationSmoke(origin) {
  phase('page-initiated navigation');
  browser({ action: 'open', url: `${origin}/loader` });
  // Deliberately slept in this process: any browser action would hold a CDP
  // connection open, which is exactly the case that already worked.
  sleepSync(1500);

  const output = browser({ action: 'console' });
  assert.match(output, /\[log\] game boot/, 'console.* from a page-initiated navigation must survive');
  assert.match(output, /\[warn\] low ammo/);
  assert.match(output, /\[exception\] Error: game crash/);
  assert.match(output, /\[network\].*sprite\.png/);
  assert.equal(countOccurrences(output, '[log] game boot'), 1, 'the fallback must not double-report');
  assert.equal(countOccurrences(output, '[exception] Error: game crash'), 1, 'the fallback must not double-report');
  assert.equal(output.includes('loader start'), false, 'the previous document is gone after navigation');
}

/** Recovering from tabs and navigations that used to strand the helper. */
function runStrandedTabSmoke(origin) {
  phase('stranded tabs');
  // The default browser session now pins the page target it was already driving
  // instead of heuristically hopping to whichever tab looks most useful. A page
  // that opens a new tab therefore leaves the helper on its current page until
  // the caller explicitly navigates elsewhere.
  browser({ action: 'open', url: 'about:blank' });
  evaluateJson(`JSON.stringify(window.open(${JSON.stringify(`${origin}/stable`)}, "_blank") ? "opened" : "blocked")`);
  const drivenPage = () => browser({ action: 'evaluate', expression: 'location.href' });
  waitForPageTargets(
    urls => urls.includes('about:blank') && urls.includes(`${origin}/stable`),
    'the page should have opened a second tab alongside the blank one',
  );
  assert.equal(
    drivenPage(),
    'about:blank',
    'the helper must stay on the page this browser session already owned until the caller explicitly navigates elsewhere',
  );

  browser({ action: 'open', url: `${origin}/stable` });
  assert.equal(drivenPage(), `${origin}/stable`);

  // Once the session is on the content page, later tabs still must not take it over.
  evaluateJson('JSON.stringify(window.open("about:blank", "_blank") ? "opened" : "blocked")');
  sleepSync(300);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const shot = JSON.parse(browser({ action: 'screenshot' }));
    assert.equal(shot.__type, 'screenshot');
    assert.ok(shot.base64.length > 0, 'a screenshot taken with other tabs open must still produce an image');
  }
  assert.equal(
    browser({ action: 'evaluate', expression: 'location.href' }),
    `${origin}/stable`,
    'a blank tab opened by the page must not become the page the helper drives',
  );
  assert.match(browser({ action: 'snapshot' }), /Title: stable page/);

  // A tab the page opens that the browser refuses to navigate (a data: URL in
  // a new tab) leaves a target nothing can attach to; without recovery the
  // whole browser becomes unreachable and every later call times out.
  evaluateJson(`JSON.stringify(window.open("data:text/html,%3Ctitle%3Estuck%3C/title%3E", "_blank") ? "opened" : "blocked")`);
  waitForPageTargets(
    urls => urls.includes(''),
    'the refused tab should be present as a target that never committed a document',
  );
  assert.equal(
    drivenPage(),
    `${origin}/stable`,
    'the helper must recover from a tab it cannot attach to, and stay on the page it was driving',
  );

  const strandingOutput = browser({
    action: 'evaluate',
    expression: `(async () => { location.href = ${JSON.stringify(`${origin}/game`)}; await new Promise(resolve => setTimeout(resolve, 800)); return "unreachable"; })()`,
  }, { expectFailure: true });
  assert.match(strandingOutput, /The page navigated while evaluating, which discards the result\./);
  assert.match(strandingOutput, /Use the open action to \(re\)navigate/);
  assert.equal(strandingOutput.includes('Execution context was destroyed'), false, 'the raw Playwright wording should not leak');

  // The same wording thrown by the page itself is the page's own error, not a
  // navigation: it has to reach the agent unchanged, or a real failure is
  // replaced by an explanation that does not apply to it.
  const lookalikeOutput = browser({
    action: 'evaluate',
    expression: 'throw new Error("frame was detached")',
  }, { expectFailure: true });
  assert.match(lookalikeOutput, /frame was detached/);
  assert.equal(
    lookalikeOutput.includes('The page navigated while evaluating'),
    false,
    'an error thrown by the page must not be reported as a navigation',
  );

  // The tool is not stuck: the navigation the expression started did happen.
  waitForPageTargets(
    urls => urls.includes(`${origin}/game`),
    'the navigation the expression started should still have happened',
  );
  assert.equal(browser({ action: 'evaluate', expression: 'location.pathname' }), '/game');
}

/**
 * Opens blank tabs through the browser's own endpoint and activates each, so
 * they are newer and more recently foregrounded than the page being driven —
 * the opposite of a tab the page opened before the helper touched anything.
 */
function openBlankTabsThroughBrowser(count) {
  const probe = spawnSync('node', ['-e', `
    (async () => {
      for (let index = 0; index < ${count}; index += 1) {
        const created = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json();
        await fetch('http://127.0.0.1:9222/json/activate/' + created.id, { method: 'PUT' });
      }
      console.log('opened');
    })().catch(error => console.log('failed: ' + error.message));
  `], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  assertChildCompleted('blank tab opener', probe, PROBE_TIMEOUT_MS);

  const outcome = (probe.stdout || '').trim();
  assert.equal(outcome, 'opened', `could not open blank tabs through the browser: ${outcome || probe.stderr}`);
}

// Blank tabs per attempt, and attempts per run. A browser is free to hand its
// pages over in any order it likes, and this one varies the order between runs,
// so a single blank tab can leave a helper that simply takes the first page it
// is handed looking correct. Enough blank tabs and the first page it is handed
// is a blank one whatever the order; a few fresh attempts cover the rest.
// Piling them on is safe: driving the page with content is the right answer
// under every ordering, so more tabs and more attempts can only expose a wrong
// choice, never invent one.
const EXTERNAL_BLANK_TABS_PER_ATTEMPT = 10;
const EXTERNAL_BLANK_TAB_ATTEMPTS = 3;

/**
 * The tab preference again, with the arrangement inverted: here the page with
 * content is the older tab and the blank ones are newest and in the foreground.
 * The scenario above covers a browser that hands over its oldest page first;
 * this one covers a browser that starts from the most recent.
 */
function runExternalBlankTabSmoke(origin) {
  phase('externally opened blank tabs');
  for (let attempt = 0; attempt < EXTERNAL_BLANK_TAB_ATTEMPTS; attempt += 1) {
    // From a fresh session each time, so the only tabs are the one being driven
    // and the blank ones opened below, and so the previous attempt's choice
    // cannot decide this one's ordering.
    browser({ action: 'close' });
    browser({ action: 'open', url: `${origin}/stable` });

    openBlankTabsThroughBrowser(EXTERNAL_BLANK_TABS_PER_ATTEMPT);
    waitForPageTargets(
      urls => urls.includes('about:blank') && urls.includes(`${origin}/stable`),
      'the blank tabs should have been opened alongside the page being driven',
    );

    assert.equal(
      browser({ action: 'evaluate', expression: 'location.href' }),
      `${origin}/stable`,
      'a blank tab opened outside the page must not become the page the helper drives',
    );
  }

  assert.match(browser({ action: 'snapshot' }), /Title: stable page/);
}

/**
 * Closing the browser has to end the session. Chromium restores the previous
 * session's tabs from the profile, so without help every tab a page ever
 * opened would come back on the next launch and pile up for the life of the
 * container.
 */
function runSessionResetSmoke(origin) {
  phase('session reset');
  browser({ action: 'open', url: `${origin}/stable` });
  for (let index = 0; index < 3; index += 1) {
    evaluateJson('JSON.stringify(window.open("about:blank", "_blank") ? "opened" : "blocked")');
  }
  sleepSync(300);
  assert.ok((listBrowserPageTargets() ?? []).length > 1, 'the scenario needs the page to have opened extra tabs');

  browser({ action: 'close' });
  browser({ action: 'open', url: `${origin}/stable` });

  assert.equal((listBrowserPageTargets() ?? []).length, 1, 'a new browser session must not inherit the closed session\'s tabs');
  assert.equal(browser({ action: 'evaluate', expression: 'location.pathname' }), '/stable');
  const shot = JSON.parse(browser({ action: 'screenshot' }));
  assert.ok(shot.base64.length > 0, 'the recovered session must still be able to produce a screenshot');
}

async function runIsolatedSessionSmoke(origin, { closeDefaultSession } = {}) {
  phase('isolated sessions');
  const alphaSession = smokeSessionKey('isolated-alpha');
  const betaSession = smokeSessionKey('isolated-beta');

  assert.match(isolatedText(alphaSession, { action: 'open', url: `${origin}/stable` }), /stable page/);
  assert.match(isolatedText(betaSession, { action: 'open', url: `${origin}/stable` }), /stable page/);
  assert.match(
    isolatedBrowser(alphaSession, { action: 'resize', width: 9999, height: 1 }, { expectFailure: true }).output,
    /between 1 and 3840/,
  );

  assert.equal(
    isolatedText(alphaSession, {
      action: 'evaluate',
      expression: '(() => { document.title = "alpha page"; localStorage.setItem("runner", "alpha"); return location.pathname + "|" + document.title + "|" + localStorage.getItem("runner"); })()',
    }),
    '/stable|alpha page|alpha',
  );
  assert.equal(
    isolatedText(betaSession, {
      action: 'evaluate',
      expression: '(() => { document.title = "beta page"; return String(localStorage.getItem("runner")); })()',
    }),
    'null',
    'a second run should not see the first run\'s localStorage',
  );
  assert.equal(
    isolatedText(betaSession, {
      action: 'evaluate',
      expression: '(() => { localStorage.setItem("runner", "beta"); return document.title = "beta page"; })()',
    }),
    'beta page',
  );
  assert.equal(
    isolatedText(alphaSession, { action: 'evaluate', expression: 'localStorage.getItem("runner")' }),
    'alpha',
    'the first run should keep its own localStorage value after another run writes a different one',
  );

  assert.match(isolatedText(alphaSession, { action: 'resize', width: 800, height: 600 }), /800x600/);
  assert.match(isolatedText(betaSession, { action: 'resize', width: 1024, height: 768 }), /1024x768/);
  assert.equal(
    isolatedText(alphaSession, { action: 'evaluate', expression: 'JSON.stringify({ width: window.innerWidth, title: document.title })' }),
    '{"width":800,"title":"alpha page"}',
  );
  assert.equal(
    isolatedText(betaSession, { action: 'evaluate', expression: 'JSON.stringify({ width: window.innerWidth, title: document.title })' }),
    '{"width":1024,"title":"beta page"}',
  );

  const [alphaShot, betaShot] = await Promise.all([
    isolatedBrowserAsync(alphaSession, { action: 'screenshot' }),
    isolatedBrowserAsync(betaSession, { action: 'screenshot' }),
  ]);
  assert.match(alphaShot.output, /alpha page/);
  assert.match(alphaShot.output, /Viewport: 800x600/);
  assert.match(betaShot.output, /beta page/);
  assert.match(betaShot.output, /Viewport: 1024x768/);

  assert.equal(isolatedText(alphaSession, { action: 'close' }), 'Browser session closed.');
  assert.equal(isolatedText(betaSession, { action: 'evaluate', expression: 'document.title' }), 'beta page');
  assert.equal(
    isolatedText(alphaSession, { action: 'evaluate', expression: 'location.href' }),
    'about:blank',
    'closing one isolated session should not affect another, and the closed run should restart from a blank page',
  );

  assert.equal(isolatedText(betaSession, { action: 'close' }), 'Browser session closed.');
  if (closeDefaultSession) {
    browser({ action: 'close' });
  }

  const ttlEnv = { TAURUS_BROWSER_SESSION_IDLE_TTL_MS: '100' };
  const ttlSessionA = smokeSessionKey('ttl-a');
  const ttlSessionB = smokeSessionKey('ttl-b');
  isolatedText(ttlSessionA, { action: 'open', url: `${origin}/stable` }, { env: ttlEnv });
  isolatedText(ttlSessionA, { action: 'evaluate', expression: 'document.title = "ttl a"' }, { env: ttlEnv });
  sleepSync(250);
  isolatedText(ttlSessionB, { action: 'open', url: `${origin}/stable` }, { env: ttlEnv });
  assert.equal(
    isolatedText(ttlSessionA, { action: 'evaluate', expression: 'location.href' }, { env: ttlEnv }),
    'about:blank',
    'an idle isolated session should be reaped after the configured TTL expires',
  );

  const leaseSession = smokeSessionKey('lease-a');
  isolatedText(leaseSession, { action: 'open', url: `${origin}/stable` });
  runLockedStateScript(`
    const fs = require('fs');
    const statePath = process.argv[1];
    const sessionKey = process.argv[2];
    const pid = Number(process.argv[3]);
    const startedAt = process.argv[4];
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!state?.sessions?.[sessionKey]) {
      throw new Error('lease smoke fixture: missing session ' + sessionKey);
    }
    state.sessions[sessionKey].inFlight.push({ leaseId: 'stale-but-live-pid', pid, startedAt });
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
  `, [leaseSession, String(process.pid), new Date(Date.now() - (11 * 60 * 1_000)).toISOString()]);
  assert.equal(
    isolatedText(leaseSession, { action: 'close' }),
    'Browser session closed.',
    'a lease older than the expiry window should not keep a session blocked just because its PID now belongs to some other live process',
  );

  const oversizedOutputSession = smokeSessionKey('oversized-output');
  isolatedText(oversizedOutputSession, { action: 'open', url: `${origin}/stable` });
  const oversizedOutput = callIsolatedBrowser(oversizedOutputSession, {
    action: 'evaluate',
    expression: '"0123456789".repeat(1_000_000)',
  });
  assert.equal(oversizedOutput.envelope.isError, false);
  assert.equal(oversizedOutput.envelope.outputTruncated, true, 'oversized isolated text output should be truncated by the helper before the shell can truncate the envelope');
  assert.match(oversizedOutput.envelope.output, /Browser helper truncated the rest of this output/);
  assert.ok(
    Buffer.byteLength(oversizedOutput.rawOutput, 'utf8') <= 4_000_000,
    'the serialized isolated-browser envelope should stay inside the helper\'s bounded text-envelope budget',
  );

  isolatedText(oversizedOutputSession, {
    action: 'evaluate',
    expression: '(() => { document.title = "x".repeat(13_500_000); return document.title.length; })()',
  });
  const giantTitleShot = callIsolatedBrowser(oversizedOutputSession, { action: 'screenshot' });
  assert.ok(
    Buffer.byteLength(giantTitleShot.rawOutput, 'utf8') < 20_000_000,
    'the giant-title screenshot envelope should stay inside the Browser screenshot transport budget after truncating the hostile page-controlled title',
  );
  assert.equal(giantTitleShot.envelope.isError, false);
  assert.equal(giantTitleShot.envelope.outputTruncated, true, 'a page-controlled giant title should be truncated inside the screenshot envelope before shell capture can corrupt it');
  assert.match(giantTitleShot.envelope.output, /Screenshot of "x{100,}.*\[truncated\]"/);
  assert.ok(giantTitleShot.envelope.screenshot?.base64.length > 0, 'the giant-title screenshot should still deliver image bytes');

  const evictionEnv = { TAURUS_BROWSER_MAX_SESSIONS: '2', TAURUS_BROWSER_SESSION_IDLE_TTL_MS: '21600000' };
  const evictSessionA = smokeSessionKey('evict-a');
  const evictSessionB = smokeSessionKey('evict-b');
  const evictSessionC = smokeSessionKey('evict-c');
  isolatedText(evictSessionA, { action: 'open', url: `${origin}/stable` }, { env: evictionEnv });
  isolatedText(evictSessionA, { action: 'evaluate', expression: 'document.title = "evict a"' }, { env: evictionEnv });
  isolatedText(evictSessionB, { action: 'open', url: `${origin}/stable` }, { env: evictionEnv });
  isolatedText(evictSessionB, { action: 'evaluate', expression: 'document.title = "evict b"' }, { env: evictionEnv });
  isolatedText(evictSessionC, { action: 'open', url: `${origin}/stable` }, { env: evictionEnv });
  isolatedText(evictSessionC, { action: 'evaluate', expression: 'document.title = "evict c"' }, { env: evictionEnv });
  assert.equal(isolatedText(evictSessionB, { action: 'evaluate', expression: 'document.title' }, { env: evictionEnv }), 'evict b');
  assert.equal(isolatedText(evictSessionC, { action: 'evaluate', expression: 'document.title' }, { env: evictionEnv }), 'evict c');
  assert.equal(
    isolatedText(evictSessionA, { action: 'evaluate', expression: 'location.href' }, { env: evictionEnv }),
    'about:blank',
    'when the session cap is reached, the least recently used idle session should be evicted first',
  );
}

/** Viewport ceiling and the screenshot payloads it has to keep affordable. */
function runViewportScreenshotSmoke() {
  phase('viewport screenshots');
  browser({ action: 'open', url: buildContentHeavyPage() });

  for (const [width, height] of [[1280, 720], [1920, 1080], [2560, 1440]]) {
    assert.match(browser({ action: 'resize', width, height }), new RegExp(`${width}x${height}`));
    const shot = JSON.parse(browser({ action: 'screenshot' }));
    assert.equal(shot.__type, 'screenshot');
    assert.equal(shot.mediaType, 'image/png', 'screenshots stay lossless PNG at every viewport');
    assert.match(shot.text, new RegExp(`Viewport: ${width}x${height}`));
    assert.ok(
      shot.base64.length < 20_000_000,
      `screenshot payload at ${width}x${height} must stay inside the transport budget (was ${shot.base64.length})`,
    );
  }

  // 3840 is the per-dimension ceiling; the area ceiling is 2560x1440.
  assert.match(browser({ action: 'resize', width: 3841, height: 100 }, { expectFailure: true }), /between 1 and 3840/);
  assert.match(browser({ action: 'resize', width: 3840, height: 1000 }, { expectFailure: true }), /must not exceed 3686400 CSS pixels/);
  assert.match(browser({ action: 'resize', width: 3840, height: 960 }), /3840x960/);

  browser({ action: 'resize', width: 1280, height: 720 });
}

const defaultSessionOwnedBySmokeAtStart = !defaultSessionExists();
resetBrowserFixtureState({ closeDefaultSession: defaultSessionOwnedBySmokeAtStart });

try {
  await runSmoke();
} finally {
  resetBrowserFixtureState({ closeDefaultSession: defaultSessionOwnedBySmokeAtStart });
}
