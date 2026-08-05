#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';

const BROWSER_CLI_PATH = process.env.BROWSER_CLI_PATH || '/usr/local/lib/browser-cli.mjs';
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const NEXT_LINE = String.fromCharCode(0x85);

// Screenshots at the largest supported viewport are several megabytes of
// base64, well past spawnSync's 1MB default, which would otherwise kill the
// helper mid-write and look like a helper failure.
const MAX_HELPER_OUTPUT_BYTES = 32 * 1024 * 1024;

function browser(input, { expectFailure = false } = {}) {
  const result = spawnSync('node', [BROWSER_CLI_PATH, JSON.stringify(input)], {
    encoding: 'utf8',
    maxBuffer: MAX_HELPER_OUTPUT_BYTES,
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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

/**
 * Polls `produce` until it returns `expected`, then returns whatever it last
 * produced. Used where the browser needs a moment to reach a state (a new tab
 * committing its first document, say) — a helper that never reaches it simply
 * fails the assertion after the deadline, so this cannot hide a regression.
 */
function waitForValue(produce, expected, { timeoutMs = 5_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = produce();
  while (latest !== expected && Date.now() < deadline) {
    sleepSync(intervalMs);
    latest = produce();
  }
  return latest;
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

function runSmoke() {
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

  const pageServer = startPageServer(NAVIGATION_ROUTES);
  try {
    runPageInitiatedNavigationSmoke(pageServer.origin);
    runStrandedTabSmoke(pageServer.origin);
    runSessionResetSmoke(pageServer.origin);
  } finally {
    pageServer.stop();
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
};

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
  // The tab the helper is on is blank and the page with content is a second
  // tab. Which tab a browser reports first is not guaranteed, so this
  // arrangement — blank tab first, content tab second — is the one that pins
  // the choice down: taking whichever tab comes first would stay on the blank
  // one for good.
  browser({ action: 'open', url: 'about:blank' });
  evaluateJson(`JSON.stringify(window.open(${JSON.stringify(`${origin}/stable`)}, "_blank") ? "opened" : "blocked")`);
  const drivenPage = () => browser({ action: 'evaluate', expression: 'location.href' });
  assert.equal(
    waitForValue(drivenPage, `${origin}/stable`),
    `${origin}/stable`,
    'the helper must drive the tab that has content, not the blank one it started on',
  );

  // The same preference, the other way round: a blank tab the page opens next
  // to the one being driven must not take over.
  evaluateJson('JSON.stringify(window.open("about:blank", "_blank") ? "opened" : "blocked")');
  sleepSync(300);

  // The tab the page just opened took the foreground with it, and only the
  // foregrounded tab is painted — so screenshots have to put the page they are
  // capturing back in front, or they wait for a frame that never comes.
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
  sleepSync(500);
  assert.equal(
    waitForValue(drivenPage, `${origin}/stable`),
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

  // The tool is not stuck: the navigation the expression started did happen.
  assert.equal(
    waitForValue(() => browser({ action: 'evaluate', expression: 'location.pathname' }), '/game'),
    '/game',
    'the navigation the expression started should still have happened',
  );
}

/**
 * How many pages the browser is holding, asked of the browser itself: the
 * helper only ever exposes the one page it drives, so leftover tabs are
 * invisible from the actions alone.
 */
function countBrowserPageTargets() {
  const probe = spawnSync('node', ['-e', `
    fetch('http://127.0.0.1:9222/json/list')
      .then(response => response.json())
      .then(targets => console.log(targets.filter(target => target.type === 'page').length))
      .catch(() => console.log(-1));
  `], { encoding: 'utf8' });
  return Number((probe.stdout || '').trim());
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
  assert.ok(countBrowserPageTargets() > 1, 'the scenario needs the page to have opened extra tabs');

  browser({ action: 'close' });
  browser({ action: 'open', url: `${origin}/stable` });

  assert.equal(countBrowserPageTargets(), 1, 'a new browser session must not inherit the closed session\'s tabs');
  assert.equal(browser({ action: 'evaluate', expression: 'location.pathname' }), '/stable');
  const shot = JSON.parse(browser({ action: 'screenshot' }));
  assert.ok(shot.base64.length > 0, 'the recovered session must still be able to produce a screenshot');
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

try {
  runSmoke();
} finally {
  browser({ action: 'close' });
}
