import type {
  NodeFsRunnerOptions,
  ParseJsonLinesOptions,
  ParseJsonLinesResult,
  ParseTraceJsonLinesOptions,
  ParseTraceJsonLinesResult,
  RomWeaverPreopens,
  RomWeaverProgressEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
  RomWeaverRunOptions,
  RomWeaverRunResult,
  RomWeaverWasiRunnerOptions,
} from './rom-weaver-types.d.ts';

export const DEFAULT_WASM_PATH: string;
export const DEFAULT_PREOPENS: RomWeaverPreopens;

export class RomWeaverWasiRunner {
  constructor(options?: RomWeaverWasiRunnerOptions);
  run(args?: unknown[], options?: RomWeaverRunOptions): Promise<RomWeaverRunResult>;
  runJson<TEvent = RomWeaverProgressEvent, TTraceEvent = unknown>(
    args?: unknown[],
    options?: RomWeaverRunJsonOptions<TEvent, TTraceEvent>,
  ): Promise<RomWeaverRunJsonResult<TEvent, TTraceEvent>>;
}

export function createRomWeaverWasiRunner(options?: RomWeaverWasiRunnerOptions): RomWeaverWasiRunner;

export function createNodeFsRunner(options?: NodeFsRunnerOptions): RomWeaverWasiRunner;

export function buildNodeFsPreopens(options?: NodeFsRunnerOptions): RomWeaverPreopens;

export function parseJsonLines<TEvent = RomWeaverProgressEvent>(
  text: string,
  options?: ParseJsonLinesOptions<TEvent>,
): ParseJsonLinesResult<TEvent>;

export function parseTraceJsonLines<TTraceEvent = unknown>(
  text: string,
  options?: ParseTraceJsonLinesOptions<TTraceEvent>,
): ParseTraceJsonLinesResult<TTraceEvent>;
