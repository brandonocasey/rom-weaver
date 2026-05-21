import * as wasiShim from '@bjorn3/browser_wasi_shim';
import * as zenfs from '@zenfs/core';
import * as zenDom from '@zenfs/dom';
import {
  createWasmEnvImports,
  normalizeGuestPath,
} from './rom-weaver-runtime-utils.mjs';

const DEFAULT_OPFS_GUEST_PATH = '/opfs';
const DEFAULT_SCRATCH_GUEST_PATH = '/scratch';
const DEFAULT_SCRATCH_NAMESPACE = '.rom-weaver-scratch';
const DEFAULT_MAX_BUFFERED_PATCH_BYTES = String(64 * 1024 * 1024);

export async function createRomWeaverZenFsBrowser(options = {}) {
  assertDedicatedWorkerRuntime();

  const opfsGuestPath = normalizeGuestPath(
    options.opfsGuestPath ?? DEFAULT_OPFS_GUEST_PATH,
    { label: 'opfsGuestPath' },
  );
  const scratchGuestPath = normalizeGuestPath(
    options.scratchGuestPath ?? options.tmpGuestPath ?? DEFAULT_SCRATCH_GUEST_PATH,
    { label: 'scratchGuestPath' },
  );
  const scratchNamespace = normalizeScratchNamespace(
    options.scratchNamespace ?? DEFAULT_SCRATCH_NAMESPACE,
  );
  const opfsHandle = options.opfsHandle ?? (await navigator.storage.getDirectory());
  const scratchRootHandle = await resolveScratchRootHandle({
    opfsHandle,
    scratchHandle: options.scratchHandle,
  });

  assertDirectoryHandle(opfsHandle, 'opfsHandle');
  assertDirectoryHandle(scratchRootHandle, 'scratchHandle');

  await verifyWritableScratchRoot(scratchRootHandle);

  await zenfs.configure({
    mounts: {
      '/': zenfs.InMemory,
      [opfsGuestPath]: {
        backend: zenDom.WebAccess,
        handle: opfsHandle,
      },
      [scratchGuestPath]: {
        backend: zenDom.WebAccess,
        handle: scratchRootHandle,
      },
    },
    defaultDirectories: true,
  });

  const module = await resolveBrowserModule(options.module, options.wasmUrl);
  const runtimeMounts = normalizeRuntimeMounts(
    options.runtimeMounts ?? [opfsGuestPath, scratchGuestPath],
  );
  const writableMounts = normalizeWritableMounts(options.writableMounts ?? [], {
    runtimeMounts,
    scratchGuestPath,
  });
  if (!runtimeMounts.includes(scratchGuestPath)) {
    throw new Error(
      `runtimeMounts must include scratch guest path ${scratchGuestPath}. `
        + 'Temporary files require a writable scratch mount.',
    );
  }

  const baseMountHandles = normalizeMountHandleMap({
    opfsGuestPath,
    opfsHandle,
    scratchGuestPath,
    scratchRootHandle,
    mountHandles: options.mountHandles,
  });
  const runtimeMountState = new Map();
  const activeScratchRunIds = new Set();

  const runner = {
    async run(args = [], runOptions = {}) {
      const normalizedArgs = normalizeArgs(args);
      const scratchRun = await allocateScratchRunNamespace(
        scratchRootHandle,
        scratchNamespace,
        activeScratchRunIds,
      );
      const mergedEnv = {
        ...(options.env ?? {}),
        ...(runOptions.env ?? {}),
      };
      if (mergedEnv.ROM_WEAVER_MAX_BUFFERED_PATCH_BYTES == null) {
        mergedEnv.ROM_WEAVER_MAX_BUFFERED_PATCH_BYTES = DEFAULT_MAX_BUFFERED_PATCH_BYTES;
      }
      const env = {
        ...mergedEnv,
        ROM_WEAVER_TMPDIR: joinScratchGuestPath(
          scratchGuestPath,
          scratchNamespace,
          scratchRun.runId,
        ),
      };
      const envList = Object.entries(env).map(([key, value]) => `${key}=${String(value)}`);

      const mountHandles = {
        ...baseMountHandles,
        ...normalizeMountHandleMap({
          opfsGuestPath,
          opfsHandle,
          scratchGuestPath,
          scratchRootHandle,
          mountHandles: runOptions.mountHandles,
        }),
      };

      const syncAccessMode = runOptions.syncAccessMode ?? options.syncAccessMode;
      const runWritableMounts = normalizeWritableMounts(
        runOptions.writableMounts ?? writableMounts,
        {
          runtimeMounts,
          scratchGuestPath,
        },
      );
      const {
        fds,
        closeHandles,
        stdoutChunks,
        stderrChunks,
      } = await buildBrowserWasiFds({
        wasiShim,
        stdin: runOptions.stdin,
        runtimeMounts,
        mountHandles,
        scratchGuestPath,
        writableMounts: runWritableMounts,
        syncAccessMode,
        runtimeMountState,
        onStderrChunk: runOptions.onStderrChunk,
        onStdoutChunk: runOptions.onStdoutChunk,
      });

      try {
        const wasi = new wasiShim.WASI(
          [runOptions.program ?? options.program ?? options.argv0 ?? 'rom-weaver', ...normalizedArgs],
          envList,
          fds,
          { debug: Boolean(runOptions.debugWasi ?? options.debugWasi ?? false) },
        );

        const instance = await WebAssembly.instantiate(module, {
          wasi_snapshot_preview1: wasi.wasiImport,
          env: createWasmEnvImports(),
        });

        const exitCode = wasi.start(instance);
        const stdout = decodeChunks(stdoutChunks);
        const stderr = decodeChunks(stderrChunks);

        return {
          args: normalizedArgs,
          exitCode,
          stdout,
          stderr,
          ok: exitCode === 0,
        };
      } catch (error) {
        const stdout = decodeChunks(stdoutChunks);
        const stderr = decodeChunks(stderrChunks);

        return {
          args: normalizedArgs,
          exitCode: 1,
          stdout,
          stderr,
          ok: false,
          error,
        };
      } finally {
        closeSyncAccessHandles(closeHandles);
        await cleanupScratchRunNamespace(
          scratchRootHandle,
          scratchNamespace,
          activeScratchRunIds,
          scratchRun.runId,
        );
      }
    },

    async runJson(args = [], runOptions = {}) {
      const jsonStream = createJsonLineStream({
        onEvent: runOptions.onEvent,
        onNonJsonLine: runOptions.onNonJsonLine,
      });
      const traceStream = createTraceJsonLineStream({
        onTraceEvent: runOptions.onTraceEvent,
        onTraceNonJsonLine: runOptions.onTraceNonJsonLine,
      });
      const result = await this.run(['--json', ...normalizeArgs(args)], {
        ...runOptions,
        onStderrChunk(text) {
          traceStream.push(text);
          runOptions.onStderrChunk?.(text);
        },
        onStdoutChunk(text) {
          jsonStream.push(text);
          runOptions.onStdoutChunk?.(text);
        },
      });
      jsonStream.flush();
      traceStream.flush();

      return {
        ...result,
        events: jsonStream.events,
        nonJsonLines: jsonStream.nonJsonLines,
        traceEvents: traceStream.traceEvents,
        traceNonJsonLines: traceStream.traceNonJsonLines,
      };
    },
  };

  return {
    mode: 'browser',
    fs: zenfs.fs,
    opfsHandle,
    scratchHandle: scratchRootHandle,
    opfsGuestPath,
    scratchGuestPath,
    scratchNamespace,
    runtimeMounts,
    run: (args, runOptions) => runner.run(args, runOptions),
    runJson: (args, runOptions) => runner.runJson(args, runOptions),
  };
}

