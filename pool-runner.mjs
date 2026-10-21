// Pear-runtime runner for the pool peer (same pattern as intercom-dex pear-runner.mjs).
import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import osConstants from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectDirectory = fileURLToPath(new URL('./', import.meta.url));
const entrypoint = fileURLToPath(new URL('./pool-peer.mjs', import.meta.url));
const appArgs = process.argv.slice(2);

const exitCodeFor = (code, signal) => {
  if (code !== null && code !== undefined) return code;
  const n = osConstants.signals?.[signal];
  return Number.isInteger(n) ? 128 + n : 1;
};

const runModule = async () => {
  const imported = await import('pear-runtime');
  const PearRuntime = imported.default ?? imported;
  const worker = PearRuntime.run(entrypoint, appArgs);
  const onErr = (e) => { if (e?.code === 'EPIPE' || e?.code === 'ERR_STREAM_DESTROYED') return; console.error('stdin err', e?.message); };
  if (worker.stdin) worker.stdin.on('error', onErr);
  if (worker.stdin) process.stdin.pipe(worker.stdin);
  if (worker.stdout) worker.stdout.pipe(process.stdout, { end: false });
  if (worker.stderr) worker.stderr.pipe(process.stderr, { end: false });
  const unpipe = () => { if (worker.stdin) process.stdin.unpipe(worker.stdin); };
  worker.once('close', unpipe);
  worker.once('exit', (code, signal) => {
    console.error(`Pool worker exited (${signal ? 'signal ' + signal : 'code ' + code}).`);
    process.exitCode = exitCodeFor(code, signal);
  });
};

await runModule();
