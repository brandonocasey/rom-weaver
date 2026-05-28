import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE_URL = 'https://localhost:5173/';

const cases = [
  {
    name: 'Pokemon Rowe (zip+zip)',
    rom: '/Users/bcasey/Downloads/weaver/Pokemon - Emerald Version (USA, Europe)/Pokemon - Emerald Version (USA, Europe).zip',
    patch: '/Users/bcasey/Downloads/weaver/Pokemon - Emerald Version (USA, Europe)/pkmn_rowe.bps.zip',
    candidateIncludes: ['pkmn_rowe.bps'],
    outputLabel: 'ZIP',
    applyTimeoutMs: 180000,
  },
  {
    name: 'Phantasy Star EN',
    rom: '/Users/bcasey/Downloads/weaver/Phantasy Star/Phantasy Star (Japan).zip',
    patch: '/Users/bcasey/Downloads/weaver/Phantasy Star/PhantasyStar-SMS-EN-2.6.1.zip',
    candidateIncludes: ['ps1jert.en.ips'],
    outputLabel: 'ZIP',
    applyTimeoutMs: 180000,
  },
  {
    name: 'Phantasy Star Classic Names',
    rom: '/Users/bcasey/Downloads/weaver/Phantasy Star/Phantasy Star (Japan).zip',
    patch: '/Users/bcasey/Downloads/weaver/Phantasy Star/PS_ClassicNames_v231CN1.zip',
    candidateIncludes: ['ps_classicnames_v231cn1.ips'],
    outputLabel: 'ZIP',
    applyTimeoutMs: 180000,
  },
  {
    name: 'New Light',
    rom: '/Users/bcasey/Downloads/weaver/New Light/Legend of Zelda, The (U) (PRG0) [!].nes',
    patch: '/Users/bcasey/Downloads/weaver/New Light/Zelda - A New Light 3.5.1.zip',
    candidateIncludes: ['zelda - a new light 3.5.1.ips'],
    outputLabel: 'ZIP',
    applyTimeoutMs: 180000,
  },
  {
    name: 'Perils of the Dark',
    rom: '/Users/bcasey/Downloads/weaver/Perils of the dark/Legend of Zelda, The (U) (PRG0) [!].nes',
    patch: '/Users/bcasey/Downloads/weaver/Perils of the dark/TLoZ-PerilsofDarkness v2-0 TRUE.zip',
    candidateIncludes: ['(normal)tloz-perilsofdarkness v2-0 true.ips'],
    outputLabel: 'ZIP',
    applyTimeoutMs: 180000,
  },
  {
    name: 'Crash QoL USA',
    rom: '/Users/bcasey/Downloads/weaver/Crash Bandicoot/Crash Bandicoot (USA).chd',
    patch: '/Users/bcasey/Downloads/weaver/Crash Bandicoot/Crash-QOL.7z',
    candidateIncludes: ['crash bandicoot (usa)/quality of life.ppf'],
    outputLabel: 'ZIP',
    applyTimeoutMs: 480000,
  },
  {
    name: 'Luigi Premium Deluxe',
    rom: '/Users/bcasey/Downloads/weaver/Luigi’s Mansion/Luigi\'s Mansion (USA).rvz',
    patch: '/Users/bcasey/Downloads/weaver/Luigi’s Mansion/luigi_s_mansion_premium_deluxe_v2-2-1.zip',
    candidateIncludes: ['luigi\'s mansion premium deluxe 2.2.1.xdelta'],
    outputLabel: 'ZIP',
    applyTimeoutMs: 480000,
  },
  {
    name: 'Kururin Squash',
    rom: '/Users/bcasey/Downloads/weaver/Squash/Kururin Squash! (Japan).7z',
    patch: '/Users/bcasey/Downloads/weaver/Squash/Kururin.Squash.Translation.v2.0.1.xdelta',
    candidateIncludes: null,
    outputLabel: 'ZIP',
    applyTimeoutMs: 720000,
  },
  {
    name: 'Star Fox 64 3D + New Light IPS',
    rom: '/Users/bcasey/Downloads/weaver/Star Fox 64 3D (USA) (En,Fr,Es) (Rev 3).7z',
    patch: '/Users/bcasey/Downloads/weaver/New Light/Zelda - A New Light 3.5.1.zip',
    candidateIncludes: ['zelda - a new light 3.5.1.ips'],
    outputLabel: 'ZIP',
    applyTimeoutMs: 780000,
  },
];

const caseFilter = String(process.env.WEAVER_CASE_FILTER || "")
  .trim()
  .toLowerCase();
const caseFilterExact = String(process.env.WEAVER_CASE_FILTER_EXACT || "")
  .trim()
  .toLowerCase();
