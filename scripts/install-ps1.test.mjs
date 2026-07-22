import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const hasPowerShell = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

// Invoke-WebRequest is stubbed by declaring a function of the same name in the
// caller's scope: PowerShell resolves functions before cmdlets, and install.ps1
// runs in a child scope that inherits it. The checksum is computed from the
// binary the stub just wrote, so the script's own verification is exercised
// rather than bypassed.
const harness = (installDirectory, urlLog) => `
$env:ROM_WEAVER_INSTALL_DIR = '${installDirectory}'
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
  Add-Content -Path '${urlLog}' -Value $Uri
  if ($Uri.EndsWith('.sha256')) {
    $binary = $OutFile -replace '\\.sha256$', ''
    $hash = (Get-FileHash -Path $binary -Algorithm SHA256).Hash
    Set-Content -Path $OutFile -Value "$hash  rom-weaver-win32-x64-msvc.exe"
  } else {
    Set-Content -Path $OutFile -Value 'binary' -NoNewline
  }
}
& '${resolve("install.ps1")}'
`;

test("installs the checksummed binary", { skip: hasPowerShell ? false : "pwsh not available" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-install-ps1-"));
  try {
    const installDirectory = join(directory, "install");
    const urlLog = join(directory, "urls.log");
    const output = execFileSync(
      "pwsh",
      ["-NoProfile", "-Command", harness(installDirectory, urlLog)],
      { encoding: "utf8" },
    );

    const target = join(installDirectory, "rom-weaver.exe");
    assert.equal(readFileSync(target, "utf8"), "binary");
    assert.ok(output.includes(`Installed rom-weaver to ${target}`));
    assert.deepEqual(readFileSync(urlLog, "utf8").trim().split("\n"), [
      "https://github.com/brandonocasey/rom-weaver/releases/latest/download/rom-weaver-win32-x64-msvc.exe",
      "https://github.com/brandonocasey/rom-weaver/releases/latest/download/rom-weaver-win32-x64-msvc.exe.sha256",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "pins the requested version and rejects a tampered download",
  { skip: hasPowerShell ? false : "pwsh not available" },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "rom-weaver-install-ps1-"));
    try {
      const urlLog = join(directory, "urls.log");
      const script = `
$env:ROM_WEAVER_VERSION = 'v9.9.9'
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
  Add-Content -Path '${urlLog}' -Value $Uri
  if ($Uri.EndsWith('.sha256')) {
    Set-Content -Path $OutFile -Value "${"a".repeat(64)}  rom-weaver-win32-x64-msvc.exe"
  } else {
    Set-Content -Path $OutFile -Value 'binary' -NoNewline
  }
}
& '${resolve("install.ps1")}'
`;
      const result = spawnSync(
        "pwsh",
        ["-NoProfile", "-Command", `$env:ROM_WEAVER_INSTALL_DIR = '${join(directory, "install")}'; ${script}`],
        { encoding: "utf8" },
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /checksum mismatch/);
      assert.deepEqual(readFileSync(urlLog, "utf8").trim().split("\n"), [
        "https://github.com/brandonocasey/rom-weaver/releases/download/v9.9.9/rom-weaver-win32-x64-msvc.exe",
        "https://github.com/brandonocasey/rom-weaver/releases/download/v9.9.9/rom-weaver-win32-x64-msvc.exe.sha256",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
