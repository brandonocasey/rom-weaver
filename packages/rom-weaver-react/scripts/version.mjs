import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LINE_BREAK_REGEX = /\r?\n/;

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

const findPackageRoot = (startDir) => {
  let currentDir = startDir;
  while (true) {
    const candidatePath = path.join(currentDir, "package.json");
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) return currentDir;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  throw new Error(`Could not locate package.json from ${startDir}`);
};

const packageRoot = findPackageRoot(scriptsDir);
const packageJsonPath = path.join(packageRoot, "package.json");

const readPackageVersion = () => {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  return typeof packageJson.version === "string" && packageJson.version ? packageJson.version : "0.0.0";
};

const runGit = (command) => {
  try {
    return execSync(command, {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch (_error) {
    return "";
  }
};

const getUntrackedFileDigestInput = () => {
  try {
    const untracked = runGit("git ls-files --others --exclude-standard -z")
      .split("\0")
      .filter(Boolean)
      .filter((fileName) => !fileName.startsWith("dist/"))
      .sort();
    if (!untracked.length) return "";
    const hash = crypto.createHash("sha1");
    for (const fileName of untracked) {
      const filePath = path.join(packageRoot, fileName);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) continue;
      hash.update(fileName);
      hash.update("\0");
      hash.update(fs.readFileSync(filePath));
      hash.update("\0");
    }
    return hash.digest("hex");
  } catch (_error) {
    return "";
  }
};

const sanitizeVersionToken = (value) =>
  String(value || "")
    .trim()
    .replace(/[^0-9A-Za-z-]+/g, "-")
    .replace(/^-+|-+$/g, "");

const hasPackageVersionTag = (version) => {
  if (!version) return false;
  const versionTags = new Set([version, `v${version}`]);
  return runGit("git tag --points-at HEAD")
    .split(LINE_BREAK_REGEX)
    .some((tagName) => versionTags.has(tagName.trim()));
};

const getGitMetadata = (version) => {
  const revision = runGit("git rev-parse --short HEAD");
  if (!revision) return null;

  const branchName = runGit("git rev-parse --abbrev-ref HEAD");
  const normalizedBranch = sanitizeVersionToken(branchName);
  const isVersionTag = hasPackageVersionTag(version);
  const gitBranch =
    normalizedBranch && normalizedBranch !== "HEAD" && normalizedBranch !== "master" && !isVersionTag
      ? normalizedBranch
      : "";

  const dirtyDiff = runGit("git diff --binary HEAD --");
  const untrackedDigest = getUntrackedFileDigestInput();
  const dirtyHash =
    dirtyDiff || untrackedDigest
      ? crypto.createHash("sha1").update(dirtyDiff).update(untrackedDigest).digest("hex").slice(0, 12)
      : "";

  return {
    dirtyHash,
    gitBranch,
    isVersionTag,
    revision: sanitizeVersionToken(revision),
  };
};

const buildVersionString = (baseVersion, gitMetadata) => {
  if (!gitMetadata?.revision) return baseVersion;
  const branchPrefix = gitMetadata.gitBranch ? `${gitMetadata.gitBranch}.` : "";
  const hashToken = gitMetadata.dirtyHash ? `dirty.${gitMetadata.dirtyHash}` : gitMetadata.revision;
  return `${baseVersion}+${branchPrefix}${hashToken}`;
};

const getBuildInfo = () => {
  const version = readPackageVersion();
  const gitMetadata = getGitMetadata(version);
  const commitHash = gitMetadata?.revision || "unknown";
  const dirtyHash = gitMetadata?.dirtyHash || "";
  const gitBranch = gitMetadata?.gitBranch || "";
  const hashSuffix = dirtyHash ? `.dirty#${dirtyHash}` : `#${commitHash}`;
  const displayVersion = `${version}${gitBranch ? `.${gitBranch}` : ""}${hashSuffix}`;
  return {
    buildVersion: buildVersionString(version, gitMetadata),
    commitHash,
    dirtyHash,
    displayVersion,
    gitBranch,
    hasDirtyChanges: !!dirtyHash,
    version,
  };
};

export { getBuildInfo };
