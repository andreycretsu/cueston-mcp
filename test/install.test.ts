import { describe, expect, it } from "vitest";
import { detectTarget, lineDiff, needsYesFirst, patchFile, QUEUE_STUB, type ProjectFiles } from "../src/install";

const KEY = "pk_test_abc123456";
const ORIGIN = "https://app.cueston.com";
const SDK = "https://app.cueston.com/sdk/v1/cueston.js";

const project = (files: Record<string, string>): ProjectFiles => ({
  exists: (path) => path in files,
  read: (path) => files[path] ?? null,
});
const nextPkg = JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } });

describe("detectTarget", () => {
  it("Next.js App Router: the root layout, also under src/", () => {
    expect(detectTarget(project({ "package.json": nextPkg, "app/layout.tsx": "" }))).toMatchObject({ kind: "next-app", file: "app/layout.tsx" });
    expect(detectTarget(project({ "package.json": nextPkg, "src/app/layout.js": "" }))).toMatchObject({ kind: "next-app", file: "src/app/layout.js" });
  });

  it("Next.js Pages Router: _document", () => {
    expect(detectTarget(project({ "package.json": nextPkg, "pages/_document.tsx": "" }))).toMatchObject({ kind: "next-pages", file: "pages/_document.tsx" });
  });

  it("Vite and plain sites: index.html; Create React App: public/index.html", () => {
    expect(detectTarget(project({ "package.json": "{}", "index.html": "" }))).toMatchObject({ kind: "html", file: "index.html" });
    expect(detectTarget(project({ "public/index.html": "" }))).toMatchObject({ kind: "html", file: "public/index.html" });
  });

  it("nothing recognizable, or a broken package.json, is not a crash", () => {
    expect(detectTarget(project({ "package.json": "{oops" }))).toBeNull();
    expect(detectTarget(project({}))).toBeNull();
  });
});

describe("patchFile", () => {
  it("index.html: both tags before </head>, indented like the head", () => {
    const html = "<html>\n  <head>\n    <title>App</title>\n  </head>\n  <body></body>\n</html>\n";
    const result = patchFile("html", html, KEY, ORIGIN);
    expect(result.status).toBe("patched");
    const text = (result as { text: string }).text;
    expect(text).toContain(`    <script>${QUEUE_STUB}</script>\n`);
    expect(text).toContain(`    <script src="${SDK}" data-key="${KEY}" async></script>\n  </head>`);
    expect(text.indexOf("cueston.js")).toBeLessThan(text.indexOf("</head>"));
  });

  it("Next.js App Router: next/script import and both <Script> tags before </body>", () => {
    const layout = `import type { Metadata } from "next";
import "./globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
`;
    const text = (patchFile("next-app", layout, KEY, ORIGIN) as { text: string }).text;
    expect(text).toContain('import "./globals.css";\nimport Script from "next/script";\n');
    expect(text).toContain('<Script id="cueston-queue" strategy="beforeInteractive">');
    expect(text).toContain(`{\`${QUEUE_STUB}\`}`);
    expect(text).toContain(`<Script src="${SDK}" data-key="${KEY}" strategy="afterInteractive" />\n      </body>`);
    expect(text.indexOf("{children}")).toBeLessThan(text.indexOf("cueston-queue"));
  });

  it("</body> on the same line as {children}: the tags still get their own lines", () => {
    const layout = 'export default function L({ children }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n';
    const text = (patchFile("next-app", layout, KEY, ORIGIN) as { text: string }).text;
    expect(text).toContain('      <body>{children}\n        <Script id="cueston-queue"');
    expect(text).toContain('strategy="afterInteractive" />\n      </body>');
  });

  it("keeps an existing next/script import instead of adding a second", () => {
    const layout = 'import Script from "next/script";\nexport default function L({ children }) { return <html><body>{children}</body></html>; }\n';
    const text = (patchFile("next-app", layout, KEY, ORIGIN) as { text: string }).text;
    expect(text.match(/import Script from "next\/script"/g)).toHaveLength(1);
  });

  it("Next.js Pages Router: inside <Head>, also when it's self-closing", () => {
    const open = (patchFile("next-pages", "<Html>\n  <Head>\n  </Head>\n</Html>", KEY, ORIGIN) as { text: string }).text;
    expect(open.indexOf("cueston-queue")).toBeLessThan(open.indexOf("</Head>"));
    const closed = (patchFile("next-pages", "<Html>\n  <Head />\n</Html>", KEY, ORIGIN) as { text: string }).text;
    expect(closed).toMatch(/<Head>\n[\s\S]*cueston-queue[\s\S]*<\/Head>/);
    expect(closed).not.toContain("<Head />");
  });

  it("running it again changes nothing", () => {
    const once = (patchFile("html", "<head></head>", KEY, ORIGIN) as { text: string }).text;
    expect(patchFile("html", once, KEY, ORIGIN)).toEqual({ status: "already-installed" });
  });

  it("no place to insert: says which anchor is missing, edits nothing", () => {
    expect(patchFile("html", "<div>no head</div>", KEY, ORIGIN)).toEqual({ status: "no-anchor", anchor: "</head>" });
    expect(patchFile("next-app", "export default () => null", KEY, ORIGIN)).toEqual({ status: "no-anchor", anchor: "</body>" });
  });

  it("only the publishable key ever goes into a file", () => {
    const text = (patchFile("html", "<head></head>", KEY, ORIGIN) as { text: string }).text;
    expect(text).not.toMatch(/sk_/);
  });
});

describe("needsYesFirst (checked before sign-in)", () => {
  it("no terminal and neither --yes nor --dry-run: stop before signing in", () => {
    expect(needsYesFirst({ interactive: false })).toBe(true);
  });
  it("a terminal, --yes or --dry-run: go ahead", () => {
    expect(needsYesFirst({ interactive: true })).toBe(false);
    expect(needsYesFirst({ interactive: false, yes: true })).toBe(false);
    expect(needsYesFirst({ interactive: false, dryRun: true })).toBe(false);
  });
});

describe("lineDiff (what --dry-run prints)", () => {
  it("index.html: one hunk with the three added lines, at the </head> line", () => {
    const before = "<html>\n  <head>\n    <title>A</title>\n  </head>\n</html>";
    const after = (patchFile("html", before, KEY, ORIGIN) as { text: string }).text;
    const hunks = lineDiff(before, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].line).toBe(4);
    expect(hunks[0].removed).toEqual([]);
    expect(hunks[0].added).toHaveLength(3);
    expect(hunks[0].added[2]).toContain(`data-key="${KEY}"`);
  });

  it("Next.js layout: the import and the scripts as two separate hunks", () => {
    const before = 'import "./globals.css";\n\nexport default function L({ children }) {\n  return (\n    <html>\n      <body>\n        {children}\n      </body>\n    </html>\n  );\n}\n';
    const after = (patchFile("next-app", before, KEY, ORIGIN) as { text: string }).text;
    const hunks = lineDiff(before, after);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toEqual({ line: 2, removed: [], added: ['import Script from "next/script";'] });
    expect(hunks[1].added).toHaveLength(4);
  });

  it("a replaced line shows as removed and added (self-closing <Head />)", () => {
    const before = "<Html>\n  <Head />\n</Html>";
    const after = (patchFile("next-pages", before, KEY, ORIGIN) as { text: string }).text;
    const hunks = lineDiff(before, after);
    expect(hunks.some((hunk) => hunk.removed.includes("  <Head />"))).toBe(true);
  });

  it("no change, no hunks", () => {
    expect(lineDiff("a\nb", "a\nb")).toEqual([]);
  });
});