export async function syncZenFsToWasmerDirectory() {
  throw new Error(
    'syncZenFsToWasmerDirectory is no longer used. '
      + 'Browser runtime now mounts OPFS directly for zero-copy execution.',
  );
}

export async function syncWasmerDirectoryToZenFs() {
  throw new Error(
    'syncWasmerDirectoryToZenFs is no longer used. '
      + 'Browser runtime now mounts OPFS directly for zero-copy execution.',
  );
}

async function buildBrowserWasiFds({
  wasiShim,
  stdin,
  runtimeMounts,
  mountHandles,
  scratchGuestPath,
  writableMounts,
  syncAccessMode,
  runtimeMountState,
  onStdoutChunk,
  onStderrChunk,
}) {
  const closeHandles = [];
  const stdinBytes = normalizeStdin(stdin);
  const stdoutCollector = createOutputCollector(wasiShim.ConsoleStdout, onStdoutChunk);
  const stderrCollector = createOutputCollector(wasiShim.ConsoleStdout, onStderrChunk);

  const fds = [
    new wasiShim.OpenFile(new wasiShim.File(stdinBytes)),
    stdoutCollector.fd,
    stderrCollector.fd,
  ];

  for (const mountPath of runtimeMounts) {
    if (mountPath === scratchGuestPath) {
      let scratchContents = runtimeMountState.get(mountPath);
      if (!(scratchContents instanceof Map)) {
        scratchContents = new Map();
        runtimeMountState.set(mountPath, scratchContents);
      }
      fds.push(new wasiShim.PreopenDirectory(mountPath, scratchContents));
      continue;
    }

    const handle = mountHandles[mountPath];
    if (!handle) {
      throw new Error(
        `No directory handle provided for runtime mount ${mountPath}. `
          + 'Provide options.mountHandles or runOptions.mountHandles.',
      );
    }

    const preopenContents = await buildOpfsInodeMap({
      wasiShim,
      directoryHandle: handle,
      closeHandles,
      readOnly: mountPath !== scratchGuestPath && !writableMounts.has(mountPath),
      syncAccessMode,
    });
    fds.push(createStrictOpfsPreopenDirectory(wasiShim, mountPath, preopenContents, {
      readOnly: mountPath !== scratchGuestPath && !writableMounts.has(mountPath),
    }));
  }

  return {
    fds,
    closeHandles,
    stdoutChunks: stdoutCollector.chunks,
    stderrChunks: stderrCollector.chunks,
  };
}

