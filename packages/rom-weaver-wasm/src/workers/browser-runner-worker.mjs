import { createRomWeaverBrowserOpfs } from '../rom-weaver-browser-opfs-api.mjs';
import { createRunnerWorkerMessageQueue } from './runner-worker-core.mjs';

const workerMessages = createRunnerWorkerMessageQueue({
  postMessage(message) {
    self.postMessage(message);
  },
  async initRunner({ mode, options }) {
    const resolvedMode = mode ?? 'browser-opfs';
    if (resolvedMode !== 'browser-opfs') {
      throw new Error(
        `unsupported browser worker mode: ${resolvedMode}. `
          + 'Supported mode is: browser-opfs.',
      );
    }

    return {
      runner: await createRomWeaverBrowserOpfs(options),
      mode: 'browser-opfs',
    };
  },
});

self.addEventListener('message', (event) => {
  workerMessages.enqueue(event.data);
});
