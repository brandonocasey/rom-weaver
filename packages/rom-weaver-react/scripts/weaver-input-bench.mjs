import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

const BASE_URL = process.env.WEAVER_BASE_URL || 'https://localhost:5173/';
const NATIVE_BIN = process.env.WEAVER_NATIVE_BIN || 'target/release/rom-weaver';
const NATIVE_BIN_PATH = path.resolve(NATIVE_BIN);
const NATIVE_CWD = process.env.WEAVER_NATIVE_CWD || '/tmp/weaver-native-input-bench';
const RESULT_PATH = process.env.WEAVER_RESULT_PATH || '/tmp/weaver-input-bench-results.json';
const TARGET_DELTA_MS = Number(process.env.WEAVER_TARGET_DELTA_MS || 5000);
const THREADS = String(process.env.WEAVER_THREADS || 4);
const TRACE = process.env.WEAVER_TRACE === '1';
const TRACE_LIMIT = Number.parseInt(process.env.WEAVER_TRACE_LIMIT || '2000', 10);
const TRACE_TAIL = Number.parseInt(process.env.WEAVER_TRACE_TAIL || '160', 10);
const TRACE_DIR = String(process.env.WEAVER_TRACE_DIR || '').trim();
const SKIP_NATIVE = process.env.WEAVER_SKIP_NATIVE === '1';
const SKIP_BROWSER = process.env.WEAVER_SKIP_BROWSER === '1';
const BROWSER_PERF = process.env.WEAVER_BROWSER_PERF === '1';
const BROWSER_PERF_DIR = String(process.env.WEAVER_BROWSER_PERF_DIR || TRACE_DIR || '/tmp/weaver-browser-perf').trim();
const BROWSER_PERF_PARSE_MAX_BYTES = Number.parseInt(
  process.env.WEAVER_BROWSER_PERF_PARSE_MAX_BYTES || String(200 * 1024 * 1024),
  10,
);
const DEFAULT_BROWSER_PERF_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.stack',
  'blink.user_timing',
  'v8',
  'worker',
];
if (process.env.WEAVER_BROWSER_CPU_PROFILE === '1') {
  DEFAULT_BROWSER_PERF_CATEGORIES.push(
    'disabled-by-default-v8.cpu_profiler',
    'disabled-by-default-v8.cpu_profiler.hires',
  );
}
const BROWSER_PERF_CATEGORIES = String(
  process.env.WEAVER_BROWSER_PERF_CATEGORIES || DEFAULT_BROWSER_PERF_CATEGORIES.join(','),
).trim();

const cases = [
  {
    name: 'Pokemon Emerald raw GBA',
    rom: '/Users/bcasey/Downloads/weaver/Pokemon - Emerald Version (USA, Europe)/Pokemon - Emerald Version (USA, Europe).gba',
    timeoutMs: 120000,
  },
  {
    name: 'Pokemon Emerald ZIP',
    rom: '/Users/bcasey/Downloads/weaver/Pokemon - Emerald Version (USA, Europe)/Pokemon - Emerald Version (USA, Europe).zip',
    candidateIncludes: ['Pokemon - Emerald Version (USA, Europe).gba'],
    timeoutMs: 180000,
  },
  {
    name: 'Phantasy Star ZIP',
    rom: '/Users/bcasey/Downloads/weaver/Phantasy Star/Phantasy Star (Japan).zip',
    candidateIncludes: ['Phantasy Star (Japan).sms'],
    timeoutMs: 180000,
  },
  {
    name: 'New Light NES',
    rom: '/Users/bcasey/Downloads/weaver/New Light/Legend of Zelda, The (U) (PRG0) [!].nes',
    timeoutMs: 120000,
  },
  {
    name: 'Perils of the Dark NES',
    rom: '/Users/bcasey/Downloads/weaver/Perils of the dark/Legend of Zelda, The (U) (PRG0) [!].nes',
    timeoutMs: 120000,
  },
  {
    name: 'Crash Bandicoot CHD',
    rom: '/Users/bcasey/Downloads/weaver/Crash Bandicoot/Crash Bandicoot (USA).chd',
    nativeSelect: ['Crash Bandicoot (USA).bin'],
    timeoutMs: 480000,
  },
  {
    name: 'Luigi Mansion RVZ',
    rom: '/Users/bcasey/Downloads/weaver/Luigi’s Mansion/Luigi\'s Mansion (USA).rvz',
    timeoutMs: 480000,
  },
  {
    name: 'Kururin Squash 7z',
    rom: '/Users/bcasey/Downloads/weaver/Squash/Kururin Squash! (Japan).7z',
    timeoutMs: 720000,
  },
  {
    name: 'Star Fox 64 3D 7z',
    rom: '/Users/bcasey/Downloads/weaver/Star Fox 64 3D (USA) (En,Fr,Es) (Rev 3).7z',
    timeoutMs: 900000,
  },
];

