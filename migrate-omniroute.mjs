import { createDecipheriv, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(existsSync("/app/package.json") ? "/app/package.json" : new URL("../9router-source/package.json", import.meta.url));
const Database = require("better-sqlite3");

const PROVIDER_MAP = new Map([
  ["agy", "antigravity"],
  ["zai", "glm"],
]);
const SUPPORTED = new Set([
  "antigravity", "codex", "gemini", "github", "kiro", "nvidia", "openrouter", "glm",
]);
const ENCRYPTION_PREFIX = "enc:v1:";

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function decryptCredential(value) {
  if (!value || typeof value !== "string" || !value.startsWith(ENCRYPTION_PREFIX)) return value;
  const secret = process.env.STORAGE_ENCRYPTION_KEY;
  if (!secret) throw new Error("STORAGE_ENCRYPTION_KEY is required to migrate encrypted OmniRoute credentials");
  const [ivHex, ciphertextHex, tagHex] = value.slice(ENCRYPTION_PREFIX.length).split(":");
  if (!ivHex || !ciphertextHex || !tagHex) throw new Error("Malformed OmniRoute encrypted credential");
  const key = scryptSync(secret, "omniroute-field-encryption-v1", 32);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(ciphertextHex, "hex", "utf8") + decipher.final("utf8");
}

function mapProvider(provider) {
  return PROVIDER_MAP.get(provider) || provider;
}

function mapModel(value) {
  if (typeof value !== "string") return value;
  if (value.startsWith("agy/")) return `antigravity/${value.slice(4)}`;
  if (value.startsWith("zai/")) return `glm/${value.slice(4)}`;
  return value;
}

function createTargetSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS providerConnections (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, authType TEXT NOT NULL, name TEXT, email TEXT,
      priority INTEGER, isActive INTEGER DEFAULT 1, data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider);
    CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive);
    CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority);
    CREATE TABLE IF NOT EXISTS apiKeys (
      id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key);
    CREATE TABLE IF NOT EXISTS combos (
      id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, kind TEXT, models TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name);
    CREATE TABLE IF NOT EXISTS kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope, key));
    CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope);
  `);
}

export function migrateOmniDatabase(sourcePath, targetPath) {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const target = new Database(targetPath);
  createTargetSchema(target);

  const connections = source.prepare("SELECT * FROM provider_connections ORDER BY provider, priority").all();
  const insertConnection = target.prepare(`
    INSERT OR REPLACE INTO providerConnections
      (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertKey = target.prepare(`
    INSERT OR REPLACE INTO apiKeys (id, key, name, machineId, isActive, createdAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertCombo = target.prepare(`
    INSERT OR REPLACE INTO combos (id, name, kind, models, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertKv = target.prepare("INSERT OR REPLACE INTO kv (scope, key, value) VALUES (?, ?, ?)");

  const migratedByProvider = {};
  const skippedByProvider = {};
  const migrate = target.transaction(() => {
    target.prepare("DELETE FROM providerConnections").run();
    target.prepare("DELETE FROM apiKeys").run();
    target.prepare("DELETE FROM combos").run();
    target.prepare("DELETE FROM kv WHERE scope = 'modelAliases'").run();

    for (const row of connections) {
      const provider = mapProvider(row.provider);
      if (!SUPPORTED.has(provider)) {
        skippedByProvider[row.provider] = (skippedByProvider[row.provider] || 0) + 1;
        continue;
      }
      const data = {
        accessToken: decryptCredential(row.access_token),
        refreshToken: decryptCredential(row.refresh_token),
        expiresAt: row.expires_at,
        tokenExpiresAt: row.token_expires_at,
        scope: row.scope,
        projectId: row.project_id,
        testStatus: row.test_status,
        errorCode: row.error_code,
        lastError: row.last_error,
        lastErrorAt: row.last_error_at,
        lastErrorType: row.last_error_type,
        lastErrorSource: row.last_error_source,
        backoffLevel: row.backoff_level,
        rateLimitedUntil: row.rate_limited_until,
        healthCheckInterval: row.health_check_interval,
        lastHealthCheckAt: row.last_health_check_at,
        lastTested: row.last_tested,
        apiKey: decryptCredential(row.api_key),
        idToken: decryptCredential(row.id_token),
        providerSpecificData: parseJson(row.provider_specific_data, {}),
        expiresIn: row.expires_in,
        displayName: row.display_name,
        globalPriority: row.global_priority,
        defaultModel: row.default_model,
        tokenType: row.token_type,
        consecutiveUseCount: row.consecutive_use_count,
        lastUsedAt: row.last_used_at,
      };
      for (const key of Object.keys(data)) {
        if (data[key] === null || data[key] === undefined || (key === "providerSpecificData" && Object.keys(data[key]).length === 0)) delete data[key];
      }
      insertConnection.run(
        row.id, provider, row.auth_type || "oauth", row.name, row.email, row.priority,
        row.is_active === 0 ? 0 : 1, JSON.stringify(data), row.created_at, row.updated_at,
      );
      migratedByProvider[provider] = (migratedByProvider[provider] || 0) + 1;
    }

    for (const row of source.prepare("SELECT * FROM api_keys WHERE revoked_at IS NULL").all()) {
      insertKey.run(row.id, row.key, row.name, row.machine_id, row.is_active === 0 ? 0 : 1, row.created_at);
    }

    for (const row of source.prepare("SELECT id, name, data, created_at, updated_at FROM combos ORDER BY sort_order").all()) {
      const combo = parseJson(row.data, {});
      const models = (Array.isArray(combo.models) ? combo.models : [])
        .filter((entry) => entry && typeof entry === "object")
        .filter((entry) => SUPPORTED.has(mapProvider(entry.providerId || String(entry.model || "").split("/")[0])))
        .map((entry) => mapModel(entry.model))
        .filter(Boolean);
      if (models.length) insertCombo.run(row.id, row.name, null, JSON.stringify(models), row.created_at, row.updated_at);
    }

    for (const row of source.prepare("SELECT key, value FROM key_value WHERE namespace = 'modelAliases'").all()) {
      const resolved = mapModel(parseJson(row.value, null));
      if (typeof resolved !== "string") continue;
      const provider = resolved.split("/")[0];
      if (["chatgpt-web", "gemini-web", "freemodel-dev"].includes(provider)) continue;
      insertKv.run("modelAliases", row.key, JSON.stringify(resolved));
    }

    target.prepare("INSERT OR REPLACE INTO settings (id, data) VALUES (1, ?)").run(JSON.stringify({
      requireLogin: true,
      requireApiKey: true,
      comboStrategy: "fallback",
      enableObservability: false,
    }));
  });

  migrate();
  target.pragma("wal_checkpoint(TRUNCATE)");
  const integrity = target.pragma("integrity_check", { simple: true });
  const result = {
    integrity,
    migratedConnections: Object.values(migratedByProvider).reduce((sum, value) => sum + value, 0),
    migratedByProvider,
    skippedConnections: Object.values(skippedByProvider).reduce((sum, value) => sum + value, 0),
    skippedByProvider,
    apiKeys: target.prepare("SELECT COUNT(*) AS count FROM apiKeys").get().count,
    combos: target.prepare("SELECT COUNT(*) AS count FROM combos").get().count,
    aliases: target.prepare("SELECT COUNT(*) AS count FROM kv WHERE scope = 'modelAliases'").get().count,
  };
  source.close();
  target.close();
  return result;
}