const applyTimeoutOverride = Number(process.env.WEAVER_APPLY_TIMEOUT_MS || 0);
const selectedCases = caseFilterExact
  ? cases.filter((c) => c.name.toLowerCase() === caseFilterExact)
  : caseFilter
    ? cases.filter((c) => c.name.toLowerCase().includes(caseFilter))
    : cases;

if (!selectedCases.length) {
  throw new Error(`No sweep cases matched WEAVER_CASE_FILTER=${JSON.stringify(process.env.WEAVER_CASE_FILTER || "")}`);
}

for (const c of selectedCases) {
  if (!fs.existsSync(c.rom)) throw new Error(`Missing ROM fixture: ${c.rom}`);
  if (!fs.existsSync(c.patch)) throw new Error(`Missing patch fixture: ${c.patch}`);
}

const now = () => new Date().toISOString();
const log = (...args) => console.log(now(), ...args);

const normalize = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

const waitForUiReady = async (page) => {
  await page.waitForSelector('#rom-weaver-input-file-rom', { timeout: 30000 });
  await page.waitForSelector('#rom-weaver-input-file-patch', { timeout: 30000 });
};

const listOpfsPaths = async (page, maxEntries = 512) =>
  page.evaluate(async (limit) => {
    const storage = navigator.storage;
    if (!storage || !storage.getDirectory) return [];
    const root = await storage.getDirectory();
    const out = [];
    let count = 0;
    const walk = async (dir, prefix) => {
      if (!dir?.entries) return;
      for await (const [name, handle] of dir.entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        out.push(path + (handle?.kind === "directory" ? "/" : ""));
        count += 1;
        if (count >= limit) return;
        if (handle?.kind === "directory") {
          await walk(handle, path);
          if (count >= limit) return;
        }
      }
    };
    await walk(root, "");
    return out;
  }, maxEntries);

const readOpfsFileMetadata = async (page, path) =>
  page.evaluate(async (targetPath) => {
    const storage = navigator.storage;
    if (!storage || !storage.getDirectory) return null;
    const root = await storage.getDirectory();
    const parts = String(targetPath || "").split("/").filter(Boolean);
    if (!parts.length) return null;
    let current = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (!part) return null;
      current = await current.getDirectoryHandle(part, { create: false }).catch(() => null);
      if (!current) return null;
    }
    const name = parts[parts.length - 1];
    if (!name) return null;
    const fileHandle = await current.getFileHandle(name, { create: false }).catch(() => null);
    if (!fileHandle) return null;
    const file = await fileHandle.getFile().catch(() => null);
    if (!file) return null;
    const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    const ascii = new TextDecoder().decode(header);
    return {
      headerHex: Array.from(header).map((value) => value.toString(16).padStart(2, "0")).join(""),
      headerText: ascii,
      size: file.size,
    };
  }, path);