const caseFilter = String(process.env.WEAVER_CASE_FILTER || '')
  .trim()
  .toLowerCase();
const caseFilterExact = String(process.env.WEAVER_CASE_FILTER_EXACT || '')
  .trim()
  .toLowerCase();
const selectedCases = caseFilterExact
  ? cases.filter((item) => item.name.toLowerCase() === caseFilterExact)
  : caseFilter
    ? cases.filter((item) => item.name.toLowerCase().includes(caseFilter))
    : cases;

if (!selectedCases.length) {
  throw new Error(`No input bench cases matched filter ${JSON.stringify(process.env.WEAVER_CASE_FILTER || '')}`);
}

for (const item of selectedCases) {
  if (!fs.existsSync(item.rom)) throw new Error(`Missing ROM fixture: ${item.rom}`);
}
if (!SKIP_NATIVE && !fs.existsSync(NATIVE_BIN_PATH)) {
  throw new Error(`Missing native binary: ${NATIVE_BIN}. Build it with: cargo build -p rom-weaver-cli --release`);
}

const now = () => new Date().toISOString();
const log = (...args) => console.log(now(), ...args);
const normalize = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
const safeFileName = (value) =>
  String(value || 'trace')
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'trace';
const roundMs = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);
const roundNumber = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);

const parseJsonLines = (text) =>
  String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

const summarizeNativeOutput = (stdout, stderr) => {
  const lines = parseJsonLines(`${stdout}\n${stderr}`);
  const terminal =
    [...lines].reverse().find((entry) => entry && (entry.status === 'succeeded' || entry.status === 'failed')) || null;
  return {
    label: typeof terminal?.label === 'string' ? terminal.label : '',
    status: typeof terminal?.status === 'string' ? terminal.status : '',
    terminal,
  };
};

const runNativeCase = (item) =>
  new Promise((resolve) => {
    const args = [
      '--json',
      '--no-progress',
      'checksum',
      item.rom,
      '--algo',
      'crc32',
      '--algo',
      'md5',
      '--algo',
      'sha1',
      '--threads',
      THREADS,
    ];
    for (const selection of item.nativeSelect || []) args.push('--select', selection);
    fs.mkdirSync(NATIVE_CWD, { recursive: true });
    const start = performance.now();
    const child = childProcess.spawn(NATIVE_BIN_PATH, args, {
      cwd: NATIVE_CWD,
      env: {
        ...process.env,
        PWD: NATIVE_CWD,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGTERM'), item.timeoutMs || 600000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      fs.rmSync(path.join(NATIVE_CWD, 'rom-weaver'), { force: true, recursive: true });
      const elapsedMs = performance.now() - start;
      const summary = summarizeNativeOutput(stdout, stderr);
      resolve({
        args,
        elapsedMs,
        error:
          code === 0 && !signal && summary.status !== 'failed'
            ? null
            : `native checksum failed code=${code} signal=${signal || ''}`,
        label: summary.label,
        ok: code === 0 && !signal && summary.status !== 'failed',
        status: summary.status,
        stderrTail: stderr.split(/\r?\n/).filter(Boolean).slice(-20),
        stdoutTail: stdout.split(/\r?\n/).filter(Boolean).slice(-20),
      });
    });
  });

const waitForUiReady = async (page) => {
  await page.waitForSelector('#rom-weaver-input-file-rom', { timeout: 30000 });
};

const clearOpfs = async (page) => {
  await page.evaluate(async () => {
    const storage = navigator.storage;
    if (!storage?.getDirectory) return;
    const root = await storage.getDirectory();
    const names = [];
    if (root.keys) {
      for await (const name of root.keys()) names.push(name);
    } else if (root.entries) {
      for await (const [name] of root.entries()) names.push(name);
    }
    for (const name of names) {
      await root.removeEntry(name, { recursive: true }).catch(() => undefined);
    }
  });
};

const setThreadsAndLogLevel = async (page) => {
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.waitForSelector('#settings-worker-threads', { timeout: 10000 });
  await page.fill('#settings-worker-threads', THREADS);
  const logLevel = page.locator('#settings-log-level');
  if (TRACE && (await logLevel.count())) {
    await logLevel.selectOption({ label: 'Trace' }).catch(() => undefined);
  }
  await page.click('#settings-save-close');
  await page.waitForTimeout(300);
};

const maybeResolveCandidateDialog = async (page, candidateIncludes) => {
  const dialog = page.locator('#rom-weaver-candidate-selection-dialog');
  if (!(await dialog.isVisible().catch(() => false))) return null;

  const buttons = dialog.locator('button');
  const count = await buttons.count();
  const options = [];
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    const text = ((await button.textContent()) || '').trim();
    if (!/^SELECT\s+/i.test(text)) continue;
    const ariaDescription = (await button.getAttribute('aria-description')) || '';
    const title = (await button.getAttribute('title')) || '';
    options.push({ index, label: `${ariaDescription} ${title} ${text}`.replace(/\s+/g, ' ').trim() || text });
  }
  if (!options.length) throw new Error('Candidate dialog opened with no SELECT options');

  const wanted = (candidateIncludes || []).map(normalize).filter(Boolean);
  let chosen = null;
  if (wanted.length) {
    chosen =
      options.find((option) => {
        const haystack = normalize(option.label);
        return wanted.some((needle) => haystack.includes(needle));
      }) || null;
  }
  if (!chosen) chosen = options[0];
  await buttons.nth(chosen.index).click();
  return { chosen: chosen.label, options: options.map((option) => option.label) };
};

