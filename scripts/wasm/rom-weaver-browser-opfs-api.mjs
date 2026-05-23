import * as wasiShim from '@bjorn3/browser_wasi_shim';
import {
  createWasmEnvImports,
  normalizeGuestPath,
  parseJsonLines,
  parseTraceJsonLines,
} from './rom-weaver-runtime-utils.mjs';

const DEFAULT_WORK_GUEST_PATH = '/work';
const DEFAULT_MAX_BUFFERED_PATCH_BYTES = String(64 * 1024 * 1024);
const PATH_SEPARATOR_REGEX = /[/\\]+/;

export async function createRomWeaverBrowserOpfs(options = {}) {
  assertDedicatedWorkerRuntime();

  const workGuestPath = normalizeGuestPath(
    options.workGuestPath ?? options.opfsGuestPath ?? DEFAULT_WORK_GUEST_PATH,
    { label: 'workGuestPath' },
  );
  const opfsHandle = options.opfsHandle ?? (await navigator.storage.getDirectory());
  assertDirectoryHandle(opfsHandle, 'opfsHandle');
  await verifyWritableOpfsRoot(opfsHandle);

  const module = await resolveBrowserModule(options.module, options.wasmUrl);
  const runtimeMounts = normalizeRuntimeMounts(options.runtimeMounts ?? [workGuestPath]);
  const baseMountHandles = normalizeMountHandleMap({
    mountHandles: {
      [workGuestPath]: opfsHandle,
      ...(options.mountHandles ?? {}),
    },
  });
  const baseWritableRoots = normalizeWritableRoots({
    workGuestPath,
    writableDirectories: options.writableDirectories,
  });

  const runner = {
    async run(args = [], runOptions = {}) {
      const normalizedArgs = normalizeArgs(args);
      const env = createRunEnv({
        baseEnv: options.env,
        runEnv: runOptions.env,
        workGuestPath,
      });
      const envList = Object.entries(env).map(([key, value]) => `${key}=${String(value)}`);
      const mountHandles = {
        ...baseMountHandles,
        ...normalizeMountHandleMap({ mountHandles: runOptions.mountHandles }),
      };
      await prepareKnownCliPaths({
        args: normalizedArgs,
        mountHandles,
        runtimeMounts,
      });

      const closeables = [];
      const {
        fds,
        mounts,
        stdoutChunks,
        stderrChunks,
      } = await buildBrowserOpfsWasiFds({
        cwdMountPath: workGuestPath,
        stdin: runOptions.stdin,
        runtimeMounts,
        mountHandles,
        writableRoots: normalizeWritableRoots({
          workGuestPath,
          writableDirectories: runOptions.writableDirectories,
          inherited: baseWritableRoots,
        }),
        syncAccessMode: runOptions.syncAccessMode ?? options.syncAccessMode,
        closeables,
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
        await flushBrowserOpfsMounts(mounts);
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
        closeSyncFiles(closeables);
      }
    },

    async runJson(args = [], runOptions = {}) {
      const result = await this.run(['--json', ...normalizeArgs(args)], runOptions);
      const parsed = parseJsonLines(result.stdout, {
        onEvent: runOptions.onEvent,
        onNonJsonLine: runOptions.onNonJsonLine,
      });
      const parsedTrace = parseTraceJsonLines(result.stderr, {
        onTraceEvent: runOptions.onTraceEvent,
        onTraceNonJsonLine: runOptions.onTraceNonJsonLine,
      });

      return {
        ...result,
        events: parsed.events,
        nonJsonLines: parsed.nonJsonLines,
        traceEvents: parsedTrace.traceEvents,
        traceNonJsonLines: parsedTrace.traceNonJsonLines,
      };
    },
  };

  return {
    mode: 'browser-opfs',
    fs: null,
    opfsHandle,
    opfsGuestPath: workGuestPath,
    workGuestPath,
    runtimeMounts,
    writableRoots: baseWritableRoots,
    run: (args, runOptions) => runner.run(args, runOptions),
    runJson: (args, runOptions) => runner.runJson(args, runOptions),
  };
}

function createRunEnv({ baseEnv, runEnv, workGuestPath }) {
  const mergedEnv = {
    ...(baseEnv ?? {}),
    ...(runEnv ?? {}),
  };
  if (mergedEnv.ROM_WEAVER_MAX_BUFFERED_PATCH_BYTES == null) {
    mergedEnv.ROM_WEAVER_MAX_BUFFERED_PATCH_BYTES = DEFAULT_MAX_BUFFERED_PATCH_BYTES;
  }
  return mergedEnv;
}

async function buildBrowserOpfsWasiFds({
  cwdMountPath,
  stdin,
  runtimeMounts,
  mountHandles,
  writableRoots,
  syncAccessMode,
  closeables,
}) {
  const stdinBytes = normalizeStdin(stdin);
  const stdoutCollector = createOutputCollector(wasiShim.ConsoleStdout);
  const stderrCollector = createOutputCollector(wasiShim.ConsoleStdout);

  const fds = [
    new wasiShim.OpenFile(new wasiShim.File(stdinBytes)),
    stdoutCollector.fd,
    stderrCollector.fd,
  ];
  const mounts = [];
  let cwdMount = null;

  for (const mountPath of runtimeMounts) {
    const handle = mountHandles[mountPath];
    if (!handle) {
      throw new Error(
        `No directory handle provided for runtime mount ${mountPath}. `
          + 'Provide options.mountHandles or runOptions.mountHandles.',
      );
    }

    const mount = await BrowserOpfsMount.create({
      closeables,
      directoryHandle: handle,
      mountPath,
      syncAccessMode,
      writableRoots,
    });
    mounts.push(mount);
    fds.push(new PreparedWasiPreopenDirectory(mount));
    if (mountPath === cwdMountPath) cwdMount = mount;
  }

  if (cwdMount) {
    fds.push(new PreparedWasiPreopenDirectory(cwdMount, { preopenName: '.' }));
  }

  return {
    fds,
    mounts,
    stdoutChunks: stdoutCollector.chunks,
    stderrChunks: stderrCollector.chunks,
  };
}

class BrowserOpfsMount {
  static async create({ closeables, directoryHandle, mountPath, syncAccessMode, writableRoots }) {
    const contents = await buildOpfsInodeMap({
      closeables,
      directoryHandle,
      guestPath: mountPath,
      syncAccessMode,
      writableRoots,
    });
    return new BrowserOpfsMount({ contents, directoryHandle, mountPath, writableRoots });
  }

  constructor({ contents, directoryHandle, mountPath, writableRoots }) {
    this.contents = contents;
    this.directoryHandle = directoryHandle;
    this.mountPath = mountPath;
    this.writableRoots = writableRoots;
  }

  isWritablePath(guestPath) {
    return isGuestPathWithinRoots(guestPath, this.writableRoots);
  }
}

class PreparedWasiPreopenDirectory extends wasiShim.PreopenDirectory {
  constructor(mount, options = {}) {
    super(options.preopenName ?? mount.mountPath, mount.contents);
    this.mount = mount;
  }

  path_open(dirflags, pathStr, oflags, fsRightsBase, fsRightsInheriting, fdFlags) {
    const pathRet = validateWasiRelativePath(pathStr);
    if (pathRet !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: pathRet, fd_obj: null };

    const guestPath = joinGuestPath(this.mount.mountPath, pathStr);
    let entry = findEntryInDirectory(this.mount.contents, pathStr);
    if (!entry) {
      if ((oflags & wasiShim.wasi.OFLAGS_CREAT) !== wasiShim.wasi.OFLAGS_CREAT) {
        return { ret: wasiShim.wasi.ERRNO_NOENT, fd_obj: null };
      }
      if (!this.mount.isWritablePath(guestPath)) {
        return { ret: wasiShim.wasi.ERRNO_ROFS, fd_obj: null };
      }
      const created = createInMemoryEntry(this.mount.contents, pathStr, {
        directory: (oflags & wasiShim.wasi.OFLAGS_DIRECTORY) === wasiShim.wasi.OFLAGS_DIRECTORY,
      });
      if (created !== wasiShim.wasi.ERRNO_SUCCESS) {
        return { ret: created, fd_obj: null };
      }
      entry = findEntryInDirectory(this.mount.contents, pathStr);
      if (!entry) return { ret: wasiShim.wasi.ERRNO_IO, fd_obj: null };
    } else if ((oflags & wasiShim.wasi.OFLAGS_EXCL) === wasiShim.wasi.OFLAGS_EXCL) {
      return { ret: wasiShim.wasi.ERRNO_EXIST, fd_obj: null };
    } else if (!this.mount.isWritablePath(guestPath) && requestsWriteRights(fsRightsBase, oflags)) {
      return { ret: wasiShim.wasi.ERRNO_PERM, fd_obj: null };
    }

    if (pathRequiresDirectory(pathStr, oflags) && !(entry instanceof wasiShim.Directory)) {
      return { ret: wasiShim.wasi.ERRNO_NOTDIR, fd_obj: null };
    }

    return entry.path_open(oflags, fsRightsBase, fdFlags);
  }

  path_create_directory(pathStr) {
    const pathRet = validateWasiRelativePath(pathStr);
    if (pathRet !== wasiShim.wasi.ERRNO_SUCCESS) return pathRet;

    if (pathIsDirectoryInDirectory(this.mount.contents, pathStr)) {
      return wasiShim.wasi.ERRNO_SUCCESS;
    }
    const guestPath = joinGuestPath(this.mount.mountPath, pathStr);
    if (!this.mount.isWritablePath(guestPath)) {
      return wasiShim.wasi.ERRNO_ROFS;
    }
    return createInMemoryEntry(this.mount.contents, pathStr, { directory: true });
  }

  path_link(pathStr, inode, _allowDir) {
    const pathRet = validateWasiRelativePath(pathStr);
    if (pathRet !== wasiShim.wasi.ERRNO_SUCCESS) return pathRet;

    const guestPath = joinGuestPath(this.mount.mountPath, pathStr);
    if (!this.mount.isWritablePath(guestPath)) {
      return wasiShim.wasi.ERRNO_ROFS;
    }
    return setEntryInDirectory(this.mount.contents, pathStr, inode);
  }

  path_unlink(pathStr) {
    const pathRet = validateWasiRelativePath(pathStr);
    if (pathRet !== wasiShim.wasi.ERRNO_SUCCESS) {
      return { ret: pathRet, inode_obj: null };
    }

    const guestPath = joinGuestPath(this.mount.mountPath, pathStr);
    if (!this.mount.isWritablePath(guestPath)) {
      return { ret: wasiShim.wasi.ERRNO_ROFS, inode_obj: null };
    }
    return unlinkEntryFromDirectory(this.mount.contents, pathStr);
  }

  path_unlink_file(pathStr) {
    const pathRet = validateWasiRelativePath(pathStr);
    if (pathRet !== wasiShim.wasi.ERRNO_SUCCESS) return pathRet;

    const entry = findEntryInDirectory(this.mount.contents, pathStr);
    if (!entry) return wasiShim.wasi.ERRNO_NOENT;
    if (entry instanceof wasiShim.Directory) return wasiShim.wasi.ERRNO_ISDIR;
    const { ret } = this.path_unlink(pathStr);
    return ret;
  }

  path_remove_directory(pathStr) {
    const pathRet = validateWasiRelativePath(pathStr);
    if (pathRet !== wasiShim.wasi.ERRNO_SUCCESS) return pathRet;

    const entry = findEntryInDirectory(this.mount.contents, pathStr);
    if (!(entry instanceof wasiShim.Directory)) return wasiShim.wasi.ERRNO_NOTDIR;
    if (entry.contents.size > 0) return wasiShim.wasi.ERRNO_NOTEMPTY;
    const { ret } = this.path_unlink(pathStr);
    return ret;
  }
}

class BrowserOpfsRandomAccessFile {
  constructor(syncHandle) {
    this.syncHandle = syncHandle;
    this.closed = false;
  }

  readAt(offset, dst) {
    return this.syncHandle.read(dst, { at: Number(offset) });
  }

  writeAt(offset, src) {
    return this.syncHandle.write(src, { at: Number(offset) });
  }

  size() {
    return this.syncHandle.getSize();
  }

  truncate(size) {
    this.syncHandle.truncate(Number(size));
  }

  flush() {
    this.syncHandle.flush();
  }

  close() {
    if (this.closed) return;
    try {
      this.flush();
    } finally {
      this.syncHandle.close();
      this.closed = true;
    }
  }
}

class WasiRandomAccessFileInode extends wasiShim.Inode {
  constructor(file, options = {}) {
    super();
    this.file = file;
    this.readonly = Boolean(options.readonly);
  }

  path_open(oflags, fsRightsBase, fdFlags) {
    if (this.readonly && requestsWriteRights(fsRightsBase, oflags)) {
      return { ret: wasiShim.wasi.ERRNO_PERM, fd_obj: null };
    }
    if ((oflags & wasiShim.wasi.OFLAGS_TRUNC) === wasiShim.wasi.OFLAGS_TRUNC) {
      if (this.readonly) return { ret: wasiShim.wasi.ERRNO_PERM, fd_obj: null };
      this.file.truncate(0);
    }
    const fd = new OpenWasiRandomAccessFile(this);
    if (fdFlags & wasiShim.wasi.FDFLAGS_APPEND) fd.fd_seek(0n, wasiShim.wasi.WHENCE_END);
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, fd_obj: fd };
  }

  get size() {
    return BigInt(this.file.size());
  }

  stat() {
    return new wasiShim.wasi.Filestat(this.ino, wasiShim.wasi.FILETYPE_REGULAR_FILE, this.size);
  }
}

