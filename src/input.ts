/**
 * Reading input for create/update commands: `--file x.json|x.yaml` (or `-` for stdin),
 * `--data '<json>'` (or `@file`), merged with field flags (flags win).
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { UsageError } from "./errors.js";

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY)
    throw new UsageError(
      "Nothing on stdin.",
      "Pipe a file in, e.g. `cat tour.json | cueston tours create --file -`."
    );
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** JSON or YAML text → value. YAML is a superset of JSON, but JSON errors read better. */
export function parseDocument(
  text: string,
  source: string,
  format: "json" | "yaml" | "auto" = "auto"
): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new UsageError(`${source} is empty.`);
  const asJson = format === "json" || (format === "auto" && /^[[{]/.test(trimmed));
  try {
    return asJson ? JSON.parse(trimmed) : parseYaml(trimmed);
  } catch (error) {
    throw new UsageError(`Can't parse ${source}: ${(error as Error).message.split("\n")[0]}`);
  }
}

export async function readDocument(path: string): Promise<unknown> {
  if (path === "-") return parseDocument(await readStdin(), "stdin");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new UsageError(`Can't read ${path}.`);
  }
  const ext = extname(path).toLowerCase();
  return parseDocument(
    text,
    path,
    ext === ".json" ? "json" : ext === ".yaml" || ext === ".yml" ? "yaml" : "auto"
  );
}

/** `--data '{"name":"x"}'` or `--data @file.json`. */
export async function readData(value: string): Promise<unknown> {
  if (value.startsWith("@")) return readDocument(value.slice(1));
  if (value === "-") return readDocument("-");
  return parseDocument(value, "--data", "auto");
}

export function asObject(value: unknown, source: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new UsageError(`${source} must be an object, like {"name": "Welcome tour"}.`);
  return value as Record<string, unknown>;
}

/** The request body from --file / --data plus field flags (flags win). */
export async function bodyFrom(
  options: { file?: string; data?: string },
  fields: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  if (options.file && options.data) throw new UsageError("Use --file or --data, not both.");
  let base: Record<string, unknown> = {};
  if (options.file) base = asObject(await readDocument(options.file), options.file);
  else if (options.data) base = asObject(await readData(options.data), "--data");
  const body = { ...base };
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) body[key] = value;
  return body;
}

/** `--arg key=value` pairs → an object; values are parsed as JSON when they look like it. */
export function parseArgPairs(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index <= 0)
      throw new UsageError(`Invalid --arg "${pair}".`, "Use --arg key=value, e.g. --arg id=12.");
    const key = pair.slice(0, index);
    const raw = pair.slice(index + 1);
    let value: unknown = raw;
    if (/^(-?\d+(\.\d+)?|true|false|null)$/.test(raw) || /^[[{"]/.test(raw)) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    out[key] = value;
  }
  return out;
}