const readInputState = async (page) =>
  page.evaluate(() => {
    const text = document.body?.innerText || '';
    const hasCrc = /\b[0-9a-f]{8}\b/i.test(text);
    const hasMd5 = /\b[0-9a-f]{32}\b/i.test(text);
    const hasSha1 = /\b[0-9a-f]{40}\b/i.test(text);
    const inputRows = Array.from(document.querySelectorAll('#rom-weaver-list-input-stack .rom-weaver-input-stack-file'));
    const busyText = /extracting\s|finalizing extracted output|preparing extraction|calculating checksums|checking checksum/i.test(
      text,
    );
    const errorRow = document.querySelector('#rom-weaver-row-error-message');
    const errorStyle = errorRow ? window.getComputedStyle(errorRow) : null;
    const errorText =
      errorRow && errorStyle?.display !== 'none' && errorStyle?.visibility !== 'hidden'
        ? (errorRow.textContent || '').trim()
        : '';
    return {
      busyText,
      checksumTiming: (document.querySelector('#rom-weaver-section-timing-checksum')?.textContent || '').trim(),
      errorText,
      hasChecksums: hasCrc && hasMd5 && hasSha1,
      inputTiming: (document.querySelector('#rom-weaver-section-timing-input')?.textContent || '').trim(),
      rows: inputRows.map((row) => (row.textContent || '').replace(/\s+/g, ' ').trim()),
    };
  });

const writeTraceFile = (item, traceLines) => {
  if (!TRACE_DIR) return null;
  fs.mkdirSync(TRACE_DIR, { recursive: true });
  const tracePath = path.join(TRACE_DIR, `${safeFileName(item.name)}.log`);
  fs.writeFileSync(tracePath, `${traceLines.join('\n')}\n`);
  return tracePath;
};

const TRACE_LINE_PREFIX_REGEX = /^(\d+(?:\.\d+)?)ms\s+(.*)$/;
const TRACE_SCOPE_REGEX = /\[(browser-opfs(?:-thread)?|browser-runner|runner-worker|wasi-thread-worker|worker-client)\]\s*(.*)$/;
const TRACE_TID_REGEX = /\btid=([^\s]+)/;
const TRACE_COMMAND_REGEX = /\bcommand=([^\s]+)/;
const DIRECT_IO_REGEX =
  /direct file io(?:\s+tid=[^\s]+)?\s+readCalls=(\d+)\s+readBytes=(\d+)\s+readMs=([0-9.]+)\s+readMiBps=([0-9.]+)\s+writeCalls=(\d+)\s+writeBytes=(\d+)\s+writeMs=([0-9.]+)\s+writeMiBps=([0-9.]+)/;
