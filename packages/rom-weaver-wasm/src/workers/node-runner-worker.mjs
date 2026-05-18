import { parentPort } from 'node:worker_threads';
import {
  createNodeFsRunner,
  createRomWeaverWasiRunner,
} from '../rom-weaver-wasi-api.mjs';
import { createRomWeaverZenFsNode } from '../rom-weaver-zenfs-api.mjs';
import { createRunnerWorkerMessageQueue } from './runner-worker-core.mjs';

if (!parentPort) {
  throw new Error('node-runner-worker requires node:worker_threads parentPort');
}

const workerMessages = createRunnerWorkerMessageQueue({
  postMessage,
  async initRunner({ mode, options }) {
    const resolvedMode = mode ?? 'wasi';
    const runner = await createNodeRunner(resolvedMode, options);
    return { runner, mode: resolvedMode };
  },
});

parentPort.on('message', (message) => {
  workerMessages.enqueue(message);
});

async function createNodeRunner(mode, options) {
  switch (mode) {
    case 'wasi':
      return createRomWeaverWasiRunner(options);
    case 'nodefs':
      return createNodeFsRunner(options);
    case 'zenfs-node':
      return createRomWeaverZenFsNode(options);
    default:
      throw new Error(
        `unsupported node worker mode: ${mode}. `
          + 'Supported modes are: wasi, nodefs, zenfs-node.',
      );
  }
}

function postMessage(message) {
  parentPort.postMessage(message);
}