const clearOpfs = async (page) => {
  await page.evaluate(async () => {
    const storage = navigator.storage;
    if (!storage || !storage.getDirectory) return;
    const root = await storage.getDirectory();
    const names = [];
    if (root.keys) {
      for await (const name of root.keys()) names.push(name);
    } else if (root.entries) {
      for await (const [name] of root.entries()) names.push(name);
    }
    for (const name of names) {
      try {
        await root.removeEntry(name, { recursive: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });
};

const setThreadsToFourTrace = async (page) => {
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.waitForSelector('#settings-worker-threads', { timeout: 10000 });
  await page.fill('#settings-worker-threads', '4');
  const logLevel = page.locator('#settings-log-level');
  if (await logLevel.count()) {
    await logLevel.selectOption({ label: 'Trace' }).catch(() => undefined);
  }
  await page.click('#settings-save-close');
  await page.waitForTimeout(300);
};

const selectOutputFormat = async (page, label) => {
  const select = page.locator('#rom-weaver-select-output-format');
  await select.waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('#rom-weaver-select-output-format');
    return el instanceof HTMLSelectElement && !el.disabled;
  }, null, { timeout: 120000 });
  await select.selectOption({ label });
};

const waitForRomChecksum = async (page, timeout = 420000) => {
  await page.waitForFunction(() => {
    const text = document.body?.innerText || '';
    const hasCrc = /\b[0-9a-f]{8}\b/i.test(text);
    const hasMd5 = /\b[0-9a-f]{32}\b/i.test(text);
    const hasSha1 = /\b[0-9a-f]{40}\b/i.test(text);
    const hasRomRow = !!document.querySelector('#rom-weaver-list-input-stack .rom-weaver-input-stack-file');
    const busyText = /extracting\s|finalizing extracted output|preparing extraction|preparing patch|calculating checksums/i.test(text);
    return hasRomRow && hasCrc && hasMd5 && hasSha1 && !busyText;
  }, null, { timeout });
};

const maybeResolvePatchCandidateDialog = async (page, candidateIncludes) => {
  const dialog = page.locator('#rom-weaver-candidate-selection-dialog');
  if (!(await dialog.isVisible().catch(() => false))) return null;

  const buttons = dialog.locator('button');
  const count = await buttons.count();
  const options = [];
  for (let i = 0; i < count; i += 1) {
    const button = buttons.nth(i);
    const text = ((await button.textContent()) || '').trim();
    if (!/^SELECT\s+/i.test(text)) continue;
    const ariaDescription = (await button.getAttribute('aria-description')) || '';
    const title = (await button.getAttribute('title')) || '';
    const combined = `${ariaDescription} ${title} ${text}`.trim();
    options.push({ index: i, label: combined || text });
  }

  if (!options.length) {
    throw new Error('Candidate selection dialog opened but no SELECT options were found');
  }

  const wanted = (candidateIncludes || []).map(normalize).filter(Boolean);
  let chosen = null;
  if (wanted.length) {
    chosen = options.find((option) => {
      const haystack = normalize(option.label);
      return wanted.some((needle) => haystack.includes(needle));
    }) || null;
  }
  if (!chosen) chosen = options[0];

  await buttons.nth(chosen.index).click();
  return { chosen: chosen.label, options: options.map((option) => option.label) };
};

const waitForPatchPreparedWithDialog = async (page, candidateIncludes, timeout = 360000) => {
  const deadline = Date.now() + timeout;
  let resolution = null;
  while (Date.now() < deadline) {
    const dialogResolution = await maybeResolvePatchCandidateDialog(page, candidateIncludes);
    if (dialogResolution) {
      resolution = dialogResolution;
      await page.waitForTimeout(200);
      continue;
    }

    const state = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const hasPatchRow = !!document.querySelector('#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file');
      const busyText = /extracting\s|finalizing extracted output|preparing extraction|preparing patch|calculating checksums/i.test(text);
      return { hasPatchRow, busyText };
    });

    if (state.hasPatchRow && !state.busyText) {
      await page.waitForTimeout(250);
      const lateDialogResolution = await maybeResolvePatchCandidateDialog(page, candidateIncludes);
      if (lateDialogResolution) {
        resolution = lateDialogResolution;
        await page.waitForTimeout(200);
        continue;
      }
      return resolution;
    }
    await page.waitForTimeout(300);
  }
  throw new Error('Timed out waiting for patch to finish preparation');
};

const waitForApplyReady = async (page, timeout = 30000) => {
  await page.waitForFunction(() => {
    const button = document.querySelector('#rom-weaver-button-apply');
    if (!(button instanceof HTMLButtonElement)) return false;
    return !button.disabled && /apply patch/i.test((button.textContent || '').trim());
  }, null, { timeout });
};

const readApplyStatusLine = async (page) => page.evaluate(() => {
  const text = document.body?.innerText || '';
  const match = text.match(/apply:[^\n]+/i);
  return match ? match[0].trim() : null;
});

const hasVisibleErrorRow = async (page) => page.evaluate(() => {
  const row = document.querySelector('#rom-weaver-row-error-message');
  if (!row) return false;
  const text = (row.textContent || '').trim();
  const style = window.getComputedStyle(row);
  return !!text && style.display !== 'none' && style.visibility !== 'hidden';
});

const readVisibleErrorText = async (page) => page.evaluate(() => {
  const row = document.querySelector('#rom-weaver-row-error-message');
  if (!row) return null;
  const style = window.getComputedStyle(row);
  const text = (row.textContent || '').trim();
  if (!text || style.display === 'none' || style.visibility === 'hidden') return null;
  return text;
});

const traceHasCommand = (lines, command) =>
  lines.some((line) => {
    const lower = String(line || '').toLowerCase();
    return (
      lower.includes(`runjson ${command} dispatch`) ||
      lower.includes(`args=["${command}"`) ||
      lower.includes(`args=["--trace","${command}"`) ||
      lower.includes(`args=["--json","${command}"`)
    );
  });

