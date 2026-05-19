import type { Worker, WorkerOptions } from 'node:worker_threads';
import type {
  RomWeaverNodeWorkerMode,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
  RomWeaverRunOptions,
  RomWeaverRunResult,
} from '../rom-weaver-types.d.ts';

export interface NodeWorkerClientCreateOptions {
  worker?: Worker;
  workerUrl?: URL | string;
  workerOptions?: WorkerOptions;
}

export interface NodeWorkerRunJsonOptions<TEvent = unknown, TTraceEvent = unknown>
  extends Omit<RomWeaverRunJsonOptions<TEvent, TTraceEvent>, 'onEvent' | 'onNonJsonLine' | 'onTraceEvent' | 'onTraceNonJsonLine'> {
  onEvent?: (event: TEvent) => void;
  onNonJsonLine?: (line: string) => void;
  onTraceEvent?: (event: TTraceEvent) => void;
  onTraceNonJsonLine?: (line: string) => void;
  [key: string]: unknown;
}

export function createNodeWorkerClient(options?: NodeWorkerClientCreateOptions): NodeRomWeaverWorkerClient;

export class NodeRomWeaverWorkerClient {
  constructor(worker: Worker);
  init(mode?: RomWeaverNodeWorkerMode, options?: Record<string, unknown>): Promise<{ mode: string }>;
  run(args?: unknown[], options?: RomWeaverRunOptions & Record<string, unknown>): Promise<RomWeaverRunResult>;
  runJson<TEvent = unknown, TTraceEvent = unknown>(
    args?: unknown[],
    options?: NodeWorkerRunJsonOptions<TEvent, TTraceEvent>,
  ): Promise<RomWeaverRunJsonResult<TEvent, TTraceEvent>>;
  dispose(): Promise<{ disposed: true }>;
  terminate(): Promise<void>;
}
