#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const generatedCert = "/tmp/rom-weaver-tls/cert.pem";
const generatedKey = "/tmp/rom-weaver-tls/key.pem";

function readableFile(file) {
  try {
    accessSync(file, constants.R_OK);
    return statSync(file).isFile() && statSync(file).size > 0;
  } catch {
    return false;
  }
}

export function resolveTls(env = process.env) {
  if (!env.HTTPS_PORT) return null;
  const cert = env.HTTPS_CERT || "";
  const key = env.HTTPS_KEY || "";
  if (cert || key) {
    if (!cert || !key) throw Object.assign(new Error("Set both HTTPS_CERT and HTTPS_KEY, or set neither to generate a test certificate"), { code: 64 });
    if (!readableFile(cert) || !readableFile(key)) throw Object.assign(new Error("HTTPS_CERT and HTTPS_KEY must point to readable certificate files"), { code: 66 });
    return { cert, key };
  }
  if (readableFile("/certs/fullchain.pem") || readableFile("/certs/privkey.pem")) {
    if (!readableFile("/certs/fullchain.pem") || !readableFile("/certs/privkey.pem")) throw Object.assign(new Error("HTTPS_CERT and HTTPS_KEY must point to readable certificate files"), { code: 66 });
    return { cert: "/certs/fullchain.pem", key: "/certs/privkey.pem" };
  }
  mkdirSync(join(generatedCert, ".."), { recursive: true, mode: 0o700 });
  if (!readableFile(generatedCert) || !readableFile(generatedKey)) {
    const previousUmask = process.umask(0o077);
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "7", "-keyout", generatedKey, "-out", generatedCert, "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1"], { stdio: "inherit", env });
    } finally {
      process.umask(previousUmask);
    }
  }
  return { cert: generatedCert, key: generatedKey };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let tls;
  try {
    tls = resolveTls(env);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return error.code || 1;
  }
  const args = [...argv];
  if (tls) args.push("--port", "8080", "--http2=true", "--http2-tls-cert", tls.cert, "--http2-tls-key", tls.key);
  const server = spawn("static-web-server", args, { stdio: "inherit", env });
  return new Promise((resolve) => server.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
