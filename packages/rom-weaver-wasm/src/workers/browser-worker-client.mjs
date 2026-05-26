import {
  createBrowserWorkerTransport,
  RomWeaverWorkerClientCore,
} from './worker-client-core.mjs';

const DEFAULT_BROWSER_THREAD_COUNT = 4;

export function createBrowserWorkerClient(options = {}) {
  options = options ?? {};
  const createWorker = () => (
    options.worker ?? new Worker(
      options.workerUrl ?? new URL('./browser-runner-worker.mjs', import.meta.url),
      {
        type: 'module',
        ...(options.workerOptions ?? {}),
      },
    )
  );

  return new BrowserRomWeaverWorkerClient(createWorker(), {
    defaultThreads: Object.hasOwn(options, 'defaultThreads')
      ? options.defaultThreads
      : resolveBrowserDefaultThreads(),
  });
}

const BROWSER_WORKER_TRANSPORT = createBrowserWorkerTransport();

export class BrowserRomWeaverWorkerClient extends RomWeaverWorkerClientCore {
  constructor(worker, options = {}) {
    options = options ?? {};
    super(worker, BROWSER_WORKER_TRANSPORT);
    this._defaultThreads = normalizeDefaultThreads(options.defaultThreads);
    this._fallbackReason = null;
    this._forceSingleThreaded = false;
    this._lastInitOptions = null;
  }

  async init(options = {}) {
    options = options ?? {};
    const initOptions = this._createInitOptions(options);
    this._lastInitOptions = { ...initOptions };
    return this._initWithFallback(initOptions);
  }

  async run(args = [], options = {}) {
    return this._withStructuredCloneFallback(
      () => super.run(args, options),
      () => super.run(args, options),
    );
  }

  async runJson(args = [], options = {}) {
    return this._withStructuredCloneFallback(
      () => super.runJson(args, options),
      () => super.runJson(args, options),
    );
  }

  async _initWithFallback(initOptions) {
    try {
      return this._annotateReady(await this._sendInit(initOptions));
    } catch (error) {
      if (!this._shouldRetrySingleThreaded(error, initOptions)) throw error;
      this._forceSingleThreaded = true;
      this._fallbackReason = 'structured-clone';
      const fallbackOptions = this._createSingleThreadedInitOptions(initOptions);
      this._lastInitOptions = { ...fallbackOptions };
      await super.dispose().catch(() => undefined);
      return this._annotateReady(await this._sendInit(fallbackOptions));
    }
  }

  async _withStructuredCloneFallback(runOnce, retry) {
    try {
      return await runOnce();
    } catch (error) {
      if (!this._lastInitOptions || this._forceSingleThreaded || !isStructuredCloneFailure(error)) {
        throw error;
      }
      this._forceSingleThreaded = true;
      this._fallbackReason = 'structured-clone';
      await this._reinitializeSingleThreaded();
      return retry();
    }
  }

  async _reinitializeSingleThreaded() {
    const fallbackOptions = this._createSingleThreadedInitOptions(this._lastInitOptions);
    this._lastInitOptions = { ...fallbackOptions };
    await super.dispose().catch(() => undefined);
    await this._sendInit(fallbackOptions);
  }

  _createInitOptions(options) {
    const initOptions = { ...options };
    if (!Object.hasOwn(initOptions, 'defaultThreads') && this._defaultThreads !== null) {
      initOptions.defaultThreads = this._defaultThreads;
    }
    if (this._forceSingleThreaded) {
      return this._createSingleThreadedInitOptions(initOptions);
    }
    return initOptions;
  }

  _createSingleThreadedInitOptions(options) {
    return {
      ...options,
      defaultThreads: 1,
      preferThreadedWasm: false,
    };
  }

  _sendInit(options) {
    return this._send({
      type: 'init',
      mode: 'browser-opfs',
      options,
    });
  }

  _shouldRetrySingleThreaded(error, initOptions) {
    if (this._forceSingleThreaded || !isStructuredCloneFailure(error)) return false;
    return initOptions?.preferThreadedWasm !== false && initOptions?.defaultThreads !== 1;
  }

  _annotateReady(ready) {
    if (!this._fallbackReason) return ready;
    return {
      ...ready,
      fallbackReason: this._fallbackReason,
    };
  }

  terminate() {
    this._shutdown('worker terminated');
    this._terminateWorker();
  }
}

function isStructuredCloneFailure(error) {
  const name = error && typeof error === 'object' && 'name' in error
    ? String(error.name || '').toLowerCase()
    : '';
  const message = error && typeof error === 'object' && 'message' in error
    ? String(error.message || '').toLowerCase()
    : String(error || '').toLowerCase();
  return (
    name.includes('dataclone')
    || message.includes('can not be cloned')
    || message.includes('cannot be cloned')
    || message.includes('could not be cloned')
    || message.includes('structured clone')
  );
}

function resolveBrowserDefaultThreads(root = globalThis) {
  const hardwareConcurrency = Number(root?.navigator?.hardwareConcurrency);
  if (Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0) {
    return Math.max(1, Math.min(DEFAULT_BROWSER_THREAD_COUNT, Math.floor(hardwareConcurrency)));
  }
  return DEFAULT_BROWSER_THREAD_COUNT;
}

function normalizeDefaultThreads(value) {
  if (
    value === undefined
    || value === null
    || value === false
    || value === 0
    || value === '0'
    || value === 'off'
  ) {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`defaultThreads must be a positive integer; received: ${value}`);
  }
  return Math.max(1, Math.min(64, parsed));
}
