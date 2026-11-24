import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearSignIn,
  configDir,
  configPath,
  DEFAULT_API_URL,
  maskKey,
  normalizeApiUrl,
  readConfig,
  resolveAuth,
  writeConfig,
} from "../src/config";
import { CliError, UsageError } from "../src/errors";

const scratch = () => mkdtempSync(join(tmpdir(), "cueston-cli-test-"));

describe("resolveAuth", () => {
  const config = { key: "sk_from_config_0000000000", apiUrl: "https://config.example.com" };

  it("prefers --key, then CUESTON_API_KEY, then the config file", () => {
    expect(resolveAuth({ key: "sk_flag" }, { CUESTON_API_KEY: "sk_env" }, config)).toMatchObject({
      key: "sk_flag",
      keySource: "flag",
    });
    expect(resolveAuth({}, { CUESTON_API_KEY: "sk_env" }, config)).toMatchObject({
      key: "sk_env",
      keySource: "env",
    });
    expect(resolveAuth({}, {}, config)).toMatchObject({ key: config.key, keySource: "config" });
    expect(resolveAuth({}, {}, {})).toMatchObject({ key: null, keySource: null });
  });

  it("prefers --api-url, then CUESTON_API_URL, then the config file, then app.cueston.com", () => {
    expect(
      resolveAuth(
        { apiUrl: "http://localhost:3000/" },
        { CUESTON_API_URL: "https://env.example.com" },
        config
      ).apiUrl
    ).toBe("http://localhost:3000");
    expect(resolveAuth({}, { CUESTON_API_URL: "https://env.example.com" }, config).apiUrl).toBe(
      "https://env.example.com"
    );
    expect(resolveAuth({}, {}, config).apiUrl).toBe("https://config.example.com");
    expect(resolveAuth({}, {}, {}).apiUrl).toBe(DEFAULT_API_URL);
  });

  it("trims keys", () => {
    expect(resolveAuth({}, { CUESTON_API_KEY: "  sk_env\n" }, {}).key).toBe("sk_env");
  });
});

describe("normalizeApiUrl", () => {
  it("drops trailing slashes and refuses non-http URLs", () => {
    expect(normalizeApiUrl("https://app.cueston.com/")).toBe("https://app.cueston.com");
    expect(normalizeApiUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(() => normalizeApiUrl("ftp://x")).toThrow(UsageError);
    expect(() => normalizeApiUrl("app.cueston.com")).toThrow(UsageError);
  });
});

describe("maskKey", () => {
  it("never shows more than the prefix and the last four characters", () => {
    const key = "sk_9Qm2xYvB7aLk3PzR8tWc1NdF6hJs4GeK0uVo5iTq";
    expect(maskKey(key)).toBe("sk_…5iTq");
    expect(maskKey(key)).not.toContain(key.slice(3, 10));
    expect(maskKey("sk_short")).toBe("sk_…");
    expect(maskKey(null)).toBe("(none)");
  });
});

describe("config file", () => {
  it("lives in CUESTON_CONFIG_DIR, XDG_CONFIG_HOME/cueston or ~/.config/cueston", () => {
    expect(configDir({ CUESTON_CONFIG_DIR: "/a" })).toBe("/a");
    expect(configDir({ XDG_CONFIG_HOME: "/x" })).toBe(join("/x", "cueston"));
    if (process.platform !== "win32")
      expect(configDir({ HOME: "/home/ana" })).toBe(join("/home/ana", ".config", "cueston"));
  });

  it("is written owner-only (0600 in a 0700 folder) and read back", () => {
    const env = { CUESTON_CONFIG_DIR: join(scratch(), "nested", "cueston") };
    const path = writeConfig({ key: "sk_secret_value", workspace: { id: 1, name: "Acme" } }, env);
    expect(path).toBe(configPath(env));
    expect(readConfig(env)).toEqual({ key: "sk_secret_value", workspace: { id: 1, name: "Acme" } });
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(env.CUESTON_CONFIG_DIR).mode & 0o777).toBe(0o700);
    }
  });

  it("clearSignIn removes the key but keeps a custom API URL", () => {
    const env = { CUESTON_CONFIG_DIR: scratch() };
    writeConfig({ key: "sk_x", apiUrl: "http://localhost:3000" }, env);
    clearSignIn(env);
    expect(readConfig(env)).toEqual({ apiUrl: "http://localhost:3000" });
    writeConfig({ key: "sk_x" }, env);
    clearSignIn(env);
    expect(readConfig(env)).toEqual({});
  });

  it("explains a broken config file instead of crashing", () => {
    const env = { CUESTON_CONFIG_DIR: scratch() };
    writeFileSync(configPath(env), "{not json");
    expect(() => readConfig(env)).toThrow(CliError);
    expect(readFileSync(configPath(env), "utf8")).toBe("{not json");
  });
});
