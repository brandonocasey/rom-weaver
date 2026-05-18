import type {
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
  RomWeaverRunResult,
  RomWeaverZenFsBrowserOptions,
  RomWeaverZenFsBrowserRunOptions,
  RomWeaverZenFsNodeOptions,
} from './rom-weaver-types.d.ts';

export interface RomWeaverZenFsNodeRunner {
  mode: 'node';
  fs: unknown;
  guestMounts: Record<string, string>;
  run(args?: unknown[], options?: RomWeaverZenFsBrowserRunOptions): Promise<RomWeaverRunResult>;
  runJson<TEvent = unknown>(
    args?: unknown[],
    options?: RomWeaverRunJsonOptions<TEvent>,
  ): Promise<RomWeaverRunJsonResult<TEvent>>;
}

export interface RomWeaverZenFsBrowserRunner {
  mode: 'browser';
  fs: unknown;
  opfsHandle: unknown;
  opfsGuestPath: string;
  runtimeMounts: string[];
  run(args?: unknown[], options?: RomWeaverZenFsBrowserRunOptions): Promise<RomWeaverRunResult>;
  runJson<TEvent = unknown>(
    args?: unknown[],
    options?: RomWeaverRunJsonOptions<TEvent>,
  ): Promise<RomWeaverRunJsonResult<TEvent>>;
}

export function createRomWeaverZenFsNode(options?: RomWeaverZenFsNodeOptions): Promise<RomWeaverZenFsNodeRunner>;

export function createRomWeaverZenFsBrowser(
  options?: RomWeaverZenFsBrowserOptions,
): Promise<RomWeaverZenFsBrowserRunner>;

export function syncZenFsToWasmerDirectory(..._args: unknown[]): Promise<never>;
export function syncWasmerDirectoryToZenFs(..._args: unknown[]): Promise<never>;
