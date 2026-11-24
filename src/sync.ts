/**
 * Content as code: `cueston pull` writes each item's editable draft fields to
 * `<dir>/<plural>/<id>-<slug>.json`; `cueston push` compares those files with the server's
 * drafts and creates (no id) or updates (changed fields only) drafts, then writes back what the
 * server saved — so running push again is a no-op.
 *
 * Which fields are editable comes from the server: the MCP `update_<type>` tool's input schema
 * (the same schema the API validates with). Without it (a read-only key), server-managed fields
 * are dropped by name.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { Client } from "./client.js";
import { CONTENT_TYPES, type ContentTypeDef } from "./content-types.js";
import { ApiError, UsageError } from "./errors.js";

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: unknown;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
};

/** Fields the server manages: never written to files or sent back. */
const SERVER_FIELDS = new Set([
  "id",
  "isActive",
  "createdAt",
  "updatedAt",
  "publication",
  "hasUnpublishedChanges",
  "workspaceId",
  "userId",
  "createdBy",
  "updatedBy",
  "stepCount",
  "itemCount",
  "questionCount",
  "versions",
  "publishedVersion",
]);
const SERVER_CHILD_FIELDS = new Set([
  "tourId",
  "checklistId",
  "surveyId",
  "stepOrder",
  "position",
  "createdAt",
  "updatedAt",
]);

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** JSON with object keys sorted at every level: two equal documents give the same string. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort())
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** Stable key order for files: `id` first, then alphabetical (nested objects too). */
export function fileShape(item: Record<string, unknown>): Record<string, unknown> {
  const sorted = sortDeep(item) as Record<string, unknown>;
  if (!("id" in sorted)) return sorted;
  const { id, ...rest } = sorted;
  return { id, ...rest };
}

export function slugify(name: unknown, fallback = "item"): string {
  const slug = String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return slug || fallback;
}

export const fileNameFor = (id: number, name: unknown, type = "item") =>
  `${id}-${slugify(name, type)}.json`;

/** Keep only what a JSON schema defines (recursively); unions and open objects keep their value. */
export function filterBySchema(value: unknown, schema: JsonSchema | undefined): unknown {
  if (!schema || value === null || typeof value !== "object") return value;
  if (schema.anyOf || schema.oneOf) return value;
  if (Array.isArray(value))
    return schema.items ? value.map((item) => filterBySchema(item, schema.items)) : value;
  if (
    !schema.properties ||
    (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
  )
    return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>))
    if (key in schema.properties) out[key] = filterBySchema(item, schema.properties[key]);
  return out;
}

/** An item as the API returns it → its editable draft fields (no id). */
export function editableFields(
  item: Record<string, unknown>,
  def: ContentTypeDef,
  schema?: JsonSchema | null
): Record<string, unknown> {
  let out: Record<string, unknown>;
  if (schema?.properties) {
    out = filterBySchema(item, schema) as Record<string, unknown>;
  } else {
    out = {};
    for (const [key, value] of Object.entries(item)) if (!SERVER_FIELDS.has(key)) out[key] = value;
    if (def.children && Array.isArray(out[def.children])) {
      out[def.children] = (out[def.children] as unknown[]).map((child) => {
        if (!child || typeof child !== "object") return child;
        const kept: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(child as Record<string, unknown>))
          if (!SERVER_CHILD_FIELDS.has(key)) kept[key] = value;
        return kept;
      });
    }
  }
  delete out.id;
  delete out.isActive;
  return out;
}

