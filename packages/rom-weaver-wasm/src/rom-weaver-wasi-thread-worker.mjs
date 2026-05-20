import { parentPort } from 'node:worker_threads';
import { WASI } from 'node:wasi';
import { ThreadMessageHandler, WASIThreads } from '@emnapi/wasi-threads';
import { createWasmEnvImports } from './rom-weaver-wasi-api.mjs';

if (!parentPort) {
  throw new Error('rom-weaver-wasi-thread-worker requires node:worker_threads parentPort');
}

const threadMessageHandler = new ThreadMessageHandler({
  postMessage(message) {
    parentPort.postMessage(message);
  },
  async onLoad({ wasmModule, wasmMemory }) {
    const wasi = new WASI({
      version: 'preview1',
    });
    const wasiThreads = new WASIThreads({
      wasi,
      childThread: true,
      postMessage(message) {
        parentPort.postMessage(message);
      },
    });
    const instance = await WebAssembly.instantiate(wasmModule, {
      wasi_snapshot_preview1: wasi.wasiImport,
      env: createWasmEnvImports(wasmMemory),
      ...wasiThreads.getImportObject(),
    });
    const initializedInstance = wasiThreads.initialize(instance, wasmModule, wasmMemory);

    return {
      module: wasmModule,
      instance: initializedInstance,
    };
  },
});

parentPort.on('message', (message) => {
  threadMessageHandler.handle({ data: message });
});