function createStrictOpfsPreopenDirectory(wasiShim, mountPath, contents, { readOnly }) {
  const rofsErrno = wasiShim.wasi.ERRNO_ROFS;
  const oCreat = wasiShim.wasi.OFLAGS_CREAT;

  class StrictOpfsPreopenDirectory extends wasiShim.PreopenDirectory {
    path_open(
      dirflags,
      pathStr,
      oflags,
      fsRightsBase,
      fsRightsInheriting,
      fdFlags,
    ) {
      if (
        readOnly
        && (oflags & oCreat) === oCreat
        && !pathExistsInDirectory(contents, pathStr)
      ) {
        return { ret: rofsErrno, fd_obj: null };
      }
      return super.path_open(
        dirflags,
        pathStr,
        oflags,
        fsRightsBase,
        fsRightsInheriting,
        fdFlags,
      );
    }

    path_create_directory(pathStr) {
      if (!readOnly) return super.path_create_directory(pathStr);
      return rofsErrno;
    }

    path_link(pathStr, inode, allowDir) {
      if (!readOnly) return super.path_link(pathStr, inode, allowDir);
      return rofsErrno;
    }

    path_unlink(pathStr) {
      if (!readOnly) return super.path_unlink(pathStr);
      return { ret: rofsErrno, inode_obj: null };
    }

    path_unlink_file(pathStr) {
      if (!readOnly) return super.path_unlink_file(pathStr);
      return rofsErrno;
    }

    path_remove_directory(pathStr) {
      if (!readOnly) return super.path_remove_directory(pathStr);
      return rofsErrno;
    }
  }

  return new StrictOpfsPreopenDirectory(mountPath, contents);
}