const FLUSH_WRITE_REGEX =
  /flush fd write buffers(?:\s+tid=[^\s]+)?\s+count=(\d+)\s+bytes=(\d+)\s+ms=([0-9.]+)\s+MiBps=([0-9.]+)/;
const TRACE_PHASE_PATTERNS = [
  { done: 'runJson done', key: 'runJson', start: 'runJson start' },
  { done: 'prepareKnownCliPaths done', key: 'prepareKnownCliPaths', start: 'prepareKnownCliPaths start' },
  { done: 'build wasi fds done', key: 'buildWasiFds', start: 'build wasi fds start' },
  { done: 'mount acquire done', key: 'mountAcquire', start: 'mount acquire start' },
  { done: 'mount startRun done', key: 'mountStartRun', start: 'mount startRun start' },
  { done: 'instantiate done', key: 'instantiate', start: 'instantiate start' },
  { done: 'thread spawner ready', key: 'threadSpawnerReady', start: 'thread spawner ready wait start' },
  { done: 'wasi.start returned', key: 'wasiStart', start: 'wasi.start start' },
  { done: 'wasi.start threw', key: 'wasiStart', start: 'wasi.start start' },
  { done: 'waitForWorkers done', key: 'waitForWorkers', start: 'waitForWorkers start' },
  { done: 'nested waitForWorkers done', key: 'nestedWaitForWorkers', start: 'nested waitForWorkers start' },
  { done: 'flush mounts done', key: 'flushMounts', start: 'flush mounts start' },
  { done: 'cleanup done', key: 'cleanup', start: 'cleanup start' },
  { done: 'thread pool command ready', key: 'threadPoolCommandCreate', start: 'thread pool command create' },
  { done: 'thread pool command shutdown done', key: 'threadPoolCommandShutdown', start: 'thread pool command shutdown start' },
  { done: 'thread wait done', key: 'threadWait', start: 'thread wait start' },
  { done: 'pool thread done', key: 'poolThread', start: 'pool thread start' },
  { done: 'single thread done', key: 'singleThread', start: 'single thread start' },
];

const parseTraceLineEvent = (line) => {
  const prefixed = String(line || '').match(TRACE_LINE_PREFIX_REGEX);
  if (!prefixed) return null;
  const elapsedMs = Number(prefixed[1]);
  const message = prefixed[2] || '';
  const scoped = message.match(TRACE_SCOPE_REGEX);
  return {
    elapsedMs,
    message,
    scope: scoped?.[1] || '',
    scopeMessage: scoped?.[2] || message,
  };
};

const parseTraceIdentity = (event) => {
  const tid = event.scopeMessage.match(TRACE_TID_REGEX)?.[1] || '';
  const command = event.scopeMessage.match(TRACE_COMMAND_REGEX)?.[1] || '';
  return [event.scope, tid ? `tid=${tid}` : '', command ? `command=${command}` : ''].filter(Boolean).join(':');
};

const addMetricTotals = (target, source) => {
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    target[key] = (target[key] || 0) + value;
  }
};

const parseNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const summarizeBrowserTraceLines = (traceLines) => {
  const activePhases = new Map();
  const phases = [];
  const directIo = [];
  const flushes = [];
  const directIoTotal = {
    readBytes: 0,
    readCalls: 0,
    readMs: 0,
    writeBytes: 0,
    writeCalls: 0,
    writeMs: 0,
  };
  const flushWriteTotal = {
    bytes: 0,
    count: 0,
    ms: 0,
  };
  const threadEvents = {
    completed: 0,
    poolCommands: 0,
    spawnAcked: 0,
    spawnDispatched: 0,
    spawnRequested: 0,
  };

  for (const line of traceLines) {
    const event = parseTraceLineEvent(line);
    if (!event) continue;
    const directMatch = event.scopeMessage.match(DIRECT_IO_REGEX);
    if (directMatch) {
      const item = {
        readBytes: parseNumber(directMatch[2]),
        readCalls: parseNumber(directMatch[1]),
        readMiBps: parseNumber(directMatch[4]),
        readMs: parseNumber(directMatch[3]),
        scope: event.scope,
        writeBytes: parseNumber(directMatch[6]),
        writeCalls: parseNumber(directMatch[5]),
        writeMiBps: parseNumber(directMatch[8]),
        writeMs: parseNumber(directMatch[7]),
      };
      directIo.push(item);
      addMetricTotals(directIoTotal, item);
    }

    const flushMatch = event.scopeMessage.match(FLUSH_WRITE_REGEX);
    if (flushMatch) {
      const item = {
        bytes: parseNumber(flushMatch[2]),
        count: parseNumber(flushMatch[1]),
        MiBps: parseNumber(flushMatch[4]),
        ms: parseNumber(flushMatch[3]),
        scope: event.scope,
      };
      flushes.push(item);
      addMetricTotals(flushWriteTotal, item);
    }

    if (event.scopeMessage.includes('thread spawn requested')) threadEvents.spawnRequested += 1;
    if (event.scopeMessage.includes('thread spawn dispatched')) threadEvents.spawnDispatched += 1;
    if (event.scopeMessage.includes('thread spawn acked')) threadEvents.spawnAcked += 1;
    if (event.scopeMessage.includes('thread completed')) threadEvents.completed += 1;
    if (event.scopeMessage.includes('thread pool command create')) threadEvents.poolCommands += 1;

    for (const pattern of TRACE_PHASE_PATTERNS) {
      if (event.scopeMessage.includes(pattern.start)) {
        const identity = parseTraceIdentity(event);
        activePhases.set(`${pattern.key}:${identity}`, {
          identity,
          key: pattern.key,
          scope: event.scope,
          startMs: event.elapsedMs,
          startMessage: event.scopeMessage,
        });
      }
      if (!event.scopeMessage.includes(pattern.done)) continue;
      const identity = parseTraceIdentity(event);
      const phaseKey = `${pattern.key}:${identity}`;
      const start = activePhases.get(phaseKey);
      if (!start) continue;
      activePhases.delete(phaseKey);
      phases.push({
        durationMs: roundMs(event.elapsedMs - start.startMs),
        identity: start.identity,
        key: pattern.key,
        scope: start.scope,
      });
    }
  }

  directIoTotal.readMs = roundMs(directIoTotal.readMs) || 0;
  directIoTotal.writeMs = roundMs(directIoTotal.writeMs) || 0;
  directIoTotal.readMiBps = roundNumber((directIoTotal.readBytes / 1048576) / (directIoTotal.readMs / 1000)) || 0;
  directIoTotal.writeMiBps = roundNumber((directIoTotal.writeBytes / 1048576) / (directIoTotal.writeMs / 1000)) || 0;
  flushWriteTotal.ms = roundMs(flushWriteTotal.ms) || 0;
  flushWriteTotal.MiBps = roundNumber((flushWriteTotal.bytes / 1048576) / (flushWriteTotal.ms / 1000)) || 0;

  return {
    directIo,
    directIoTotal,
    flushes,
    flushWriteTotal,
    lineCount: traceLines.length,
    phases: phases
      .filter((phase) => phase.durationMs !== null)
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 40),
    threadEvents,
  };
};

const summarizeChromeTraceContent = (content) => {
  if (!content) return null;
  const payload = JSON.parse(content);
  const events = Array.isArray(payload) ? payload : Array.isArray(payload?.traceEvents) ? payload.traceEvents : [];
  const threadNames = new Map();
  for (const event of events) {
    if (event?.ph !== 'M' || event.name !== 'thread_name') continue;
    const key = `${event.pid}:${event.tid}`;
    const name = typeof event.args?.name === 'string' ? event.args.name : '';
    if (name) threadNames.set(key, name);
  }

  const byName = new Map();
  const byThread = new Map();
  let completeEventCount = 0;
  for (const event of events) {
    if (event?.ph !== 'X' || !(event.dur > 0)) continue;
    completeEventCount += 1;
    const durationMs = event.dur / 1000;
    const name = String(event.name || 'unnamed');
    const currentName = byName.get(name) || { calls: 0, maxMs: 0, name, totalMs: 0 };
    currentName.calls += 1;
    currentName.maxMs = Math.max(currentName.maxMs, durationMs);
    currentName.totalMs += durationMs;
    byName.set(name, currentName);

    const threadKey = `${event.pid}:${event.tid}`;
    const threadName = threadNames.get(threadKey) || threadKey;
    const currentThread = byThread.get(threadKey) || { calls: 0, maxMs: 0, thread: threadName, totalMs: 0 };
    currentThread.calls += 1;
    currentThread.maxMs = Math.max(currentThread.maxMs, durationMs);
    currentThread.totalMs += durationMs;
    byThread.set(threadKey, currentThread);
  }

  const finalize = (entry) => ({
    ...entry,
    maxMs: roundMs(entry.maxMs),
    totalMs: roundMs(entry.totalMs),
  });

  return {
    completeEventCount,
    eventCount: events.length,
    topCompleteEvents: [...byName.values()]
      .map(finalize)
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 20),
    topThreads: [...byThread.values()]
      .map(finalize)
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 20),
  };
};