class OpenWasiRandomAccessFile extends wasiShim.Fd {
  constructor(inode) {
    super();
    this.inode = inode;
    this.position = 0n;
  }

  fd_allocate(offset, len) {
    const requested = BigInt(offset) + BigInt(len);
    if (BigInt(this.inode.file.size()) < requested) {
      this.inode.file.truncate(Number(requested));
    }
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  fd_fdstat_get() {
    return {
      ret: wasiShim.wasi.ERRNO_SUCCESS,
      fdstat: new wasiShim.wasi.Fdstat(wasiShim.wasi.FILETYPE_REGULAR_FILE, 0),
    };
  }

  fd_filestat_get() {
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, filestat: this.inode.stat() };
  }

  fd_filestat_set_size(size) {
    if (this.inode.readonly) return wasiShim.wasi.ERRNO_BADF;
    this.inode.file.truncate(Number(size));
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  fd_read(size) {
    const buffer = new Uint8Array(size);
    const bytesRead = this.inode.file.readAt(this.position, buffer);
    this.position += BigInt(bytesRead);
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, data: buffer.slice(0, bytesRead) };
  }

  fd_pread(size, offset) {
    const buffer = new Uint8Array(size);
    const bytesRead = this.inode.file.readAt(offset, buffer);
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, data: buffer.slice(0, bytesRead) };
  }

  fd_seek(offset, whence) {
    let nextPosition;
    switch (whence) {
      case wasiShim.wasi.WHENCE_SET:
        nextPosition = BigInt(offset);
        break;
      case wasiShim.wasi.WHENCE_CUR:
        nextPosition = this.position + BigInt(offset);
        break;
      case wasiShim.wasi.WHENCE_END:
        nextPosition = BigInt(this.inode.file.size()) + BigInt(offset);
        break;
      default:
        return { ret: wasiShim.wasi.ERRNO_INVAL, offset: 0n };
    }
    if (nextPosition < 0n) return { ret: wasiShim.wasi.ERRNO_INVAL, offset: 0n };
    this.position = nextPosition;
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, offset: this.position };
  }

  fd_tell() {
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, offset: this.position };
  }

  fd_write(data) {
    if (this.inode.readonly) return { ret: wasiShim.wasi.ERRNO_BADF, nwritten: 0 };
    const bytesWritten = this.inode.file.writeAt(this.position, data);
    this.position += BigInt(bytesWritten);
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, nwritten: bytesWritten };
  }

  fd_pwrite(data, offset) {
    if (this.inode.readonly) return { ret: wasiShim.wasi.ERRNO_BADF, nwritten: 0 };
    const bytesWritten = this.inode.file.writeAt(offset, data);
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, nwritten: bytesWritten };
  }

  fd_sync() {
    this.inode.file.flush();
    return wasiShim.wasi.ERRNO_SUCCESS;
  }
}

