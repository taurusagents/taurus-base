#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const BROWSER_CLI_PATH = process.env.BROWSER_CLI_PATH || '/usr/local/lib/browser-cli.mjs';
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const NEXT_LINE = String.fromCharCode(0x85);

function browser(input, { expectFailure = false } = {}) {
  const result = spawnSync('node', [BROWSER_CLI_PATH, JSON.stringify(input)], {
    encoding: 'utf8',
  });

  if (expectFailure) {
    assert.notStrictEqual(result.status, 0, `Expected browser helper failure for ${JSON.stringify(input)}`);
    return `${result.stdout || ''}${result.stderr || ''}`;
  }

  if (result.status !== 0) {
    throw new Error([
      `browser-cli failed for ${JSON.stringify(input)}`,
      'stdout:',
      result.stdout,
      'stderr:',
      result.stderr,
    ].join('\n'));
  }

  return result.stdout;
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

  console.log('Base image browser smoke passed.');
}

try {
  runSmoke();
} finally {
  browser({ action: 'close' });
}
