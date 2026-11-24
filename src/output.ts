/**
 * Printing: human output (aligned tables, short summaries, colors only on a terminal) or, with
 * --json, one JSON document on stdout. Progress and hints go to stderr so stdout stays clean
 * for pipes.
 */
import pc from "picocolors";
import { stringify as toYaml } from "yaml";

const colorsOn = (stream: NodeJS.WriteStream, env = process.env) =>
  Boolean(stream.isTTY) && !("NO_COLOR" in env) && env.TERM !== "dumb" && env.FORCE_COLOR !== "0";

export const color = pc.createColors(colorsOn(process.stdout));
export const errColor = pc.createColors(colorsOn(process.stderr));

export interface Column<T> {
  header: string;
  value: (row: T) => unknown;
  /** Truncate longer cells on a terminal. Default 60. */
  max?: number;
}

const cell = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).replace(/\s+/g, " ");
};

/** An aligned plain-text table (no borders). Cells are truncated only when stdout is a terminal. */
export function table<T>(
  rows: T[],
  columns: Column<T>[],
  truncate = Boolean(process.stdout.isTTY)
): string {
  const cells = rows.map((row) =>
    columns.map((column) => {
      const text = cell(column.value(row));
      const max = column.max ?? 60;
      return truncate && text.length > max ? `${text.slice(0, max - 1)}…` : text;
    })
  );
  const widths = columns.map((column, i) =>
    Math.max(column.header.length, ...cells.map((row) => row[i].length))
  );
  const line = (values: string[]) =>
    values
      .map((value, i) => (i === values.length - 1 ? value : value.padEnd(widths[i])))
      .join("  ")
      .trimEnd();
  return [
    color.dim(line(columns.map((column) => column.header.toUpperCase()))),
    ...cells.map(line),
  ].join("\n");
}

export const yaml = (value: unknown) => toYaml(value, { lineWidth: 0 }).trimEnd();

export const json = (value: unknown) => JSON.stringify(value, null, 2);

/** "3 minutes ago", "2 days ago"; the date itself after 30 days. */
export function ago(iso: unknown, now = Date.now()): string {
  if (typeof iso !== "string") return "—";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "—";
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 45) return "just now";
  const units: Array<[number, string]> = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
  ];
  if (seconds >= 30 * 86400) return new Date(time).toISOString().slice(0, 10);
  let value = Math.round(seconds / 60);
  let unit = "minute";
  for (const [size, name] of units) {
    if (seconds >= size) {
      value = Math.round(seconds / size);
      unit = name;
    }
  }
  return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
}

export interface Printer {
  readonly jsonMode: boolean;
  /** The command's result: JSON in --json mode, else the human text. */
  result(data: unknown, human?: () => string): void;
  /** Progress or a hint on stderr (silent in --json mode). */
  info(message: string): void;
  /** A warning on stderr, also in --json mode. */
  warn(message: string): void;
}

export function printer(jsonMode: boolean): Printer {
  return {
    jsonMode,
    result(data, human) {
      if (jsonMode || !human) process.stdout.write(`${json(data)}\n`);
      else {
        const text = human();
        if (text) process.stdout.write(`${text}\n`);
      }
    },
    info(message) {
      if (!jsonMode) process.stderr.write(`${message}\n`);
    },
    warn(message) {
      process.stderr.write(`${errColor.yellow("!")} ${message}\n`);
    },
  };
}
