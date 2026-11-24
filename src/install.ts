/**
 * `cueston init`: find where a project renders its HTML shell and add the Cueston snippet there.
 * Pure (files in, patched text out) so it can be tested without a disk or a network.
 *
 * The snippet is the same one Settings → Install and /api/public/agent-setup hand out
 * (web/components/settings/install-snippets.ts): a queue stub so Cueston.identify() can run
 * before the SDK loads, then the async SDK with the workspace's publishable key.
 */

export const QUEUE_STUB =
  '!function(w){var c=w.Cueston=w.Cueston||{};c.q=c.q||[];["init","identify","reset","page","track","start","show","dismiss","on","off","destroy"].forEach(function(m){c[m]=c[m]||function(){c.q.push([m].concat([].slice.call(arguments)))}})}(window);';

export const sdkUrl = (origin: string) => `${origin.replace(/\/+$/, "")}/sdk/v1/cueston.js`;

export type TargetKind = "next-app" | "next-pages" | "html";

export interface Target {
  kind: TargetKind;
  /** Path relative to the project root. */
  file: string;
  /** What it is, for messages: "Next.js App Router root layout". */
  label: string;
}

export interface ProjectFiles {
  exists(path: string): boolean;
  read(path: string): string | null;
}

const LABELS: Record<TargetKind, string> = {
  "next-app": "Next.js App Router root layout",
  "next-pages": "Next.js Pages Router _document",
  html: "HTML shell",
};

const target = (kind: TargetKind, file: string): Target => ({ kind, file, label: LABELS[kind] });

const variants = (base: string, exts = ["tsx", "jsx", "ts", "js"]) => exts.map((ext) => `${base}.${ext}`);

/**
 * Where the snippet goes, in the order a project most likely renders its shell:
 * Next.js App Router layout → Pages Router _document → index.html (Vite, plain sites) →
 * public/index.html (Create React App). Null when none is found (print the snippet instead).
 */
export function detectTarget(files: ProjectFiles): Target | null {
  const pkgText = files.read("package.json");
  let deps: Record<string, string> = {};
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText);
      deps = { ...pkg.dependencies, ...pkg.devDependencies };
    } catch {
      // A broken package.json isn't ours to fix: fall through to the HTML files.
    }
  }

  if (deps.next) {
    for (const dir of ["app", "src/app"])
      for (const file of variants(`${dir}/layout`)) if (files.exists(file)) return target("next-app", file);
    for (const dir of ["pages", "src/pages"])
      for (const file of variants(`${dir}/_document`)) if (files.exists(file)) return target("next-pages", file);
  }
  for (const file of ["index.html", "public/index.html", "src/index.html"])
    if (files.exists(file)) return target("html", file);
  return null;
}

export type PatchResult =
  | { status: "patched"; text: string }
  | { status: "already-installed" }
  /** The file doesn't have the anchor we insert at (</head>, </body>, <Head>): show the snippet. */
  | { status: "no-anchor"; anchor: string };

const INSTALLED = /\/sdk\/v1\/cueston\.js/;

/** The indentation of the line `index` sits on, so inserted lines line up with their neighbours. */
function indentAt(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return text.slice(lineStart, index).match(/^[ \t]*/)?.[0] ?? "";
}

function insertBefore(text: string, index: number, lines: string[], extraIndent = "  "): string {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const indent = indentAt(text, lineStart + (text.slice(lineStart).match(/^[ \t]*/)?.[0].length ?? 0));
  const inline = text.slice(lineStart, index).trim() !== "";
  // `<body>{children}</body>` on one line: break it, so every tag gets its own line
  const block = inline
    ? lines.map((line) => `\n${indent}${extraIndent}${line}`).join("") + `\n${indent}`
    : lines.map((line) => `${extraIndent}${line}\n${indent}`).join("");
  return text.slice(0, index) + block + text.slice(index);
}

