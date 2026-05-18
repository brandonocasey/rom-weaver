import type {
  RomWeaverRunJsonResult,
  RomWeaverRunOptions,
  RomWeaverRunResult,
} from '../rom-weaver-types.d.ts';

export interface BrowserWorkerClientCreateOptions {
  worker?: Worker;
  workerUrl?: URL | string;
  workerOptions?: WorkerOptions;
}

export interface BrowserWorkerRunJsonOptions<TEvent = unknown>
  extends Omit<RomWeaverRunOptions, 'onEvent' | 'onNonJsonLine'> {
  onEvent?: (event: TEvent) => void;
  onNonJsonLine?: (line: string) => void;
  [key: string]: unknown;
}

export function createBrowserWorkerClient(
  options?: BrowserWorkerClientCreateOptions,
): BrowserRomWeaverWorkerClient;

export class BrowserRomWeaverWorkerClient {
  constructor(worker: Worker);
  init(options?: Record<string, unknown>): Promise<{ mode: string }>;
  run(args?: unknown[], options?: RomWeaverRunOptions & Record<string, unknown>): Promise<RomWeaverRunResult>;
  runJson<TEvent = unknown>(
    args?: unknown[],
    options?: BrowserWorkerRunJsonOptions<TEvent>,
  ): Promise<RomWeaverRunJsonResult<TEvent>>;
  dispose(): Promise<{ disposed: true }>;
  terminate(): void;
}