/** Fields of a local file (except id) whose value differs from the server's draft. */
export function changedFields(
  local: Record<string, unknown>,
  server: Record<string, unknown>
): string[] {
  return Object.keys(local)
    .filter((key) => key !== "id")
    .filter((key) => canonical(local[key]) !== canonical(server[key]))
    .sort();
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface LocalItem {
  def: ContentTypeDef;
  file: string;
  data: Record<string, unknown>;
  id: number | null;
}

/** Every `<dir>/<plural>/*.json` for the given types. Throws on unreadable files and duplicate ids. */
export function readLocal(dir: string, defs: readonly ContentTypeDef[]): LocalItem[] {
  if (!existsSync(dir))
    throw new UsageError(
      `${dir} doesn't exist.`,
      "Run `cueston pull` first, or pass the folder with your content files."
    );
  const items: LocalItem[] = [];
  for (const def of defs) {
    const folder = join(dir, def.plural);
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder).sort()) {
      if (!name.endsWith(".json")) continue;
      const file = join(folder, name);
      let data: unknown;
      try {
        data = JSON.parse(readFileSync(file, "utf8"));
      } catch (error) {
        throw new UsageError(`Can't parse ${file}: ${(error as Error).message}`);
      }
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new UsageError(`${file} must contain one JSON object.`);
      const raw = (data as Record<string, unknown>).id;
      if (raw !== undefined && raw !== null && !(Number.isSafeInteger(raw) && (raw as number) > 0))
        throw new UsageError(
          `${file}: "id" must be a positive number (or leave it out to create a new item).`
        );
      items.push({
        def,
        file,
        data: data as Record<string, unknown>,
        id: (raw as number | undefined) ?? null,
      });
    }
  }
  const seen = new Map<string, string>();
  for (const item of items) {
    if (item.id === null) continue;
    const key = `${item.def.type}:${item.id}`;
    if (seen.has(key))
      throw new UsageError(
        `Two files have ${item.def.type} id ${item.id}: ${seen.get(key)} and ${item.file}.`
      );
    seen.set(key, item.file);
  }
  return items;
}

