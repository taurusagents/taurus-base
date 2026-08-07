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
  'hostile-wedge',
  'hostile-survivor',
];
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const NEXT_LINE = String.fromCharCode(0x85);

// Screenshots at the largest supported viewport are several megabytes of
// base64, well past spawnSync's 1MB default, which would otherwise kill the
// helper mid-write and look like a helper failure.
const MAX_HELPER_OUTPUT_BYTES = 32 * 1024 * 1024;

function browser(input, { expectFailure = false, env } = {}) {
  const result = spawnSync('node', [BROWSER_CLI_PATH, JSON.stringify(input)], {
    encoding: 'utf8',
    maxBuffer: MAX_HELPER_OUTPUT_BYTES,
    env: env ? { ...process.env, ...env } : process.env,
  });

  if (expectFailure) {
    assert.notStrictEqual(result.status, 0, `Expected browser helper failure for ${JSON.stringify(input)}`);
    return `${result.stdout || ''}${result.stderr || ''}`;
  }

  if (result.status !== 0) {
    // Keep failure reports readable: a failing screenshot carries megabytes.
    const excerpt = stream => `${(stream || '').slice(0, 2_000)}${(stream || '').length > 2_000 ? ' …(truncated)' : ''}`;
    throw new Error([
      `browser-cli failed for ${JSON.stringify(input)} (status ${result.status}, signal ${result.signal}, error ${result.error?.message ?? 'none'})`,
      'stdout:',
      excerpt(result.stdout),
      'stderr:',
      excerpt(result.stderr),
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
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', code => {
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
    { encoding: 'utf8', input },
  );
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
  closeBrowserTargetsMatching(/^http:\/\/127\.0\.0\.1:\d+\/wedge$/);
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
  `], { encoding: 'utf8' });
  try {
    const parsed = JSON.parse((probe.stdout || '').trim());
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
    `], { encoding: 'utf8' });
    assert.equal((closeResult.stdout || '').trim(), 'closed', `could not close browser target ${target.id} for ${target.url}`);
  }
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
    runHostilePageIsolationSmoke(pageServer.origin);
    await runIsolatedSessionSmoke(pageServer.origin, { closeDefaultSession: defaultSessionOwnedBySmoke });
  } finally {
    pageServer.stop();
    resetBrowserFixtureState({ closeDefaultSession: defaultSessionOwnedBySmoke });
  }

  console.log('Base image browser smoke passed.');
}

/** Console methods beyond log/warn/error still reach the agent. */
function runConsoleMethodSmoke() {
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
  '/wedge': '<!doctype html><title>wedge page</title><h1>wedge</h1><script>window.addEventListener("load", () => setTimeout(() => { while (true) {} }, 50));</script>',
};

function runHostilePageIsolationSmoke(origin) {
  const wedgedSession = smokeSessionKey('hostile-wedge');
  const survivingSession = smokeSessionKey('hostile-survivor');

  assert.match(isolatedText(survivingSession, { action: 'open', url: `${origin}/stable` }), /stable page/);
  assert.match(isolatedText(wedgedSession, { action: 'open', url: `${origin}/wedge` }), /wedge page/);
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

  assert.match(
    isolatedText(wedgedSession, { action: 'close' }),
    /Browser session closed/,
    'Browser close should remain a working recovery path even when attach is blocked',
  );
  const sessionsAfterRecovery = getPersistedSessions();
  assert.equal(Boolean(sessionsAfterRecovery[wedgedSession]), false, 'closing the wedged session should remove its persisted session record');

  const recoveredLocation = isolatedText(survivingSession, { action: 'evaluate', expression: 'location.pathname' });
  if (recoveredLocation === '/stable') {
    assert.equal(recoveredLocation, '/stable', 'closing the wedged session should preserve other runs when Chromium can stay alive');
    return;
  }

  assert.equal(
    recoveredLocation,
    'about:blank',
    'if recovery had to restart Chromium, the surviving run should self-heal into a fresh blank page instead of staying unusable',
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
  `], { encoding: 'utf8' });

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