async function buildOpfsInodeMap({
  closeables,
  directoryHandle,
  guestPath,
  syncAccessMode,
  writableRoots,
}) {
  const entries = new Map();

  for await (const [entryName, entryHandle] of directoryHandle.entries()) {
    const entryGuestPath = joinGuestPath(guestPath, entryName);
    if (entryHandle.kind === 'directory') {
      const nested = await buildOpfsInodeMap({
        closeables,
        directoryHandle: entryHandle,
        guestPath: entryGuestPath,
        syncAccessMode,
        writableRoots,
      });
      entries.set(entryName, new wasiShim.Directory(nested));
      continue;
    }

    if (entryHandle.kind !== 'file') continue;

    const writable = isGuestPathWithinRoots(entryGuestPath, writableRoots);
    const syncHandle = await openSyncAccessHandle({
      fileHandle: entryHandle,
      mode: writable ? syncAccessMode : 'read-only',
    });
    const file = new BrowserOpfsRandomAccessFile(syncHandle);
    closeables.push(file);
    entries.set(entryName, new WasiRandomAccessFileInode(file, { readonly: !writable }));
  }

  return entries;
}

async function flushBrowserOpfsMounts(mounts) {
  for (const mount of mounts) {
    await flushInMemoryEntriesToOpfs(mount.directoryHandle, mount.contents);
  }
}

