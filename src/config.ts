/**
 * Where the CLI keeps its sign-in, and which key and API URL a command uses.
 *
 * Key:     --key → CUESTON_API_KEY → config file
 * API URL: --api-url → CUESTON_API_URL → config file → https://app.cueston.com
 *
 * The config file is `$XDG_CONFIG_HOME/cueston/config.json` (default `~/.config/cueston/`;
 * `%APPDATA%\cueston\` on Windows; CUESTON_CONFIG_DIR overrides the folder), written with mode
 * 0600 in a 0700 directory.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, UsageError } from "./errors.js";

export const DEFAULT_API_URL = "https://app.cueston.com";

export interface StoredConfig {
  apiUrl?: string;
  key?: string;
  keyId?: number;
  keyPrefix?: string;
  workspace?: { id: number; name: string };
  user?: { email: string };
}

export type Env = Record<string, string | undefined>;

export function configDir(env: Env = process.env): string {
  if (env.CUESTON_CONFIG_DIR) return env.CUESTON_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "cueston");
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "cueston");
  return join(env.HOME || homedir(), ".config", "cueston");
}

export const configPath = (env: Env = process.env) => join(configDir(env), "config.json");

export function readConfig(env: Env = process.env): StoredConfig {
  const path = configPath(env);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliError(
      `Can't read ${path}: it isn't valid JSON.`,
      "Fix or delete the file, then run `cueston login`."
    );
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as StoredConfig)
    : {};
}

/** Write atomically (temp file + rename), owner-only: directory 0700, file 0600. */
export function writeConfig(config: StoredConfig, env: Env = process.env): string {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  const path = configPath(env);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(temp, 0o600);
  renameSync(temp, path);
  return path;
}

/** Forget the stored key (keeps a custom API URL). Removes the file when nothing is left. */
export function clearSignIn(env: Env = process.env): void {
  const config = readConfig(env);
  const rest: StoredConfig = config.apiUrl ? { apiUrl: config.apiUrl } : {};
  if (Object.keys(rest).length === 0) {
    rmSync(configPath(env), { force: true });
    return;
  }
  writeConfig(rest, env);
}

/** `https://app.cueston.com/` → `https://app.cueston.com`; anything that isn't http(s) is refused. */
export function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(
      `Invalid API URL: ${value}`,
      "Use a full URL like https://app.cueston.com."
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new UsageError(`Invalid API URL: ${value}`, "Use an http(s) URL.");
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

export type KeySource = "flag" | "env" | "config";

export interface ResolvedAuth {
  apiUrl: string;
  key: string | null;
  keySource: KeySource | null;
}

export function resolveAuth(
  flags: { key?: string; apiUrl?: string },
  env: Env = process.env,
  config: StoredConfig = readConfig(env)
): ResolvedAuth {
  const apiUrl = normalizeApiUrl(
    flags.apiUrl || env.CUESTON_API_URL || config.apiUrl || DEFAULT_API_URL
  );
  if (flags.key) return { apiUrl, key: flags.key.trim(), keySource: "flag" };
  if (env.CUESTON_API_KEY) return { apiUrl, key: env.CUESTON_API_KEY.trim(), keySource: "env" };
  if (config.key) return { apiUrl, key: config.key, keySource: "config" };
  return { apiUrl, key: null, keySource: null };
}

/** `sk_live_abcdef…wxyz` → `sk_…wxyz`. Never print a whole secret. */
export function maskKey(key: string | null | undefined): string {
  if (!key) return "(none)";
  const prefix = key.includes("_") ? key.slice(0, key.indexOf("_") + 1) : "";
  return key.length <= prefix.length + 8 ? `${prefix}…` : `${prefix}…${key.slice(-4)}`;
}
