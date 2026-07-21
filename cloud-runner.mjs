import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { migrateOmniDatabase } from "./migrate-omniroute.mjs";

const require = createRequire(existsSync("/app/package.json") ? "/app/package.json" : new URL("../9router-source/package.json", import.meta.url));
const Database = require("better-sqlite3");
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const DB_DIR = path.join(DATA_DIR, "db");
const DB_PATH = path.join(DB_DIR, "data.sqlite");
const SOURCE_DB_PATH = path.join(DATA_DIR, ".omniroute-source.sqlite");
const BUCKET = process.env.SUPABASE_BUCKET || "omniroute-backups";
const SOURCE_OBJECT = process.env.SUPABASE_OBJECT || "cloud/storage-v2.sqlite.enc";
const TARGET_OBJECT = process.env.NINEROUTER_SUPABASE_OBJECT || "cloud/9router-data.sqlite.enc";
const BACKUP_INTERVAL_MS = Math.max(Number.parseInt(process.env.CLOUD_BACKUP_INTERVAL_MS || "1800000", 10), 300_000);
const MAGIC = Buffer.from("OMNIBKP1");

for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "CLOUD_BACKUP_KEY"]) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}
if (!process.env.INITIAL_PASSWORD && process.env.OMNIROUTE_ADMIN_PASSWORD) {
  process.env.INITIAL_PASSWORD = process.env.OMNIROUTE_ADMIN_PASSWORD;
}
if (!process.env.INITIAL_PASSWORD) {
  throw new Error("Set INITIAL_PASSWORD in Render before exposing the 9Router dashboard");
}
process.env.AUTH_COOKIE_SECURE = process.env.AUTH_COOKIE_SECURE || "true";
process.env.REQUIRE_API_KEY = process.env.REQUIRE_API_KEY || "true";

const backupKey = Buffer.from(process.env.CLOUD_BACKUP_KEY, "hex");
if (backupKey.length !== 32) throw new Error("CLOUD_BACKUP_KEY must be exactly 64 hexadecimal characters");
const storageBase = `${process.env.SUPABASE_URL.replace(/\/+$/, "")}/storage/v1`;
const headers = {
  apikey: process.env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function encrypt(bytes) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", backupKey, iv);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}
function decrypt(payload) {
  if (!payload.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Backup has an unrecognized format");
  const decipher = createDecipheriv("aes-256-gcm", backupKey, payload.subarray(8, 20));
  decipher.setAuthTag(payload.subarray(20, 36));
  return Buffer.concat([decipher.update(payload.subarray(36)), decipher.final()]);
}

async function fetchObject(objectPath) {
  const url = `${storageBase}/object/authenticated/${BUCKET}/${objectPath}`;
  const response = await fetch(url, { headers: { ...headers, "Cache-Control": "no-cache" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Backup restore failed with HTTP ${response.status}`);
  return decrypt(Buffer.from(await response.arrayBuffer()));
}

async function restoreOrMigrate() {
  await mkdir(DB_DIR, { recursive: true });
  const current = await fetchObject(TARGET_OBJECT);
  if (current) {
    const tempPath = `${DB_PATH}.restore-${Date.now()}`;
    await writeFile(tempPath, current, { mode: 0o600 });
    const check = new Database(tempPath, { readonly: true });
    const integrity = check.pragma("integrity_check", { simple: true });
    check.close();
    if (integrity !== "ok") throw new Error(`Restored 9Router SQLite integrity check failed: ${integrity}`);
    await rename(tempPath, DB_PATH);
    console.log(`[cloud-backup] Restored 9Router database (${current.length} bytes, ${sha256(current).slice(0, 12)}...).`);
    return;
  }

  const omni = await fetchObject(SOURCE_OBJECT);
  if (!omni) {
    console.log("[cloud-migration] No OmniRoute backup found; starting a new 9Router database.");
    return;
  }
  await writeFile(SOURCE_DB_PATH, omni, { mode: 0o600 });
  const result = migrateOmniDatabase(SOURCE_DB_PATH, DB_PATH);
  await unlink(SOURCE_DB_PATH).catch(() => {});
  console.log(`[cloud-migration] Completed: ${JSON.stringify(result)}`);
}

let backupRunning = false;
async function uploadBackup(reason) {
  if (backupRunning) return;
  backupRunning = true;
  const tempPath = path.join(DATA_DIR, `.9router-backup-${Date.now()}.sqlite`);
  try {
    await access(DB_PATH);
    const source = new Database(DB_PATH, { readonly: true });
    await source.backup(tempPath);
    source.close();
    const snapshot = await readFile(tempPath);
    const response = await fetch(`${storageBase}/object/${BUCKET}/${TARGET_OBJECT}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/octet-stream", "x-upsert": "true" },
      body: encrypt(snapshot),
    });
    if (!response.ok) throw new Error(`Backup upload failed with HTTP ${response.status}`);
    console.log(`[cloud-backup] Uploaded ${reason} snapshot (${snapshot.length} bytes).`);
  } catch (error) {
    console.error(`[cloud-backup] ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await unlink(tempPath).catch(() => {});
    backupRunning = false;
  }
}

await restoreOrMigrate();
const child = spawn("node", ["/app/custom-server.js"], { cwd: "/app", env: process.env, stdio: "inherit" });
const interval = setInterval(() => void uploadBackup("scheduled"), BACKUP_INTERVAL_MS);
interval.unref();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(interval);
  await uploadBackup("shutdown");
  child.kill(signal);
  setTimeout(() => child.kill("SIGKILL"), 30_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
child.on("exit", (code, signal) => {
  clearInterval(interval);
  process.exitCode = code ?? (signal ? 1 : 0);
});