const summarizeTrace = (lines) => ({
  checksumDispatch: traceHasCommand(lines, 'checksum'),
  extractDispatch: traceHasCommand(lines, 'extract'),
  patchApplyDispatch: traceHasCommand(lines, 'patch-apply'),
  compressDispatch: traceHasCommand(lines, 'compress'),
  xdeltaForcedThreads1: lines.some((line) => /patch-apply/i.test(line) && /--threads","1"/i.test(line)),
});

const runCase = async (page, c) => {
  const start = Date.now();
  log(`[${c.name}] reload page`);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await waitForUiReady(page);
  await setThreadsToFourTrace(page);
  await clearOpfs(page);

  log(`[${c.name}] set ROM`, c.rom);
  await page.setInputFiles('#rom-weaver-input-file-rom', c.rom);
  await waitForRomChecksum(page);

  log(`[${c.name}] set patch`, c.patch);
  await page.setInputFiles('#rom-weaver-input-file-patch', c.patch);
  const candidate = await waitForPatchPreparedWithDialog(page, c.candidateIncludes, 420000);
  if (candidate) {
    log(`[${c.name}] candidate selected`, candidate.chosen);
  }

  await waitForApplyReady(page, 180000);
  log(`[${c.name}] set output format`, c.outputLabel);
  await selectOutputFormat(page, c.outputLabel);
  await waitForApplyReady(page, 180000);

  log(`[${c.name}] apply`);
  const opfsBeforeApply = await listOpfsPaths(page);
  log(`[${c.name}] opfs before apply`, JSON.stringify(opfsBeforeApply.slice(0, 80)));
  const patchPath = opfsBeforeApply.find((value) => /\/pkmn_rowe\.bps$/i.test(value));
  if (patchPath) {
    const patchMeta = await readOpfsFileMetadata(page, patchPath);
    log(`[${c.name}] patch meta`, JSON.stringify({ path: patchPath, ...patchMeta }));
  }
  await page.click('#rom-weaver-button-apply');

  await page.waitForFunction(() => {
    const button = document.querySelector('#rom-weaver-button-apply');
    const row = document.querySelector('#rom-weaver-row-error-message');
    if (row) {
      const style = window.getComputedStyle(row);
      const text = (row.textContent || '').trim();
      if (text && style.display !== 'none' && style.visibility !== 'hidden') return true;
    }
    if (!(button instanceof HTMLButtonElement)) return false;
    return /download/i.test((button.textContent || '').trim()) && !button.disabled;
  }, null, {
    timeout:
      Number.isFinite(applyTimeoutOverride) && applyTimeoutOverride > 0
        ? Math.floor(applyTimeoutOverride)
        : (c.applyTimeoutMs || 600000),
  });

  const visibleErrorText = await readVisibleErrorText(page);
  if (visibleErrorText) {
    throw new Error(`Apply failed: ${visibleErrorText}`);
  }

  const applyStatusLine = await readApplyStatusLine(page);
  if (!applyStatusLine) {
    throw new Error('Apply finished but no apply/compress status line was found');
  }

  const actionLabel = (await page.locator('#rom-weaver-button-apply').innerText()).trim();
  if (!/download/i.test(actionLabel)) {
    throw new Error(`Apply finished but action is not download-ready: ${actionLabel}`);
  }
  log(`[${c.name}] output ready`);
  await page.click('#rom-weaver-button-apply').catch(() => undefined);

  if (await hasVisibleErrorRow(page)) {
    throw new Error('Error row visible after apply/download');
  }

  return {
    actionLabel,
    elapsedMs: Date.now() - start,
    suggestedFilename: null,
    applyStatusLine,
    candidateChosen: candidate?.chosen || null,
  };
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true });
const page = await context.newPage();

const traceLines = [];
page.on('console', (msg) => {
  const text = msg.text();
  if (
    !/runJson|workflow:apply|workflow:input-archive|workflow:input-decompression|workflow:input-preparation|browser-runtime-vfs|patch\.apply|browser-opfs|runner-worker|worker-client/i.test(
      text,
    )
  ) {
    return;
  }
  traceLines.push(text);
  if (traceLines.length > 12000) traceLines.shift();
});

const results = [];
for (const c of selectedCases) {
  const item = { case: c.name, ok: false };
  const traceStart = traceLines.length;
  try {
    const result = await runCase(page, c);
    item.ok = true;
    item.elapsedMs = result.elapsedMs;
    item.actionLabel = result.actionLabel;
    item.suggestedFilename = result.suggestedFilename;
    item.applyStatusLine = result.applyStatusLine;
    item.candidateChosen = result.candidateChosen;
    log(`[${c.name}] OK`, `${Math.round(result.elapsedMs / 1000)}s`, result.suggestedFilename);
  } catch (error) {
    item.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log(`[${c.name}] FAIL`, item.error);
  }

  const caseTrace = traceLines.slice(traceStart);
  item.traceSummary = summarizeTrace(caseTrace);
  item.traceTail = caseTrace.slice(-120);
  results.push(item);
}

await browser.close();

const payload = {
  generatedAt: now(),
  baseUrl: BASE_URL,
  cases: results,
};
fs.writeFileSync('/tmp/weaver-e2e-sweep-results.json', JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