const readCdpTraceStream = async (session, streamHandle, tracePath) => {
  let totalBytes = 0;
  let content = '';
  const fd = fs.openSync(tracePath, 'w');
  try {
    for (;;) {
      const chunk = await session.send('IO.read', { handle: streamHandle });
      const data = chunk.base64Encoded ? Buffer.from(chunk.data || '', 'base64') : String(chunk.data || '');
      const byteLength = Buffer.isBuffer(data) ? data.byteLength : Buffer.byteLength(data);
      if (byteLength > 0) {
        fs.writeSync(fd, data);
        if (content !== null && totalBytes + byteLength <= BROWSER_PERF_PARSE_MAX_BYTES) {
          content += Buffer.isBuffer(data) ? data.toString('utf8') : data;
        } else {
          content = null;
        }
        totalBytes += byteLength;
      }
      if (chunk.eof) break;
    }
  } finally {
    fs.closeSync(fd);
    await session.send('IO.close', { handle: streamHandle }).catch(() => undefined);
  }
  return { content, totalBytes };
};

const startBrowserPerformanceCapture = async (browser, context, page, item) => {
  if (!BROWSER_PERF) return null;
  fs.mkdirSync(BROWSER_PERF_DIR, { recursive: true });
  const tracePath = path.join(BROWSER_PERF_DIR, `${safeFileName(item.name)}.trace.json`);
  const session =
    typeof browser.newBrowserCDPSession === 'function'
      ? await browser.newBrowserCDPSession()
      : await context.newCDPSession(page);
  let stopped = false;
  let tracingComplete;
  const tracingCompletePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for Chrome tracingComplete')), 30000);
    tracingComplete = (event) => {
      clearTimeout(timeout);
      resolve(event);
    };
    session.on('Tracing.tracingComplete', tracingComplete);
  });
  await session.send('Tracing.start', {
    categories: BROWSER_PERF_CATEGORIES,
    options: 'record-as-much-as-possible',
    transferMode: 'ReturnAsStream',
  });
  return {
    async stop() {
      if (stopped) return null;
      stopped = true;
      await session.send('Tracing.end');
      const complete = await tracingCompletePromise;
      if (tracingComplete && typeof session.off === 'function') {
        session.off('Tracing.tracingComplete', tracingComplete);
      }
      if (!complete?.stream) throw new Error('Chrome tracing did not return a stream handle');
      const { content, totalBytes } = await readCdpTraceStream(session, complete.stream, tracePath);
      await session.detach?.().catch(() => undefined);
      let summary = null;
      let summaryError = null;
      if (content !== null) {
        try {
          summary = summarizeChromeTraceContent(content);
        } catch (error) {
          summaryError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }
      }
      return {
        bytes: totalBytes,
        categories: BROWSER_PERF_CATEGORIES,
        parseSkipped: content === null,
        path: tracePath,
        summary,
        summaryError,
      };
    },
  };
};

