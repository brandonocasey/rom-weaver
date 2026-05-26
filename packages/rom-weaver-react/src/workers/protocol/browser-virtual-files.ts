type BrowserVirtualFileSource = Blob | Uint8Array | ArrayBuffer;

type BrowserVirtualFileSlot = {
  controlBuffer: SharedArrayBuffer;
  dataBuffer: SharedArrayBuffer;
};

type BrowserVirtualFileProxy = {
  id: string;
  maxChunkSize: number;
  size: number;
  slots: BrowserVirtualFileSlot[];
};

type BrowserVirtualFile = {
  path: string;
  proxy: BrowserVirtualFileProxy;
};

const activeVirtualFiles = new Map<string, BrowserVirtualFile>();
const VIRTUAL_FILE_CHUNK_SIZE = 2 * 1024 * 1024;
const VIRTUAL_FILE_SLOT_COUNT = 8;
const CONTROL_STATE_INDEX = 0;
const CONTROL_OFFSET_LOW_INDEX = 1;
const CONTROL_OFFSET_HIGH_INDEX = 2;
const CONTROL_LENGTH_INDEX = 3;
const CONTROL_BYTES_READ_INDEX = 4;
const CONTROL_STATUS_INDEX = 5;
const CONTROL_LENGTH = 6;
const CONTROL_STATE_REQUESTED = 1;
const CONTROL_STATE_DONE = 2;
const CONTROL_STATE_READING = 3;
const CONTROL_STATUS_ERROR = 1;
const CONTROL_STATUS_OK = 0;
let virtualFileId = 0;

const getVirtualSourceSize = (source: BrowserVirtualFileSource) =>
  source instanceof Uint8Array || source instanceof ArrayBuffer ? source.byteLength : source.size;

const registerBrowserVirtualFile = ({
  path,
  source,
}: {
  path: string;
  source: BrowserVirtualFileSource;
}): (() => void) => {
  if (typeof SharedArrayBuffer !== "function") {
    throw new Error("Direct browser file inputs require SharedArrayBuffer support");
  }
  const id = `virtual-file-${++virtualFileId}-${Math.random().toString(16).slice(2)}`;
  const slots = Array.from({ length: VIRTUAL_FILE_SLOT_COUNT }, () => ({
    controlBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * CONTROL_LENGTH),
    dataBuffer: new SharedArrayBuffer(VIRTUAL_FILE_CHUNK_SIZE),
  }));
  const file: BrowserVirtualFile = {
    path,
    proxy: {
      id,
      maxChunkSize: VIRTUAL_FILE_CHUNK_SIZE,
      size: getVirtualSourceSize(source),
      slots,
    },
  };
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pump = () => {
    if (closed) return;
    for (const slot of slots) handleVirtualFileSlot(source, slot);
    timer = setTimeout(pump, 0);
  };
  pump();
  activeVirtualFiles.set(path, file);
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (activeVirtualFiles.get(path) === file) activeVirtualFiles.delete(path);
  };
};

const getActiveBrowserVirtualFiles = (): BrowserVirtualFile[] =>
  Array.from(activeVirtualFiles.values()).map((file) => ({ ...file }));

const handleVirtualFileSlot = (source: BrowserVirtualFileSource, slot: BrowserVirtualFileSlot): void => {
  const control = new Int32Array(slot.controlBuffer);
  if (
    Atomics.compareExchange(control, CONTROL_STATE_INDEX, CONTROL_STATE_REQUESTED, CONTROL_STATE_READING) !==
    CONTROL_STATE_REQUESTED
  )
    return;
  const data = new Uint8Array(slot.dataBuffer);
  void respondToVirtualFileRead(source, control, data);
};

const respondToVirtualFileRead = async (
  source: BrowserVirtualFileSource,
  control: Int32Array,
  data: Uint8Array,
): Promise<void> => {
  try {
    const offset =
      (Atomics.load(control, CONTROL_OFFSET_LOW_INDEX) >>> 0) +
      (Atomics.load(control, CONTROL_OFFSET_HIGH_INDEX) >>> 0) * 2 ** 32;
    const length = Math.max(0, Math.min(Atomics.load(control, CONTROL_LENGTH_INDEX), data.byteLength));
    const bytes = await readVirtualSource(source, offset, length);
    data.set(bytes.subarray(0, length));
    Atomics.store(control, CONTROL_BYTES_READ_INDEX, Math.min(bytes.byteLength, length));
    Atomics.store(control, CONTROL_STATUS_INDEX, CONTROL_STATUS_OK);
  } catch (_error) {
    Atomics.store(control, CONTROL_BYTES_READ_INDEX, 0);
    Atomics.store(control, CONTROL_STATUS_INDEX, CONTROL_STATUS_ERROR);
  } finally {
    Atomics.store(control, CONTROL_STATE_INDEX, CONTROL_STATE_DONE);
    Atomics.notify(control, CONTROL_STATE_INDEX, 1);
  }
};

const readVirtualSource = async (
  source: BrowserVirtualFileSource,
  offset: number,
  length: number,
): Promise<Uint8Array> => {
  if (length <= 0) return new Uint8Array();
  if (source instanceof Uint8Array) return source.subarray(offset, offset + length);
  if (source instanceof ArrayBuffer)
    return new Uint8Array(source, offset, Math.min(length, source.byteLength - offset));
  return new Uint8Array(await source.slice(offset, offset + length).arrayBuffer());
};

export type { BrowserVirtualFile };
export { getActiveBrowserVirtualFiles, registerBrowserVirtualFile };
