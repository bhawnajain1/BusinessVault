#!/usr/bin/env node
// §26 Release Gate.
//
// Runs the mandatory checks a release must pass before it can be tagged
// and shipped. Each check is a shell command; a non-zero exit code marks
// the gate as failed. The script prints a per-check status table and
// exits with the aggregate result — 0 iff every check passed.
//
// This is deliberately a plain Node script (no runner framework) so it
// works identically in local dev, in CI, and inside git hooks. Log lines
// go to stderr as they happen so the summary table at the end is the
// only thing on stdout.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

// The check list from feedback_1_to_7.md §26. Every one MUST pass — this
// is a "gate", not a scorecard. Skip = fail.
const CHECKS = [
  {
    name: 'Typecheck',
    detail: 'tsc --noEmit — zero type errors',
    cmd: 'npx',
    args: ['tsc', '--noEmit'],
  },
  {
    name: 'Lint',
    detail: 'eslint . — zero errors',
    cmd: 'npx',
    args: ['eslint', '.'],
  },
  {
    name: 'Unit Tests',
    detail: 'vitest run src — all pass',
    cmd: 'npx',
    args: ['vitest', 'run', 'src'],
  },
  {
    name: 'Integration Tests',
    detail: 'vitest run tests — all pass (incl. accounting + DR)',
    cmd: 'npx',
    args: ['vitest', 'run', 'tests'],
  },
  {
    name: 'Production Build',
    detail: 'vite build — bundle succeeds',
    cmd: 'npx',
    args: ['vite', 'build'],
  },
];

function run({ cmd, args }, name) {
  return new Promise((resolvePromise) => {
    const start = Date.now();
    process.stderr.write(`\n▶ ${name} …\n`);
    const child = spawn(cmd, args, {
      cwd: REPO,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      resolvePromise({ code: code ?? 1, elapsed });
    });
    child.on('error', (err) => {
      process.stderr.write(`  spawn failed: ${err.message}\n`);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      resolvePromise({ code: 1, elapsed });
    });
  });
}

async function main() {
  const results = [];
  for (const check of CHECKS) {
    const { code, elapsed } = await run(check, check.name);
    results.push({ name: check.name, detail: check.detail, code, elapsed });
  }
  process.stdout.write('\n=== §26 Release Gate ===\n');
  const nameCol = Math.max(...results.map((r) => r.name.length));
  let anyFail = false;
  for (const r of results) {
    const status = r.code === 0 ? 'PASS' : 'FAIL';
    if (r.code !== 0) anyFail = true;
    process.stdout.write(
      `  ${r.name.padEnd(nameCol)}  ${status.padEnd(4)}  ${r.elapsed.padStart(5)}s  — ${r.detail}\n`,
    );
  }
  process.stdout.write(
    anyFail
      ? '\n✗ Release gate FAILED — do not ship.\n'
      : '\n✓ Release gate PASSED — safe to tag and ship.\n',
  );
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`release-gate crashed: ${err.stack ?? err}\n`);
  process.exit(2);
});
