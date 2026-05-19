# rom-weaver-wasm

JavaScript wrappers and WASM artifacts for `rom-weaver`.

## What You Get

- Node WASI runner (`createRomWeaverWasiRunner`)
- NodeFS runner (`createNodeFsRunner`)
- ZenFS runners for Node and browser OPFS
- Dedicated worker clients for Node and browser
- First-party TypeScript declarations

## Import Paths

- `rom-weaver-wasm` (main entry)
- `rom-weaver-wasm/node`
- `rom-weaver-wasm/zenfs`
- `rom-weaver-wasm/workers/node-client`
- `rom-weaver-wasm/workers/browser-client`
- `rom-weaver-wasm/workers/protocol`

## Node Quick Start

```js
import { createRomWeaverWasiRunner } from 'rom-weaver-wasm';

const runner = createRomWeaverWasiRunner();
const result = await runner.run(['--help']);

console.log(result.exitCode);
console.log(result.stdout);
```

## `run` vs `runJson`

- `run(args)` returns raw `stdout`/`stderr`.
- `runJson(args)` runs `--json`, parses stdout JSON progress events, and parses stderr JSON trace events.

```js
import { createRomWeaverWasiRunner } from 'rom-weaver-wasm';

const runner = createRomWeaverWasiRunner();

const raw = await runner.run(['inspect', 'game.bin']);
console.log(raw.stdout);

const structured = await runner.runJson(['inspect', 'game.bin'], {
  onEvent(event) {
    console.log('event', event);
  },
  onTraceEvent(event) {
    console.log('trace', event);
  },
  onNonJsonLine(line) {
    console.log('non-json', line);
  },
});

console.log(structured.events.length);
console.log(structured.nonJsonLines);
console.log(structured.traceEvents.length);
console.log(structured.traceNonJsonLines);
```

## NodeFS Example

```js
import { createNodeFsRunner } from 'rom-weaver-wasm/node';

const runner = createNodeFsRunner({
  mountCwd: false,
  mounts: {
    '/roms': '/absolute/path/to/roms',
    '/out': '/absolute/path/to/output',
  },
});

const result = await runner.runJson(
  ['checksum', '/roms/game.bin', '--algo', 'crc32'],
  {
    onEvent(event) {
      console.log(event);
    },
  },
);

console.log(result.exitCode, result.ok);
```

## Browser OPFS Example

`createRomWeaverZenFsBrowser` must run in a secure-context Dedicated Worker if you want true zero-copy OPFS access (`FileSystemSyncAccessHandle`).

```js
import { createRomWeaverZenFsBrowser } from 'rom-weaver-wasm/zenfs';

const opfsHandle = await navigator.storage.getDirectory();

const runner = await createRomWeaverZenFsBrowser({
  wasmUrl: '/wasm/rom-weaver-cli.wasm',
  opfsHandle,
  opfsGuestPath: '/opfs',
  runtimeMounts: ['/opfs', '/tmp'],
});

const result = await runner.runJson(
  ['checksum', '/opfs/game.bin', '--algo', 'crc32'],
  {
    onEvent(event) {
      console.log(event);
    },
  },
);

console.log(result.exitCode, result.ok);
```

## Dedicated Node Worker Example

```js
import { createNodeWorkerClient } from 'rom-weaver-wasm/workers/node-client';

const worker = createNodeWorkerClient();
await worker.init('nodefs', {
  mounts: {
    '/roms': '/absolute/path/to/roms',
  },
});

const result = await worker.runJson(['checksum', '/roms/game.bin', '--algo', 'crc32'], {
  onEvent(event) {
    console.log(event);
  },
});

console.log(result.exitCode, result.ok);
await worker.terminate();
```

## Dedicated Browser Worker Example

```js
import { createBrowserWorkerClient } from 'rom-weaver-wasm/workers/browser-client';

const worker = createBrowserWorkerClient();
const opfsHandle = await navigator.storage.getDirectory();

await worker.init({
  wasmUrl: '/wasm/rom-weaver-cli.wasm',
  opfsHandle,
  opfsGuestPath: '/opfs',
  runtimeMounts: ['/opfs', '/tmp'],
});

const result = await worker.runJson(['checksum', '/opfs/game.bin', '--algo', 'crc32'], {
  onEvent(event) {
    console.log(event);
  },
});

console.log(result.exitCode, result.ok);
worker.terminate();
```

## Build And Package

This package expects artifacts in `dist/wasm`.

```bash
scripts/build-wasm-cli.sh
```

`prepack` automatically syncs `dist/wasm` into this package:

```bash
npm run prepare:dist
npm run check
npm pack
```