async function flushInMemoryEntriesToOpfs(directoryHandle, entries) {
  for (const [name, entry] of entries) {
    if (entry instanceof WasiRandomAccessFileInode) continue;

    if (entry instanceof wasiShim.Directory) {
      const childHandle = await directoryHandle.getDirectoryHandle(name, { create: true });
      await flushInMemoryEntriesToOpfs(childHandle, entry.contents);
      continue;
    }

    if (entry instanceof wasiShim.File) {
      const fileHandle = await directoryHandle.getFileHandle(name, { create: true });
      await writeFileHandle(fileHandle, entry.data);
    }
  }
}

async function prepareKnownCliPaths({ args, mountHandles, runtimeMounts }) {
  const prepared = collectCliPreparedPaths(args);
  for (const entry of prepared) {
    const resolved = resolveMountedGuestPath(entry.path, mountHandles, runtimeMounts);
    if (!resolved) continue;
    if (entry.type === 'dir') {
      await ensureDirectoryPath(resolved.handle, resolved.relativeParts);
      continue;
    }
    await ensureFilePath(resolved.handle, resolved.relativeParts, { truncate: entry.truncate });
  }
}

function collectCliPreparedPaths(args) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] ?? '');
    if (arg === '--output') {
      const value = args[index + 1];
      if (typeof value === 'string') out.push({ path: value, truncate: true, type: 'file' });
      index += 1;
      continue;
    }
    if (arg.startsWith('--output=')) {
      out.push({ path: arg.slice('--output='.length), truncate: true, type: 'file' });
      continue;
    }
    if (arg === '--out-dir') {
      const value = args[index + 1];
      if (typeof value === 'string') out.push({ path: value, type: 'dir' });
      index += 1;
      continue;
    }
    if (arg.startsWith('--out-dir=')) {
      out.push({ path: arg.slice('--out-dir='.length), type: 'dir' });
    }
  }
  return out;
}

