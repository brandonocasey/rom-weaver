import {
  createBrowserWorkerTransport,
  RomWeaverWorkerClientCore,
} from './worker-client-core.mjs';

export function createBrowserWorkerClient(options = {}) {
  const worker = options.worker ?? new Worker(
    options.workerUrl ?? new URL('./browser-runner-worker.mjs', import.meta.url),
    {
      type: 'module',
      ...(options.workerOptions ?? {}),
    },
  );

  return new BrowserRomWeaverWorkerClient(worker);
}

const BROWSER_WORKER_TRANSPORT = createBrowserWorkerTransport();

export class BrowserRomWeaverWorkerClient extends RomWeaverWorkerClientCore {
  constructor(worker) {
    super(worker, BROWSER_WORKER_TRANSPORT);
  }

  init(options = {}) {
    return this._send({
      type: 'init',
      mode: 'browser-zenfs',
      options,
    });
  }

  terminate() {
    this._shutdown('worker terminated');
    this._terminateWorker();
  }
}
