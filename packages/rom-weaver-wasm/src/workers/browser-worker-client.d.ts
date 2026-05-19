import type {
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
  RomWeaverRunOptions,
  RomWeaverRunResult,
} from '../rom-weaver-types.d.ts';

export interface BrowserWorkerClientCreateOptions {
  worker?: Worker;
  workerUrl?: URL | string;
  workerOptions?: WorkerOptions;
}

export interface BrowserWorkerRunJsonOptions<TEvent = unknown, TTraceEvent = unknown>
  extends Omit<RomWeaverRunJsonOptions<TEvent, TTraceEvent>, 'onEvent' | 'onNonJsonLine' | 'onTraceEvent' | 'onTraceNonJsonLine'> {
  onEvent?: (event: TEvent) => void;
  onNonJsonLine?: (line: string) => void;
  onTraceEvent?: (event: TTraceEvent) => void;
  onTraceNonJsonLine?: (line: string) => void;
  [key: string]: unknown;
}

export function createBrowserWorkerClient(
  options?: BrowserWorkerClientCreateOptions,
): BrowserRomWeaverWorkerClient;

export class BrowserRomWeaverWorkerClient {
  constructor(worker: Worker);
  init(options?: Record<string, unknown>): Promise<{ mode: string }>;
  run(args?: unknown[], options?: RomWeaverRunOptions & Record<string, unknown>): Promise<RomWeaverRunResult>;
  runJson<TEvent = unknown, TTraceEvent = unknown>(
    args?: unknown[],
    options?: BrowserWorkerRunJsonOptions<TEvent, TTraceEvent>,
  ): Promise<RomWeaverRunJsonResult<TEvent, TTraceEvent>>;
  dispose(): Promise<{ disposed: true }>;
  terminate(): void;
}
