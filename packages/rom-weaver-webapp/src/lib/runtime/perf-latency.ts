// Compare perceived drop-to-reply latency with WASM-reported command time.
//
// Worker clocks have a different time origin, so all measures use main-thread
// timestamps:
//   - romweaver:command:<type>     schedule() -> worker reply (round-trip wall)
//   - romweaver:wasm:<type>        reported elapsed, anchored at the reply
//   - romweaver:drop-to-done:<name>  file drop -> reply (what the user feels)

const MARK_PREFIX = "romweaver";

// Correlate drops FIFO by time because staging renames files and archive members.
// The first thread-capable command consumes the oldest pending drop; probe lists
// are not the work the user is waiting on.
const pendingDrops: { at: number; name: string }[] = [];
// Bound the queue so drops that never get consumed (e.g. a load that only ever
// runs non-thread-capable commands) cannot leak unboundedly.
const MAX_PENDING_DROPS = 16;

const hasPerformanceNow = (): boolean => typeof performance !== "undefined" && typeof performance.now === "function";

const canEmitUserTiming = (): boolean =>
  hasPerformanceNow() && typeof performance.measure === "function" && typeof performance.mark === "function";

/** Main-thread clock read, or 0 when unavailable. Use to stamp a command's submit time. */
export const perfNow = (): number => (hasPerformanceNow() ? performance.now() : 0);

/** Record when a file was dropped (or picked), so a later command can measure drop -> done. */
export const recordDrop = (fileName: string, atMs: number): void => {
  const name = fileName.trim();
  if (!(name && canEmitUserTiming())) return;
  pendingDrops.push({ at: atMs, name });
  if (pendingDrops.length > MAX_PENDING_DROPS) pendingDrops.shift();
  try {
    performance.mark(`${MARK_PREFIX}:drop`, { detail: { name }, startTime: atMs });
  } catch {
    // The `startTime`/`detail` mark option form is unsupported here; the
    // queue still drives the drop-to-done measure, so this is harmless.
  }
};

const measureBetween = (name: string, startMs: number, endMs: number, detail?: unknown): void => {
  if (!(canEmitUserTiming() && endMs >= startMs)) return;
  try {
    performance.measure(name, { detail, end: endMs, start: startMs });
  } catch {
    // The object form of `performance.measure` is unsupported here; skip.
  }
};

// Return an idempotent closer for one main-thread orchestration stage. No-op
// where User Timing is unavailable.
export const startStageSpan = (name: string, detail?: unknown): (() => void) => {
  if (!canEmitUserTiming()) return () => undefined;
  const startMs = perfNow();
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    measureBetween(`${MARK_PREFIX}:stage:${name}`, startMs, perfNow(), detail);
  };
};

const finiteNonNegative = (value: number | null | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * Emit the latency measures for one completed command. When the command is
 * thread-capable (the heavy work the user is waiting on), it also closes the
 * oldest pending drop into a drop-to-done measure and consumes it.
 */
export const recordCommandLatency = (args: {
  commandType: string;
  submittedAtMs: number;
  threadCapable: boolean;
  wasmElapsedMs?: number | null;
}): void => {
  if (!canEmitUserTiming()) return;
  const endMs = perfNow();
  const wallMs = Math.max(0, endMs - args.submittedAtMs);
  const wasmMs = finiteNonNegative(args.wasmElapsedMs);
  const overheadMs = wasmMs === undefined ? undefined : Math.max(0, wallMs - wasmMs);

  measureBetween(`${MARK_PREFIX}:command:${args.commandType}`, args.submittedAtMs, endMs, {
    commandType: args.commandType,
    overheadMs,
    wallMs,
    wasmElapsedMs: wasmMs,
  });

  if (wasmMs !== undefined) {
    measureBetween(`${MARK_PREFIX}:wasm:${args.commandType}`, Math.max(args.submittedAtMs, endMs - wasmMs), endMs, {
      commandType: args.commandType,
      wasmElapsedMs: wasmMs,
    });
  }

  // Only the heavy command closes the drop arc; probe `list`s before it are not
  // what the user dropped the file to do, so they leave the drop pending.
  if (!args.threadCapable || pendingDrops.length === 0) return;
  const drop = pendingDrops.shift();
  if (!drop) return;
  const perceivedMs = Math.max(0, endMs - drop.at);
  measureBetween(`${MARK_PREFIX}:drop-to-done:${drop.name}`, drop.at, endMs, {
    commandType: args.commandType,
    file: drop.name,
    overheadMs: wasmMs === undefined ? undefined : Math.max(0, perceivedMs - wasmMs),
    perceivedMs,
    // Time the file sat between drop and the command actually being submitted
    // (reads, archive probe, input staging, scheduler queueing).
    preCommandMs: Math.max(0, args.submittedAtMs - drop.at),
    wallMs,
    wasmElapsedMs: wasmMs,
  });
};
