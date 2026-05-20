import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..');
const DIST_WASM_DIR = resolve(REPO_ROOT, 'dist', 'wasm');

const REQUIRED_DIST_COPIES = [
  { src: 'rom-weaver-cli.wasm', dst: 'rom-weaver-cli.wasm' },
  { src: 'rom-weaver-cli.wasm.br', dst: 'rom-weaver-cli.wasm.br' },
  { src: 'rom-weaver-cli-threaded.wasm', dst: 'rom-weaver-cli-threaded.wasm' },
  { src: 'rom-weaver-cli-threaded.wasm.br', dst: 'rom-weaver-cli-threaded.wasm.br' },
  { src: 'rom-weaver-wasi-api.mjs', dst: 'src/rom-weaver-wasi-api.mjs' },
  { src: 'rom-weaver-zenfs-api.mjs', dst: 'src/rom-weaver-zenfs-api.mjs' },
  { src: 'rom-weaver-wasi-thread-worker.mjs', dst: 'src/rom-weaver-wasi-thread-worker.mjs' },
  { src: 'threaded.args', dst: 'threaded.args' },
];

const OPTIONAL_ROOT_FILES = [
  'NOTICE',
  'THIRD_PARTY_LICENSES.md',
];

function main() {
  mkdirSync(PACKAGE_DIR, { recursive: true });

  if (!existsSync(DIST_WASM_DIR)) {
    fail(
      `Missing dist directory: ${DIST_WASM_DIR}. Run scripts/build-wasm-cli.sh first.`,
    );
  }

  for (const { src: srcName, dst: dstName } of REQUIRED_DIST_COPIES) {
    const src = resolve(DIST_WASM_DIR, srcName);
    const dst = resolve(PACKAGE_DIR, dstName);

    if (!existsSync(src)) {
      fail(`Missing dist artifact: ${src}. Run scripts/build-wasm-cli.sh first.`);
    }

    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    log(`copied ${relativeFromRepo(src)} -> ${relativeFromRepo(dst)}`);
  }

  for (const filename of OPTIONAL_ROOT_FILES) {
    const src = resolve(REPO_ROOT, filename);
    const dst = resolve(PACKAGE_DIR, filename);
    if (!existsSync(src)) {
      continue;
    }

    copyFileSync(src, dst);
    log(`copied ${relativeFromRepo(src)} -> ${relativeFromRepo(dst)}`);
  }

  log('package sync complete');
}

function relativeFromRepo(path) {
  return path.slice(REPO_ROOT.length + 1);
}

function log(message) {
  process.stdout.write(`[sync-dist] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[sync-dist] ${message}\n`);
  process.exit(1);
}

main();