/** Write an item file; if the item's file had another name (renamed item, new id), remove that one. */
export function writeItem(
  dir: string,
  def: ContentTypeDef,
  id: number,
  fields: Record<string, unknown>,
  previous?: string
): string {
  const folder = join(dir, def.plural);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, fileNameFor(id, fields.name, def.type));
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(fileShape({ id, ...fields }), null, 2)}\n`);
  renameSync(temp, file);
  const stale = previous ? [previous] : [];
  for (const name of existsSync(folder) ? readdirSync(folder) : [])
    if (name.startsWith(`${id}-`) && name.endsWith(".json")) stale.push(join(folder, name));
  for (const old of stale) if (old !== file && existsSync(old)) rmSync(old);
  return file;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** The editable-field schema per type, from the MCP tool catalog. Empty when the key can't edit. */
export async function fetchSchemas(client: Client): Promise<Map<string, JsonSchema>> {
  const schemas = new Map<string, JsonSchema>();
  try {
    const { tools } = await client.mcp<{ tools: Array<{ name: string; inputSchema: JsonSchema }> }>(
      "tools/list"
    );
    for (const def of CONTENT_TYPES) {
      const tool = tools.find((candidate) => candidate.name === `update_${def.type}`);
      if (tool?.inputSchema?.properties) schemas.set(def.type, tool.inputSchema);
    }
  } catch {
    // Fall back to dropping server-managed fields by name.
  }
  return schemas;
}

async function serverItem(
  client: Client,
  def: ContentTypeDef,
  id: number
): Promise<Record<string, unknown> | null> {
  try {
    const body = await client.get(`/api/${def.plural}/${id}`);
    return body[def.type];
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export interface PullResult {
  written: Array<{ type: string; id: number; file: string }>;
  pruned: string[];
}

export async function pull(
  client: Client,
  dir: string,
  defs: readonly ContentTypeDef[],
  options: { prune?: boolean; onItem?: (line: string) => void } = {}
): Promise<PullResult> {
  const schemas = await fetchSchemas(client);
  const result: PullResult = { written: [], pruned: [] };
  for (const def of defs) {
    const list = await client.get(`/api/${def.plural}`);
    const ids = new Set<number>();
    for (const summary of list[def.plural] as Array<{ id: number }>) {
      const item = await serverItem(client, def, summary.id);
      if (!item) continue;
      ids.add(summary.id);
      const file = writeItem(
        dir,
        def,
        summary.id,
        editableFields(item, def, schemas.get(def.type))
      );
      result.written.push({
        type: def.type,
        id: summary.id,
        file: relative(process.cwd(), file) || file,
      });
      options.onItem?.(`${def.type} ${summary.id} → ${relative(process.cwd(), file) || file}`);
    }
    if (options.prune) {
      for (const local of readLocal(dir, [def])) {
        if (local.id !== null && !ids.has(local.id)) {
          rmSync(local.file);
          result.pruned.push(relative(process.cwd(), local.file) || local.file);
        }
      }
    }
  }
  return result;
}

export interface PlanEntry {
  action: "create" | "update" | "unchanged" | "missing";
  type: string;
  id: number | null;
  file: string;
  name: string | null;
  fields: string[];
}

export async function plan(
  client: Client,
  items: LocalItem[],
  schemas: Map<string, JsonSchema>
): Promise<PlanEntry[]> {
  const entries: PlanEntry[] = [];
  for (const item of items) {
    const file = relative(process.cwd(), item.file) || item.file;
    const name = typeof item.data.name === "string" ? item.data.name : null;
    const fields = Object.keys(item.data)
      .filter((key) => key !== "id")
      .sort();
    if (item.id === null) {
      entries.push({ action: "create", type: item.def.type, id: null, file, name, fields });
      continue;
    }
    const server = await serverItem(client, item.def, item.id);
    if (!server) {
      entries.push({ action: "missing", type: item.def.type, id: item.id, file, name, fields: [] });
      continue;
    }
    const changed = changedFields(
      item.data,
      editableFields(server, item.def, schemas.get(item.def.type))
    );
    entries.push({
      action: changed.length ? "update" : "unchanged",
      type: item.def.type,
      id: item.id,
      file,
      name,
      fields: changed,
    });
  }
  return entries;
}

export interface PushOutcome {
  plan: PlanEntry[];
  applied: Array<{ action: "create" | "update"; type: string; id: number; file: string }>;
  published: Array<{ type: string; id: number; environment: string; version: number | null }>;
  errors: Array<{ type: string; id: number | null; file: string; code: string; message: string }>;
}

export async function push(
  client: Client,
  dir: string,
  defs: readonly ContentTypeDef[],
  options: {
    dryRun?: boolean;
    publish?: boolean;
    environment?: "production" | "staging";
    onPlan?: (entries: PlanEntry[]) => void;
    onProgress?: (line: string) => void;
  } = {}
): Promise<PushOutcome> {
  const items = readLocal(dir, defs);
  const schemas = await fetchSchemas(client);
  const entries = await plan(client, items, schemas);
  options.onPlan?.(entries);
  const outcome: PushOutcome = { plan: entries, applied: [], published: [], errors: [] };
  for (const entry of entries)
    if (entry.action === "missing")
      outcome.errors.push({
        type: entry.type,
        id: entry.id,
        file: entry.file,
        code: "not_found",
        message: `${entry.type} ${entry.id} isn't on the server (deleted, or another workspace). Remove "id" from the file to create it again.`,
      });
  if (options.dryRun) return outcome;

  const environment = options.environment ?? "production";
  for (const [index, entry] of entries.entries()) {
    if (entry.action !== "create" && entry.action !== "update") continue;
    const item = items[index];
    const { def } = item;
    try {
      let saved: Record<string, unknown>;
      if (entry.action === "create") {
        const { id: _ignored, ...fields } = item.data;
        saved = (await client.post(`/api/${def.plural}`, { ...fields, isActive: false }))[def.type];
      } else {
        const changes: Record<string, unknown> = {};
        for (const key of entry.fields) changes[key] = item.data[key];
        saved = (await client.patch(`/api/${def.plural}/${entry.id}`, changes))[def.type];
      }
      const id = saved.id as number;
      // Write back what the server stored (normalized values, new ids), so the next push is a no-op.
      const file = writeItem(
        dir,
        def,
        id,
        editableFields(saved, def, schemas.get(def.type)),
        item.file
      );
      const shown = relative(process.cwd(), file) || file;
      outcome.applied.push({ action: entry.action, type: def.type, id, file: shown });
      options.onProgress?.(
        `${entry.action === "create" ? "created" : "updated"} ${def.type} ${id} (${shown})`
      );
      if (options.publish) {
        try {
          const result = await client.post(`/api/${def.plural}/${id}/publish`, {
            environment,
            note: "cueston push",
          });
          const version =
            typeof result?.version === "object"
              ? (result.version?.version ?? null)
              : (result?.version ?? null);
          outcome.published.push({ type: def.type, id, environment, version });
          options.onProgress?.(`published ${def.type} ${id} to ${environment}`);
        } catch (error) {
          outcome.errors.push(errorEntry(def.type, id, shown, error));
        }
      }
    } catch (error) {
      outcome.errors.push(errorEntry(def.type, entry.id, entry.file, error));
    }
  }
  return outcome;
}

function errorEntry(type: string, id: number | null, file: string, error: unknown) {
  if (error instanceof ApiError) {
    const message = error.details.length
      ? `${error.message}: ${error.details.join("; ")}`
      : error.message;
    return { type, id, file, code: error.code, message };
  }
  return { type, id, file, code: "error", message: (error as Error)?.message ?? String(error) };
}
