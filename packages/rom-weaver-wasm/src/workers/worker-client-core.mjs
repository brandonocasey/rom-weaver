export class RomWeaverWorkerClientCore {
  constructor(worker, transport) {
    this.worker = worker;
    this._transport = transport;
    this._nextRequestId = 1;
    this._pending = new Map();

    this._onMessage = this._onMessage.bind(this);
    this._onError = this._onError.bind(this);
    this._onExit = this._onExit.bind(this);

    this._transport.onMessage(this.worker, this._onMessage);
    this._transport.onError(this.worker, this._onError);
    this._transport.onExit?.(this.worker, this._onExit);
  }

  run(args = [], options = {}) {
    return this._send({ type: 'run', args, options });
  }

  runJson(args = [], options = {}) {
    const {
      onEvent,
      onNonJsonLine,
      onTraceEvent,
      onTraceNonJsonLine,
      ...runOptions
    } = options ?? {};
    return this._send(
      { type: 'runJson', args, options: runOptions },
      { onEvent, onNonJsonLine, onTraceEvent, onTraceNonJsonLine },
    );
  }

  dispose() {
    return this._send({ type: 'dispose' });
  }

  _send(payload, handlers = {}) {
    const requestId = this._nextRequestId;
    this._nextRequestId += 1;

    return new Promise((resolve, reject) => {
      this._pending.set(requestId, {
        resolve,
        reject,
        onEvent: typeof handlers.onEvent === 'function' ? handlers.onEvent : null,
        onNonJsonLine: typeof handlers.onNonJsonLine === 'function'
          ? handlers.onNonJsonLine
          : null,
        onTraceEvent: typeof handlers.onTraceEvent === 'function'
          ? handlers.onTraceEvent
          : null,
        onTraceNonJsonLine: typeof handlers.onTraceNonJsonLine === 'function'
          ? handlers.onTraceNonJsonLine
          : null,
      });

      try {
        this._transport.postMessage(this.worker, { ...payload, requestId });
      } catch (error) {
        this._pending.delete(requestId);
        reject(error);
      }
    });
  }

  _onMessage(rawMessage) {
    const message = this._transport.readMessage(rawMessage);
    if (!message || typeof message !== 'object') {
      return;
    }

    const requestId = message.requestId;
    const pending = this._pending.get(requestId);

    switch (message.type) {
      case 'event':
        pending?.onEvent?.(message.event);
        return;
      case 'nonJsonLine':
        pending?.onNonJsonLine?.(message.line);
        return;
      case 'traceEvent':
        pending?.onTraceEvent?.(message.event);
        return;
      case 'traceNonJsonLine':
        pending?.onTraceNonJsonLine?.(message.line);
        return;
      case 'ready':
        this._pending.delete(requestId);
        pending?.resolve({ mode: message.mode });
        return;
      case 'disposed':
        this._pending.delete(requestId);
        pending?.resolve({ disposed: true });
        return;
      case 'result':
        this._pending.delete(requestId);
        pending?.resolve(message.result);
        return;
      case 'error':
        this._pending.delete(requestId);
        pending?.reject(deserializeError(message.error));
        return;
      default:
        return;
    }
  }

  _onError(rawError) {
    this._rejectAllPending(this._transport.toError(rawError));
  }

  _onExit(code) {
    if (this._pending.size === 0) {
      return;
    }

    const error = this._transport.toExitError?.(code);
    if (error) {
      this._rejectAllPending(error);
    }
  }

  _rejectAllPending(error) {
    for (const pending of this._pending.values()) {
      pending.reject(error);
    }
    this._pending.clear();
  }

  _shutdown(reason = 'worker terminated') {
    this._detachListeners();
    this._rejectAllPending(new Error(reason));
  }

  _detachListeners() {
    this._transport.offMessage(this.worker, this._onMessage);
    this._transport.offError(this.worker, this._onError);
    this._transport.offExit?.(this.worker, this._onExit);
  }

  _terminateWorker() {
    return this._transport.terminate(this.worker);
  }
}

export function createBrowserWorkerTransport() {
  return {
    postMessage(worker, message) {
      worker.postMessage(message);
    },
    onMessage(worker, listener) {
      worker.addEventListener('message', listener);
    },
    offMessage(worker, listener) {
      worker.removeEventListener('message', listener);
    },
    onError(worker, listener) {
      worker.addEventListener('error', listener);
    },
    offError(worker, listener) {
      worker.removeEventListener('error', listener);
    },
    readMessage(event) {
      return event.data;
    },
    toError(event) {
      if (event?.error instanceof Error) {
        return event.error;
      }
      return new Error(event?.message || 'worker error');
    },
    terminate(worker) {
      worker.terminate();
    },
  };
}

export function createNodeWorkerTransport() {
  return {
    postMessage(worker, message) {
      worker.postMessage(message);
    },
    onMessage(worker, listener) {
      worker.on('message', listener);
    },
    offMessage(worker, listener) {
      worker.off('message', listener);
    },
    onError(worker, listener) {
      worker.on('error', listener);
    },
    offError(worker, listener) {
      worker.off('error', listener);
    },
    onExit(worker, listener) {
      worker.on('exit', listener);
    },
    offExit(worker, listener) {
      worker.off('exit', listener);
    },
    readMessage(message) {
      return message;
    },
    toError(error) {
      return error instanceof Error ? error : new Error(String(error));
    },
    toExitError(code) {
      return new Error(`worker exited with code ${code}`);
    },
    terminate(worker) {
      return worker.terminate();
    },
  };
}

function deserializeError(error) {
  const out = new Error(
    error && typeof error.message === 'string' ? error.message : 'worker request failed',
  );

  if (error && typeof error.name === 'string') {
    out.name = error.name;
  }
  if (error && typeof error.stack === 'string') {
    out.stack = error.stack;
  }

  return out;
}