function resolveMountedGuestPath(path, mountHandles, runtimeMounts) {
  const normalizedPath = normalizeGuestPath(path, { label: 'prepared CLI path' });
  const sortedMounts = [...runtimeMounts].sort((a, b) => b.length - a.length);
  for (const mountPath of sortedMounts) {
    if (normalizedPath !== mountPath && !normalizedPath.startsWith(`${mountPath}/`)) continue;
    const handle = mountHandles[mountPath];
    if (!handle) return null;
    const relative = normalizedPath === mountPath ? '' : normalizedPath.slice(mountPath.length + 1);
    return {
      handle,
      mountPath,
      relativeParts: relative ? normalizeRelativePathParts(relative, { label: normalizedPath }) : [],
    };
  }
  return null;
}

function requestsWriteRights(fsRightsBase, oflags) {
  return (BigInt(fsRightsBase) & BigInt(wasiShim.wasi.RIGHTS_FD_WRITE)) === BigInt(wasiShim.wasi.RIGHTS_FD_WRITE)
    || (oflags & wasiShim.wasi.OFLAGS_TRUNC) === wasiShim.wasi.OFLAGS_TRUNC
    || (oflags & wasiShim.wasi.OFLAGS_CREAT) === wasiShim.wasi.OFLAGS_CREAT;
}