function pathExistsInDirectory(contents, pathStr) {
  if (!(contents instanceof Map)) {
    return false;
  }

  const parts = [];
  for (const token of String(pathStr).split('/')) {
    if (token === '' || token === '.') {
      continue;
    }
    if (token === '..') {
      if (parts.length === 0) {
        return false;
      }
      parts.pop();
      continue;
    }
    parts.push(token);
  }

  let currentEntries = contents;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const entry = currentEntries.get(part);
    if (!entry) {
      return false;
    }

    if (index === parts.length - 1) {
      return true;
    }

    if (!(entry.contents instanceof Map)) {
      return false;
    }

    currentEntries = entry.contents;
  }

  return true;
}

function createOutputCollector(ConsoleStdout, onTextChunk) {
  const chunks = [];
  const decoder = new TextDecoder();
  return {
    chunks,
    fd: new ConsoleStdout((bytes) => {
      const chunk = copyUint8Array(bytes);
      chunks.push(chunk);
      if (typeof onTextChunk === 'function') {
        const decoded = decoder.decode(chunk, { stream: true });
        if (decoded.length > 0) {
          onTextChunk(decoded);
        }
      }
    }),
  };
}

function createJsonLineStream(options = {}) {
  const events = [];
  const nonJsonLines = [];
  let pending = '';
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
  const onNonJsonLine = typeof options.onNonJsonLine === 'function'
    ? options.onNonJsonLine
    : null;

  const consumeLine = (line) => {
    if (line.length === 0) return;
    try {
      const event = JSON.parse(line);
      events.push(event);
      onEvent?.(event);
    } catch {
      nonJsonLines.push(line);
      onNonJsonLine?.(line);
    }
  };

  return {
    events,
    nonJsonLines,
    push(text) {
      pending += String(text);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        consumeLine(line);
      }
    },
    flush() {
      if (pending.length > 0) {
        consumeLine(pending);
        pending = '';
      }
    },
  };
}

function createTraceJsonLineStream(options = {}) {
  const traceEvents = [];
  const traceNonJsonLines = [];
  const stream = createJsonLineStream({
    onEvent(event) {
      traceEvents.push(event);
      options.onTraceEvent?.(event);
    },
    onNonJsonLine(line) {
      traceNonJsonLines.push(line);
      options.onTraceNonJsonLine?.(line);
    },
  });
  return {
    traceEvents,
    traceNonJsonLines,
    push: (text) => stream.push(text),
    flush: () => stream.flush(),
  };
}

function decodeChunks(chunks) {
  const decoder = new TextDecoder();
  let output = '';
  for (const chunk of chunks) {
    output += decoder.decode(chunk, { stream: true });
  }
  output += decoder.decode();
  return output;
}

async function buildOpfsInodeMap({
  wasiShim,
  directoryHandle,
  closeHandles,
  readOnly,
  syncAccessMode,
}) {
  const entries = new Map();

  for await (const [entryName, entryHandle] of directoryHandle.entries()) {
    if (entryHandle.kind === 'directory') {
      const nested = await buildOpfsInodeMap({
        wasiShim,
        directoryHandle: entryHandle,
        closeHandles,
        readOnly,
        syncAccessMode,
      });
      entries.set(entryName, new wasiShim.Directory(nested));
      continue;
    }

    if (entryHandle.kind !== 'file') {
      continue;
    }

    const syncHandle = await openSyncAccessHandle({
      fileHandle: entryHandle,
      mode: readOnly ? 'read-only' : syncAccessMode,
    });
    closeHandles.push(syncHandle);
    entries.set(
      entryName,
      new wasiShim.SyncOPFSFile(syncHandle, {
        readonly: readOnly,
      }),
    );
  }

  return entries;
}

async function openSyncAccessHandle({ fileHandle, mode }) {
  if (mode === undefined) {
    return fileHandle.createSyncAccessHandle();
  }

  try {
    return await fileHandle.createSyncAccessHandle({ mode });
  } catch (error) {
    if (mode === 'read-only') {
      return fileHandle.createSyncAccessHandle();
    }
    throw error;
  }
}

