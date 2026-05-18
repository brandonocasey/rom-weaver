export type RomWeaverArg = string | number | boolean | bigint;
export type RomWeaverEnv = Record<string, string>;
export type RomWeaverPreopens = Record<string, string>;

export type RomWeaverStdinInput = string | Uint8Array | ArrayBuffer | null | undefined;

export interface RomWeaverRunResult {
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  ok: boolean;
  error?: unknown;
}

export interface RomWeaverRunOptions {
  stdin?: RomWeaverStdinInput;
  env?: RomWeaverEnv;
  preopens?: RomWeaverPreopens;
  argv0?: string;
}

export interface ParseJsonLinesOptions<TEvent = unknown> {
  onEvent?: (event: TEvent) => void;
  onNonJsonLine?: (line: string) => void;
}

export interface ParseJsonLinesResult<TEvent = unknown> {
  events: TEvent[];
  nonJsonLines: string[];
}

export interface RomWeaverRunJsonOptions<TEvent = unknown> extends RomWeaverRunOptions {
  onEvent?: (event: TEvent) => void;
  onNonJsonLine?: (line: string) => void;
}

export interface RomWeaverRunJsonResult<TEvent = unknown> extends RomWeaverRunResult {
  events: TEvent[];
  nonJsonLines: string[];
}

export interface RomWeaverWasiRunnerOptions {
  wasmPath?: string;
  argv0?: string;
  env?: RomWeaverEnv;
  preopens?: RomWeaverPreopens;
  useDefaultPreopens?: boolean;
}

export interface NodeFsRunnerOptions extends RomWeaverWasiRunnerOptions {
  includeHostRoot?: boolean;
  mountCwd?: boolean;
  cwdGuestPath?: string;
  mountTmp?: boolean;
  tmpGuestPath?: string;
  tmpHostPath?: string;
  mounts?: Record<string, string>;
}

export interface FileSystemDirectoryHandleLike {
  kind: string;
  entries: () => AsyncIterable<[string, unknown]>;
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<unknown>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<unknown>;
}

export type RomWeaverBrowserSyncAccessMode = 'read-only' | 'readwrite' | 'readwrite-unsafe';

export interface RomWeaverZenFsNodeOptions extends NodeFsRunnerOptions {
  cwdHostPath?: string;
}

export interface RomWeaverZenFsBrowserOptions {
  module?: WebAssembly.Module;
  wasmUrl?: string;
  opfsHandle?: FileSystemDirectoryHandleLike;
  opfsGuestPath?: string;
  tmpGuestPath?: string;
  runtimeMounts?: string[];
  mountHandles?: Record<string, FileSystemDirectoryHandleLike>;
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  program?: string;
  argv0?: string;
  env?: RomWeaverEnv;
  debugWasi?: boolean;
}

export interface RomWeaverZenFsBrowserRunOptions extends RomWeaverRunOptions {
  mountHandles?: Record<string, FileSystemDirectoryHandleLike>;
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  program?: string;
  debugWasi?: boolean;
}

export type RomWeaverNodeWorkerMode = 'wasi' | 'nodefs' | 'zenfs-node';

export interface RomWeaverWorkerSerializedError {
  name: string;
  message: string;
  stack?: string;
}