function pathExistsInDirectory(contents, pathStr) {
  return Boolean(findEntryInDirectory(contents, pathStr));
}

function pathIsDirectoryInDirectory(contents, pathStr) {
  const entry = findEntryInDirectory(contents, pathStr);
  return Boolean(entry && entry instanceof wasiShim.Directory);
}

function findEntryInDirectory(contents, pathStr) {
  if (!(contents instanceof Map)) return null;
  const parts = normalizeWasiRelativePathParts(pathStr);
  if (parts === null) return null;
  if (parts.length === 0) return new wasiShim.Directory(contents);

  let currentEntries = contents;
  let entry = null;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    entry = currentEntries.get(part) ?? null;
    if (!entry) return null;
    if (index === parts.length - 1) return entry;
    if (!(entry.contents instanceof Map)) return null;
    currentEntries = entry.contents;
  }
  return null;
}

function createInMemoryEntry(contents, pathStr, { directory }) {
  const parts = normalizeWasiRelativePathParts(pathStr);
  if (parts === null) return wasiShim.wasi.ERRNO_NOTCAPABLE;
  if (parts.length === 0) return wasiShim.wasi.ERRNO_EXIST;
  const parent = resolveParentDirectory(contents, parts);
  if (parent.ret !== wasiShim.wasi.ERRNO_SUCCESS) return parent.ret;
  if (parent.entries.has(parent.name)) return wasiShim.wasi.ERRNO_EXIST;
  parent.entries.set(
    parent.name,
    directory ? new wasiShim.Directory(new Map()) : new wasiShim.File(new Uint8Array()),
  );
  return wasiShim.wasi.ERRNO_SUCCESS;
}

function setEntryInDirectory(contents, pathStr, inode) {
  const parts = normalizeWasiRelativePathParts(pathStr);
  if (parts === null) return wasiShim.wasi.ERRNO_NOTCAPABLE;
  if (parts.length === 0) return wasiShim.wasi.ERRNO_INVAL;
  const parent = resolveParentDirectory(contents, parts);
  if (parent.ret !== wasiShim.wasi.ERRNO_SUCCESS) return parent.ret;
  const existing = parent.entries.get(parent.name) ?? null;
  if (existing && copyInodeContents(existing, inode)) {
    return wasiShim.wasi.ERRNO_SUCCESS;
  }
  parent.entries.set(parent.name, inode);
  return wasiShim.wasi.ERRNO_SUCCESS;
}

function copyInodeContents(target, source) {
  if (!(target instanceof WasiRandomAccessFileInode) || target.readonly) return false;
  const bytes = readInodeBytes(source);
  if (!bytes) return false;
  target.file.truncate(0);
  if (bytes.byteLength > 0) target.file.writeAt(0, bytes);
  target.file.flush();
  return true;
}

function readInodeBytes(inode) {
  if (inode instanceof wasiShim.File) {
    return inode.data instanceof Uint8Array ? inode.data : new Uint8Array(inode.data ?? []);
  }
  if (inode instanceof WasiRandomAccessFileInode) {
    const size = Number(inode.file.size());
    const bytes = new Uint8Array(size);
    if (size > 0) inode.file.readAt(0, bytes);
    return bytes;
  }
  return null;
}

function unlinkEntryFromDirectory(contents, pathStr) {
  const parts = normalizeWasiRelativePathParts(pathStr);
  if (parts === null) return { ret: wasiShim.wasi.ERRNO_NOTCAPABLE, inode_obj: null };
  if (parts.length === 0) return { ret: wasiShim.wasi.ERRNO_INVAL, inode_obj: null };
  const parent = resolveParentDirectory(contents, parts);
  if (parent.ret !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: parent.ret, inode_obj: null };
  const entry = parent.entries.get(parent.name) ?? null;
  if (!entry) return { ret: wasiShim.wasi.ERRNO_NOENT, inode_obj: null };
  parent.entries.delete(parent.name);
  return { ret: wasiShim.wasi.ERRNO_SUCCESS, inode_obj: entry };
}

