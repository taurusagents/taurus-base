#!/usr/bin/env node
/**
 * Fail the image build unless a baked CLI reports the version the runtime
 * manifest claims this image contains.
 *
 * Usage:
 *   node subscription-cli-version-check.mjs <manifest.json> <key> <version-output-file>
 *
 * The version-output file is whatever `<cli> --version` printed. Both CLIs
 * surround the number with other words, so the comparison is against
 * whitespace-separated tokens: matching the whole line would break the first
 * time either changes its wording, and a substring match would accept 2.1.2601
 * as 2.1.260.
 *
 * Every failure mode here is a failure. A manifest that cannot be read or
 * parsed, a key that is absent or not a version string, an empty or missing
 * output file — each is reported and exits non-zero, rather than degrading into
 * a comparison against nothing that quietly passes.
 */

import { readFileSync } from 'node:fs';

const [manifestPath, key, reportedPath] = process.argv.slice(2);

if (!manifestPath || !key || !reportedPath) {
  console.error('usage: subscription-cli-version-check.mjs <manifest.json> <key> <version-output-file>');
  process.exit(1);
}

function readOrFail(filePath, what) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`Cannot read ${what} at ${filePath}: ${err.message}`);
    process.exit(1);
  }
}

let manifest;
try {
  manifest = JSON.parse(readOrFail(manifestPath, 'the runtime manifest'));
} catch (err) {
  console.error(`The runtime manifest at ${manifestPath} is not valid JSON: ${err.message}`);
  process.exit(1);
}

const expected = manifest?.[key];
if (typeof expected !== 'string' || expected.trim() === '') {
  console.error(`The runtime manifest at ${manifestPath} has no usable "${key}": ${JSON.stringify(expected)}`);
  process.exit(1);
}

const reported = readOrFail(reportedPath, `the reported ${key} version`);
if (!reported.split(/\s+/).includes(expected.trim())) {
  console.error(
    `Version drift: the runtime manifest says ${key}=${expected}, `
    + `but the binary reports ${JSON.stringify(reported.trim())}`,
  );
  process.exit(1);
}

console.log(`${key} ${expected} matches the runtime manifest`);
