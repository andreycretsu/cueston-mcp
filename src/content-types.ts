import { UsageError } from "./errors.js";

export interface ContentTypeDef {
  /** API type key and response key for one item: `tour`. */
  type: string;
  /** API path segment and list key: `tours`. */
  plural: string;
  /** Child lists whose items have their own ids (kept on update). */
  children?: string;
}

export const CONTENT_TYPES: readonly ContentTypeDef[] = [
  { type: "tour", plural: "tours", children: "steps" },
  { type: "tooltip", plural: "tooltips" },
  { type: "banner", plural: "banners" },
  { type: "checklist", plural: "checklists", children: "items" },
  { type: "survey", plural: "surveys", children: "questions" },
  { type: "announcement", plural: "announcements" },
];

/** `tour`, `tours`, `Tour` → the tour definition; undefined for anything else. */
export function findType(input: string): ContentTypeDef | undefined {
  const key = input.trim().toLowerCase();
  return CONTENT_TYPES.find((def) => def.type === key || def.plural === key);
}

export function typeOf(input: string): ContentTypeDef {
  const def = findType(input);
  if (!def)
    throw new UsageError(
      `Unknown content type "${input}".`,
      `Use one of: ${CONTENT_TYPES.map((def) => def.plural).join(", ")}.`
    );
  return def;
}

/** "live" (production), "staging", or "draft" (never published). */
export function statusOf(publication: any): "live" | "staging" | "draft" {
  if (publication?.production) return "live";
  if (publication?.staging) return "staging";
  return "draft";
}

/** A positive integer id from an argument, or a usage error. */
export function parseId(value: string, name = "id"): number {
  const id = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id <= 0)
    throw new UsageError(`Invalid ${name}: "${value}". Use the number from \`list\`.`);
  return id;
}