const stopBrowserPerformanceCapture = async (capture) => {
  if (!capture) return null;
  try {
    return await capture.stop();
  } catch (error) {
    return {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
};

const waitForInputChecksums = async (page, item) => {
  const deadline = Date.now() + (item.timeoutMs || 600000);
  let candidate = null;
  while (Date.now() < deadline) {
    const resolved = await maybeResolveCandidateDialog(page, item.candidateIncludes);
    if (resolved) {
      candidate = resolved;
      await page.waitForTimeout(200);
      continue;
    }
    const state = await readInputState(page);
    if (state.errorText) throw new Error(state.errorText);
    if (state.rows.length > 0 && state.hasChecksums && !state.busyText) {
      await page.waitForTimeout(250);
      const lateResolved = await maybeResolveCandidateDialog(page, item.candidateIncludes);
      if (lateResolved) {
        candidate = lateResolved;
        await page.waitForTimeout(200);
        continue;
      }
      return { candidate, state: await readInputState(page) };
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for input checksums after ${item.timeoutMs || 600000}ms`);
};

const runBrowserCase = async (browser, item) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const traceLines = [];
  const traceStart = performance.now();
  let performanceCapture = null;
  let performanceTrace = null;
  page.on('console', (message) => {
    const text = message.text();
    if (!/runJson|workflow:input|workflow:apply|input-decompression|browser-runtime-vfs|browser-opfs|browser-runner|runner-worker|wasi-thread-worker|worker-client/i.test(text)) {
      return;
    }
    traceLines.push(`${Math.round(performance.now() - traceStart)}ms ${text}`);
    if (TRACE_LIMIT > 0 && traceLines.length > TRACE_LIMIT) traceLines.shift();
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await waitForUiReady(page);
    await setThreadsAndLogLevel(page);
    await clearOpfs(page);
    performanceCapture = await startBrowserPerformanceCapture(browser, context, page, item).catch((error) => ({
      async stop() {
        return {
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        };
      },
    }));
    const start = performance.now();
    await page.setInputFiles('#rom-weaver-input-file-rom', item.rom);
    const { candidate, state } = await waitForInputChecksums(page, item);
    const elapsedMs = performance.now() - start;
    performanceTrace = await stopBrowserPerformanceCapture(performanceCapture);
    const tracePath = writeTraceFile(item, traceLines);
    await clearOpfs(page).catch(() => undefined);
    return {
      browserTraceSummary: summarizeBrowserTraceLines(traceLines),
      candidateChosen: candidate?.chosen || null,
      checksumTiming: state.checksumTiming,
      elapsedMs,
      inputTiming: state.inputTiming,
      ok: true,
      performanceTrace,
      rows: state.rows,
      tracePath,
      traceTail: traceLines.slice(-Math.max(1, TRACE_TAIL || 160)),
    };
  } catch (error) {
    performanceTrace = await stopBrowserPerformanceCapture(performanceCapture);
    const tracePath = writeTraceFile(item, traceLines);
    return {
      browserTraceSummary: summarizeBrowserTraceLines(traceLines),
      elapsedMs: null,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      ok: false,
      performanceTrace,
      tracePath,
      traceTail: traceLines.slice(-Math.max(1, TRACE_TAIL || 160)),
    };
  } finally {
    await context.close().catch(() => undefined);
  }
};

const results = [];
let browser = null;
if (!SKIP_BROWSER) browser = await chromium.launch({ headless: true });

try {
  for (const item of selectedCases) {
    const result = { case: item.name, rom: item.rom };
    log(`[${item.name}] start`);
    if (!SKIP_NATIVE) {
      log(`[${item.name}] native checksum`);
      result.native = await runNativeCase(item);
      log(
        `[${item.name}] native ${result.native.ok ? 'OK' : 'FAIL'}`,
        result.native.elapsedMs === null ? '' : `${Math.round(result.native.elapsedMs)}ms`,
      );
    }
    if (!SKIP_BROWSER) {
      log(`[${item.name}] browser input`);
      result.browser = await runBrowserCase(browser, item);
      log(
        `[${item.name}] browser ${result.browser.ok ? 'OK' : 'FAIL'}`,
        result.browser.elapsedMs === null ? '' : `${Math.round(result.browser.elapsedMs)}ms`,
      );
    }
    if (result.native?.ok && result.browser?.ok) {
      result.deltaMs = result.browser.elapsedMs - result.native.elapsedMs;
      result.withinTarget = result.deltaMs <= TARGET_DELTA_MS;
      log(
        `[${item.name}] delta`,
        `${Math.round(result.deltaMs)}ms`,
        result.withinTarget ? 'within target' : 'over target',
      );
    }
    results.push(result);
    fs.writeFileSync(
      RESULT_PATH,
      JSON.stringify(
        {
          baseUrl: BASE_URL,
          generatedAt: now(),
          targetDeltaMs: TARGET_DELTA_MS,
          threads: THREADS,
          cases: results,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await browser?.close().catch(() => undefined);
}

const payload = {
  baseUrl: BASE_URL,
  generatedAt: now(),
  targetDeltaMs: TARGET_DELTA_MS,
  threads: THREADS,
  cases: results,
};
fs.writeFileSync(RESULT_PATH, JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