function addScriptImport(text: string): string {
  if (/import\s+Script\s+from\s+["']next\/script["']/.test(text)) return text;
  // `import x from "y"`, `import { a,\n b } from "y"` and side-effect `import "./x.css"`
  // (specifiers never contain quotes, so the optional part can't run into the next statement)
  const imports = [...text.matchAll(/^import\s(?:[^;'"]*?\sfrom\s+)?["'][^"']+["'];?[^\n]*\n/gm)];
  const last = imports.at(-1);
  const at = last ? last.index! + last[0].length : 0;
  return `${text.slice(0, at)}import Script from "next/script";\n${text.slice(at)}`;
}

export function patchFile(kind: TargetKind, text: string, publicKey: string, origin: string): PatchResult {
  if (INSTALLED.test(text)) return { status: "already-installed" };
  const src = sdkUrl(origin);

  if (kind === "html") {
    const at = text.search(/<\/head>/i);
    if (at < 0) return { status: "no-anchor", anchor: "</head>" };
    return {
      status: "patched",
      text: insertBefore(text, at, [
        "<!-- Cueston: tours, tooltips and banners -->",
        `<script>${QUEUE_STUB}</script>`,
        `<script src="${src}" data-key="${publicKey}" async></script>`,
      ]),
    };
  }

  const scripts = [
    `<Script id="cueston-queue" strategy="beforeInteractive">`,
    `  {\`${QUEUE_STUB}\`}`,
    `</Script>`,
    `<Script src="${src}" data-key="${publicKey}" strategy="afterInteractive" />`,
  ];

  if (kind === "next-app") {
    const at = text.search(/<\/body>/);
    if (at < 0) return { status: "no-anchor", anchor: "</body>" };
    return { status: "patched", text: addScriptImport(insertBefore(text, at, scripts)) };
  }

  // next-pages: beforeInteractive scripts belong inside <Head> in _document
  const selfClosing = text.match(/<Head\s*\/>/);
  if (selfClosing) {
    const indent = indentAt(text, selfClosing.index!);
    const body = scripts.map((line) => `${indent}  ${line}\n`).join("");
    const replaced = `${text.slice(0, selfClosing.index!)}<Head>\n${body}${indent}</Head>${text.slice(selfClosing.index! + selfClosing[0].length)}`;
    return { status: "patched", text: addScriptImport(replaced) };
  }
  const close = text.search(/<\/Head>/);
  if (close < 0) return { status: "no-anchor", anchor: "<Head>" };
  return { status: "patched", text: addScriptImport(insertBefore(text, close, scripts)) };
}

/** The snippet to print when there's nothing to patch automatically. */
export function htmlSnippet(publicKey: string, origin: string): string {
  return `<script>${QUEUE_STUB}</script>\n<script src="${sdkUrl(origin)}" data-key="${publicKey}" async></script>`;
}

export const IDENTIFY_SNIPPET = `Cueston.identify(user.id, { name: user.name, email: user.email, role: user.role, plan: user.plan });
// and when they sign out:
Cueston.reset();`;

/**
 * `init` edits a file, so it must be able to ask first: a terminal to ask in, or --yes, or
 * --dry-run (which writes nothing). Checked before sign-in, so nobody approves a browser
 * sign-in only to be told to start over with --yes.
 */
export function needsYesFirst(options: { yes?: boolean; dryRun?: boolean; interactive: boolean }): boolean {
  return !options.yes && !options.dryRun && !options.interactive;
}

export interface Hunk {
  /** 1-based line in the original file where the change starts. */
  line: number;
  removed: string[];
  added: string[];
}

/**
 * The lines `after` adds to (and replaces in) `before`, as hunks with line numbers: what
 * `--dry-run` prints. A plain LCS over lines; install targets are small files.
 */
export function lineDiff(before: string, after: string): Hunk[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let i = 0;
  let j = 0;
  const open = () => (current ??= { line: i + 1, removed: [], added: [] });
  const close = () => {
    if (current) hunks.push(current);
    current = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      close();
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      open().added.push(b[j++]);
    } else {
      open().removed.push(a[i++]);
    }
  }
  close();
  return hunks;
}