function closeSyncAccessHandles(handles) {
  for (const handle of handles) {
    try {
      handle.close();
    } catch {
      // ignore best-effort close failures
    }
  }
}

async function resolveScratchRootHandle({
  opfsHandle,
  scratchHandle,
}) {
  if (scratchHandle) {
    assertDirectoryHandle(scratchHandle, 'scratchHandle');
    return scratchHandle;
  }

  return opfsHandle;
}

async function verifyWritableScratchRoot(scratchRootHandle) {
  const probeName = `.rw-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const probeFile = await scratchRootHandle.getFileHandle(probeName, { create: true });
  let accessHandle = null;
  try {
    accessHandle = await openSyncAccessHandle({
      fileHandle: probeFile,
      mode: 'readwrite',
    });
    accessHandle.write(new Uint8Array([0x52, 0x57]), { at: 0 });
    accessHandle.flush();
  } catch (error) {
    throw new Error(
      `scratch root is not writable. Temporary operations require writable OPFS scratch: ${error}`,
    );
  } finally {
    if (accessHandle) {
      try {
        accessHandle.close();
      } catch {
        // ignore best-effort close failures
      }
    }
    try {
      await scratchRootHandle.removeEntry(probeName);
    } catch {
      // ignore best-effort cleanup failures
    }
  }
}

async function allocateScratchRunNamespace(scratchRootHandle, scratchNamespace, activeRunIds) {
  const namespaceHandle = await scratchRootHandle.getDirectoryHandle(scratchNamespace, {
    create: true,
  });
  await cleanupStaleScratchNamespaces(namespaceHandle, activeRunIds);

  const runId = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  const runHandle = await namespaceHandle.getDirectoryHandle(runId, { create: true });
  assertDirectoryHandle(runHandle, `scratch run namespace ${runId}`);
  activeRunIds.add(runId);
  return { runId };
}

async function cleanupScratchRunNamespace(
  scratchRootHandle,
  scratchNamespace,
  activeRunIds,
  runId,
) {
  activeRunIds.delete(runId);
  try {
    const namespaceHandle = await scratchRootHandle.getDirectoryHandle(scratchNamespace);
    await removeDirectoryEntryBestEffort(namespaceHandle, runId);
  } catch {
    // ignore best-effort cleanup failures
  }
}

async function cleanupStaleScratchNamespaces(scratchRootHandle, activeRunIds) {
  for await (const [entryName, entryHandle] of scratchRootHandle.entries()) {
    if (entryHandle.kind === 'directory' && !activeRunIds.has(entryName)) {
      await removeDirectoryEntryBestEffort(scratchRootHandle, entryName);
    }
  }
}

async function removeDirectoryEntryBestEffort(rootHandle, entryName) {
  try {
    await rootHandle.removeEntry(entryName, { recursive: true });
    return;
  } catch {
    // continue with non-recursive/manual fallback below
  }

  try {
    const entry = await rootHandle.getDirectoryHandle(entryName);
    for await (const [childName] of entry.entries()) {
      await removeDirectoryEntryBestEffort(entry, childName);
    }
    await rootHandle.removeEntry(entryName);
  } catch {
    // ignore best-effort cleanup failures
  }
}

function joinScratchGuestPath(scratchGuestPath, scratchNamespace, runId) {
  return normalizeGuestPath(`${scratchGuestPath}/${scratchNamespace}/${runId}`, {
    label: 'ROM_WEAVER_TMPDIR',
  });
}

function normalizeScratchNamespace(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('scratchNamespace must be a non-empty string');
  }

  const normalized = value
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');

  if (normalized.length === 0) {
    throw new TypeError('scratchNamespace must contain at least one non-slash character');
  }

  const parts = normalized.split('/');
  for (const part of parts) {
    if (part.length === 0 || part === '.' || part === '..') {
      throw new TypeError('scratchNamespace cannot contain "." or ".." segments');
    }
  }

  return normalized;
}

function normalizeWritableMounts(mounts, { runtimeMounts, scratchGuestPath }) {
  if (mounts instanceof Set) {
    return mounts;
  }
  if (!Array.isArray(mounts)) {
    throw new TypeError('writableMounts must be an array of guest paths');
  }

  const normalized = new Set([scratchGuestPath]);
  for (const mountPath of mounts) {
    const normalizedMountPath = normalizeGuestPath(String(mountPath), {
      label: 'writable mount guest path',
    });
    if (!runtimeMounts.includes(normalizedMountPath)) {
      throw new Error(`writable mount ${normalizedMountPath} must also be listed in runtimeMounts`);
    }
    normalized.add(normalizedMountPath);
  }
  return normalized;
}

function normalizeMountHandleMap({
  opfsGuestPath,
  opfsHandle,
  scratchGuestPath,
  scratchRootHandle,
  mountHandles,
}) {
  const normalized = {
    [opfsGuestPath]: opfsHandle,
    [scratchGuestPath]: scratchRootHandle,
  };

  if (!mountHandles) {
    return normalized;
  }

  for (const [guestPath, handle] of Object.entries(mountHandles)) {
    const normalizedGuestPath = normalizeGuestPath(guestPath, {
      label: `mountHandles[${guestPath}]`,
    });
    assertDirectoryHandle(handle, `mountHandles[${guestPath}]`);
    normalized[normalizedGuestPath] = handle;
  }

  return normalized;
}

function assertDedicatedWorkerRuntime() {
  if (typeof navigator === 'undefined' || typeof self === 'undefined') {
    throw new Error('createRomWeaverZenFsBrowser can only run in a browser runtime');
  }

  if (typeof window !== 'undefined') {
    throw new Error(
      'createRomWeaverZenFsBrowser must run in a Dedicated Worker. '
        + 'FileSystemSyncAccessHandle is not available on the main thread.',
    );
  }

  if (typeof FileSystemSyncAccessHandle === 'undefined') {
    throw new Error(
      'FileSystemSyncAccessHandle is not available in this runtime. '
        + 'Run inside a secure-context Dedicated Worker with OPFS support.',
    );
  }
}

function assertDirectoryHandle(handle, label) {
  if (!isDirectoryHandle(handle)) {
    throw new TypeError(`${label} must be a FileSystemDirectoryHandle`);
  }
}

function isDirectoryHandle(handle) {
  return Boolean(
    handle
      && typeof handle === 'object'
      && handle.kind === 'directory'
      && typeof handle.entries === 'function'
      && typeof handle.getDirectoryHandle === 'function'
      && typeof handle.getFileHandle === 'function',
  );
}

async function resolveBrowserModule(module, wasmUrl) {
  if (module instanceof WebAssembly.Module) {
    return module;
  }

  const url = wasmUrl ?? './rom-weaver-cli.wasm';
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch wasm module from ${url}: ${response.status} ${response.statusText}`);
  }

  const bytes = await response.arrayBuffer();
  return WebAssembly.compile(bytes);
}

function normalizeRuntimeMounts(mounts) {
  if (!Array.isArray(mounts) || mounts.length === 0) {
    throw new TypeError('runtimeMounts must be a non-empty array of guest paths');
  }
  return mounts.map((mountPath) => normalizeGuestPath(String(mountPath), {
    label: 'runtime mount guest path',
  }));
}

function normalizeArgs(args) {
  if (!Array.isArray(args)) {
    throw new TypeError('args must be an array of strings');
  }
  return args.map((value) => String(value));
}

function normalizeStdin(stdin) {
  if (stdin === undefined || stdin === null) {
    return new Uint8Array();
  }
  if (typeof stdin === 'string') {
    return new TextEncoder().encode(stdin);
  }
  if (stdin instanceof Uint8Array) {
    return stdin;
  }
  if (stdin instanceof ArrayBuffer) {
    return new Uint8Array(stdin);
  }
  throw new TypeError('stdin must be a string, Uint8Array, ArrayBuffer, or undefined');
}

function copyUint8Array(data) {
  const copied = new Uint8Array(data.byteLength);
  copied.set(data);
  return copied;
}
