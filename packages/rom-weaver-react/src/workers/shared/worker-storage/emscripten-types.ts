import type { OpfsBackend } from "./types.ts";

type EmscriptenFsNode = {
  backend?: OpfsBackend | null;
  contents: Record<string, EmscriptenFsNode>;
  [key: string]: unknown;
  id?: number;
  mode: number;
  mounted?: { mountpoint?: string; root?: EmscriptenFsNode };
  name: string;
  node_ops?: EmscriptenNodeOps;
  parent?: EmscriptenFsNode | null;
  stream_ops?: EmscriptenStreamOps;
  timestamp?: number;
};

type EmscriptenFsStream = {
  node: EmscriptenFsNode;
  [key: string]: unknown;
  position: number;
};

type EmscriptenNodeOps = {
  getattr?: (node: EmscriptenFsNode) => unknown;
  lookup?: (parent: EmscriptenFsNode, name: string) => EmscriptenFsNode;
  mknod?: (parent: EmscriptenFsNode, name: string, mode: number) => EmscriptenFsNode;
  readdir?: (node: EmscriptenFsNode) => string[];
  setattr?: (node: EmscriptenFsNode, attr: { mode?: number; size?: number; timestamp?: number }) => void;
  unlink?: (parent: EmscriptenFsNode, name: string) => void;
};

type EmscriptenStreamOps = {
  close?: (stream: EmscriptenFsStream) => void;
  llseek?: (stream: EmscriptenFsStream, offset: number, whence: number) => number;
  read?: (stream: EmscriptenFsStream, buffer: Uint8Array, offset: number, length: number, position: number) => number;
  write?: (stream: EmscriptenFsStream, buffer: Uint8Array, offset: number, length: number, position?: number) => number;
};

type EmscriptenFileSystem = {
  [key: string]: unknown;
  ErrnoError: new (errno: number) => Error;
  createNode: (parent: EmscriptenFsNode | null, name: string, mode: number, dev?: number) => EmscriptenFsNode;
  filesystems?: Record<string, unknown>;
  genericErrors?: Record<number, Error>;
  getPath: (node: EmscriptenFsNode) => string;
  isDir: (mode: number) => boolean;
  isFile: (mode: number) => boolean;
  lookupPath: (path: string, options?: Record<string, unknown>) => { node: EmscriptenFsNode };
  makedev: (major: number, minor: number) => number;
  mkdirTree: (path: string) => void;
  mkdev: (path: string, mode: number, dev: number) => EmscriptenFsNode;
  mknod: (path: string, mode: number, dev: number) => EmscriptenFsNode;
  mount: (type: unknown, opts: Record<string, unknown>, mountpoint: string) => EmscriptenFsNode;
  nextInode: number;
  registerDevice: (dev: number, streamOps: EmscriptenStreamOps) => void;
  rmdir: (path: string) => void;
  stat: (path: string) => { size?: number };
  unlink: (path: string) => void;
  writeFile: (path: string, data: Uint8Array) => void;
};

type EmscriptenWorkerModule = {
  FS?: EmscriptenFileSystem;
  OPFS?: unknown;
};

export type {
  EmscriptenFileSystem,
  EmscriptenFsNode,
  EmscriptenFsStream,
  EmscriptenNodeOps,
  EmscriptenStreamOps,
  EmscriptenWorkerModule,
};
