import type {
  NodeFsRunnerOptions,
  ParseJsonLinesOptions,
  ParseJsonLinesResult,
  RomWeaverPreopens,
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
  runJson<TEvent = unknown>(
    args?: unknown[],
    options?: RomWeaverRunJsonOptions<TEvent>,
  ): Promise<RomWeaverRunJsonResult<TEvent>>;
}

export function createRomWeaverWasiRunner(options?: RomWeaverWasiRunnerOptions): RomWeaverWasiRunner;

export function createNodeFsRunner(options?: NodeFsRunnerOptions): RomWeaverWasiRunner;

export function buildNodeFsPreopens(options?: NodeFsRunnerOptions): RomWeaverPreopens;

export function parseJsonLines<TEvent = unknown>(
  text: string,
  options?: ParseJsonLinesOptions<TEvent>,
): ParseJsonLinesResult<TEvent>;
