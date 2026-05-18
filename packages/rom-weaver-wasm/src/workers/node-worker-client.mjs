import { Worker } from 'node:worker_threads';
import {
  createNodeWorkerTransport,
  RomWeaverWorkerClientCore,
} from './worker-client-core.mjs';

export function createNodeWorkerClient(options = {}) {
  const worker = options.worker ?? new Worker(
    options.workerUrl ?? new URL('./node-runner-worker.mjs', import.meta.url),
    { ...(options.workerOptions ?? {}) },
  );

  return new NodeRomWeaverWorkerClient(worker);
}

const NODE_WORKER_TRANSPORT = createNodeWorkerTransport();

export class NodeRomWeaverWorkerClient extends RomWeaverWorkerClientCore {
  constructor(worker) {
    super(worker, NODE_WORKER_TRANSPORT);
  }

  init(mode = 'wasi', options = {}) {
    return this._send({ type: 'init', mode, options });
  }

  async terminate() {
    this._shutdown('worker terminated');
    const maybePromise = this._terminateWorker();
    if (maybePromise && typeof maybePromise.then === 'function') {
      await maybePromise;
    }
  }
}