function resolveParentDirectory(contents, parts) {
  let entries = contents;
  for (const part of parts.slice(0, -1)) {
    const entry = entries.get(part) ?? null;
    if (!entry) return { ret: wasiShim.wasi.ERRNO_NOENT, entries: null, name: null };
    if (!(entry.contents instanceof Map)) {
      return { ret: wasiShim.wasi.ERRNO_NOTDIR, entries: null, name: null };
    }
    entries = entry.contents;
  }
  return { ret: wasiShim.wasi.ERRNO_SUCCESS, entries, name: parts[parts.length - 1] };
}

function normalizeWasiRelativePathParts(pathStr) {
  const value = String(pathStr);
  if (value.startsWith('/') || value.includes('\0')) return null;
  const parts = [];
  for (const token of value.split('/')) {
    if (token === '' || token === '.') continue;
    if (token === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(token);
  }
  return parts;
}

function validateWasiRelativePath(pathStr) {
  const value = String(pathStr);
  if (value.startsWith('/')) return wasiShim.wasi.ERRNO_NOTCAPABLE;
  if (value.includes('\0')) return wasiShim.wasi.ERRNO_INVAL;

  const parts = [];
  for (const token of value.split('/')) {
    if (token === '' || token === '.') continue;
    if (token === '..') {
      if (parts.length === 0) return wasiShim.wasi.ERRNO_NOTCAPABLE;
      parts.pop();
      continue;
    }
    parts.push(token);
  }

  return wasiShim.wasi.ERRNO_SUCCESS;
}

function pathRequiresDirectory(pathStr, oflags) {
  return (oflags & wasiShim.wasi.OFLAGS_DIRECTORY) === wasiShim.wasi.OFLAGS_DIRECTORY
    || String(pathStr).endsWith('/');
}

function createOutputCollector(ConsoleStdout) {
  const chunks = [];
  return {
    chunks,
    fd: new ConsoleStdout((bytes) => {
      chunks.push(copyUint8Array(bytes));
    }),
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

async function openSyncAccessHandle({ fileHandle, mode }) {
  if (mode === undefined) return fileHandle.createSyncAccessHandle();
  try {
    return await fileHandle.createSyncAccessHandle({ mode });
  } catch (error) {
    if (mode === 'read-only') return fileHandle.createSyncAccessHandle();
    throw error;
  }
}

function closeSyncFiles(files) {
  for (const file of files) {
    try {
      file.close();
    } catch {
      // ignore best-effort close failures
    }
  }
}

async function verifyWritableOpfsRoot(rootHandle) {
  const probeName = `.rw-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const probeFile = await rootHandle.getFileHandle(probeName, { create: true });
  let accessHandle = null;
  try {
    accessHandle = await openSyncAccessHandle({ fileHandle: probeFile, mode: 'readwrite' });
    accessHandle.write(new Uint8Array([0x52, 0x57]), { at: 0 });
    accessHandle.flush();
  } catch (error) {
    throw new Error(`OPFS root is not writable with sync access handles: ${error}`);
  } finally {
    if (accessHandle) {
      try {
        accessHandle.close();
      } catch {
        // ignore best-effort close failures
      }
    }
    try {
      await rootHandle.removeEntry(probeName);
    } catch {
      // ignore best-effort cleanup failures
    }
  }
}

async function ensureDirectoryPath(rootHandle, relativeParts = []) {
  let current = rootHandle;
  for (const part of relativeParts) {
    current = await current.getDirectoryHandle(part, { create: true });
  }
  return current;
}

async function ensureFilePath(rootHandle, relativeParts, { truncate = false } = {}) {
  if (!Array.isArray(relativeParts) || relativeParts.length === 0) {
    throw new TypeError('file path must include a filename');
  }
  const fileName = relativeParts[relativeParts.length - 1];
  const parent = await ensureDirectoryPath(rootHandle, relativeParts.slice(0, -1));
  const fileHandle = await parent.getFileHandle(fileName, { create: true });
  if (truncate) await truncateFileHandle(fileHandle, 0);
  return fileHandle;
}

async function truncateFileHandle(fileHandle, size) {
  if (typeof fileHandle.createSyncAccessHandle === 'function') {
    const accessHandle = await openSyncAccessHandle({ fileHandle, mode: 'readwrite' });
    try {
      accessHandle.truncate(size);
      accessHandle.flush();
    } finally {
      accessHandle.close();
    }
    return;
  }
  const writable = await fileHandle.createWritable({ keepExistingData: true });
  try {
    await writable.truncate(size);
  } finally {
    await writable.close();
  }
}

async function writeFileHandle(fileHandle, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data ?? []);
  if (typeof fileHandle.createSyncAccessHandle === 'function') {
    const accessHandle = await openSyncAccessHandle({ fileHandle, mode: 'readwrite' });
    try {
      accessHandle.truncate(0);
      if (bytes.byteLength > 0) accessHandle.write(bytes, { at: 0 });
      accessHandle.truncate(bytes.byteLength);
      accessHandle.flush();
    } finally {
      accessHandle.close();
    }
    return;
  }

  const writable = await fileHandle.createWritable({ keepExistingData: false });
  try {
    await writable.write(bytes);
  } finally {
    await writable.close();
  }
}

function normalizeMountHandleMap({ mountHandles }) {
  const normalized = {};
  if (!mountHandles) return normalized;

  for (const [guestPath, handle] of Object.entries(mountHandles)) {
    const normalizedGuestPath = normalizeGuestPath(guestPath, {
      label: `mountHandles[${guestPath}]`,
    });
    assertDirectoryHandle(handle, `mountHandles[${guestPath}]`);
    normalized[normalizedGuestPath] = handle;
  }

  return normalized;
}

function normalizeWritableRoots({
  workGuestPath,
  writableDirectories,
  inherited,
}) {
  const roots = new Set(inherited ?? [workGuestPath]);
  for (const root of normalizeGuestPathList(writableDirectories, 'writableDirectories')) roots.add(root);
  return [...roots].sort((a, b) => a.localeCompare(b));
}

function normalizeGuestPathList(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of guest paths`);
  return value.map((entry) => normalizeGuestPath(String(entry), { label }));
}

function isGuestPathWithinRoots(path, roots) {
  const normalizedPath = normalizeGuestPath(path, { label: 'guest path' });
  for (const root of roots) {
    if (normalizedPath === root || normalizedPath.startsWith(`${root}/`)) return true;
  }
  return false;
}

function joinGuestPath(...parts) {
  const joined = parts
    .map((part, index) => {
      const value = String(part ?? '');
      if (index === 0) return value.replace(/\/+$/, '');
      return value.replace(/^\/+/, '').replace(/\/+$/, '');
    })
    .filter((part) => part.length > 0)
    .join('/');
  return normalizeGuestPath(joined.startsWith('/') ? joined : `/${joined}`, { label: 'guest path' });
}

function normalizeRelativePathParts(value, { label = 'relative path' } = {}) {
  const parts = String(value ?? '')
    .replace(/^\/+/, '')
    .split(PATH_SEPARATOR_REGEX)
    .filter((part) => part.length > 0);
  for (const part of parts) {
    if (part === '.' || part === '..' || part.includes('\0')) {
      throw new TypeError(`${label} contains an unsafe path segment`);
    }
  }
  return parts;
}

function assertDedicatedWorkerRuntime() {
  if (typeof navigator === 'undefined' || typeof self === 'undefined') {
    throw new Error('createRomWeaverBrowserOpfs can only run in a browser runtime');
  }

  if (typeof window !== 'undefined') {
    throw new Error(
      'createRomWeaverBrowserOpfs must run in a Dedicated Worker. '
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
  if (module instanceof WebAssembly.Module) return module;

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
  if (!Array.isArray(args)) throw new TypeError('args must be an array of strings');
  return args.map((value) => String(value));
}

function normalizeStdin(stdin) {
  if (stdin === undefined || stdin === null) return new Uint8Array();
  if (typeof stdin === 'string') return new TextEncoder().encode(stdin);
  if (stdin instanceof Uint8Array) return stdin;
  if (stdin instanceof ArrayBuffer) return new Uint8Array(stdin);
  throw new TypeError('stdin must be a string, Uint8Array, ArrayBuffer, or undefined');
}

function copyUint8Array(data) {
  const copied = new Uint8Array(data.byteLength);
  copied.set(data);
  return copied;
}
