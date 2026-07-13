import { spawn } from 'node:child_process';
import fs from 'node:fs';

// Build-time smoke test for the exact runtime path Taurus uses: start the
// app-server with `--listen stdio://`, complete the JSON-RPC initialize
// handshake, then issue one lightweight request (`getAuthStatus`) to prove the
// server is actually live.
const codexBin = process.argv[2] || '/usr/bin/codex';
const codexHome = process.env.CODEX_HOME;

if (!codexHome) {
  console.error('CODEX_HOME must be set for the Codex app-server smoke test');
  process.exit(1);
}

fs.rmSync(codexHome, { recursive: true, force: true });
fs.mkdirSync(codexHome, { recursive: true });

const child = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
let finished = false;
let exitCode = 0;

const cleanup = () => {
  try { child.stdin.end(); } catch {}
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
  }, 1000).unref();
};

const finish = (code, message) => {
  if (finished) return;
  finished = true;
  exitCode = code;
  clearTimeout(timer);
  if (message) {
    const stream = code === 0 ? process.stdout : process.stderr;
    stream.write(`${message}\n`);
  }
  cleanup();
};

const fail = (message) => finish(1, message);
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

const timer = setTimeout(() => fail('timed out waiting for codex app-server initialize/auth-status'), 12000);

child.on('error', (err) => fail(`failed to spawn codex app-server: ${err.message}`));
child.on('close', (code, signal) => {
  fs.rmSync(codexHome, { recursive: true, force: true });
  if (!finished) {
    console.error(`codex app-server exited early (code=${code} signal=${signal})`);
    process.exit(1);
  }
  process.exit(exitCode);
});

child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  while (true) {
    const newline = buffer.indexOf('\n');
    if (newline === -1) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }

    if (message.id === 1) {
      // Mirror Taurus's real startup: initialize first, then send initialized,
      // then make one bounded request that works even without prior auth.
      if (message.error) {
        fail(`initialize failed: ${message.error.message || JSON.stringify(message.error)}`);
        return;
      }
      send({ jsonrpc: '2.0', method: 'initialized', params: {} });
      send({
        jsonrpc: '2.0',
        id: 2,
        method: 'getAuthStatus',
        params: { includeToken: false, refreshToken: false },
      });
      continue;
    }

    if (message.id === 2) {
      if (message.error) {
        fail(`getAuthStatus failed: ${message.error.message || JSON.stringify(message.error)}`);
        return;
      }
      finish(0, `codex app-server smoke OK ${JSON.stringify(message.result || {})}`);
      return;
    }
  }
});

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    clientInfo: { name: 'taurus-build-smoke', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  },
});
