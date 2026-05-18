import { createRomWeaverZenFsBrowser } from '../rom-weaver-zenfs-api.mjs';
import { createRunnerWorkerMessageQueue } from './runner-worker-core.mjs';

const workerMessages = createRunnerWorkerMessageQueue({
  postMessage(message) {
    self.postMessage(message);
  },
  async initRunner({ mode, options }) {
    const resolvedMode = mode ?? 'browser-zenfs';
    if (resolvedMode !== 'browser-zenfs') {
      throw new Error(
        `unsupported browser worker mode: ${resolvedMode}. `
          + 'Supported mode is: browser-zenfs.',
      );
    }

    return {
      runner: await createRomWeaverZenFsBrowser(options),
      mode: resolvedMode,
    };
  },
});

self.addEventListener('message', (event) => {
  workerMessages.enqueue(event.data);
});
