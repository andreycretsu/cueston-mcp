import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findType } from "../src/content-types";
import { UsageError } from "../src/errors";
import {
  canonical,
  changedFields,
  editableFields,
  fileNameFor,
  fileShape,
  filterBySchema,
  readLocal,
  slugify,
  writeItem,
  type JsonSchema,
} from "../src/sync";

const tour = findType("tours")!;
const banner = findType("banner")!;

const serverTour = {
  id: 12,
  name: "Welcome",
  urlPattern: "*",
  isActive: true,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  publication: { production: { versionId: 3 } },
  hasUnpublishedChanges: false,
  stepCount: 1,
  steps: [
    {
      id: 7,
      tourId: 12,
      stepOrder: 0,
      selector: "#a",
      title: "Hi",
      content: "Body",
      createdAt: "x",
    },
  ],
};

const updateTourSchema: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "number" },
    name: { type: "string" },
    urlPattern: { type: "string" },
    steps: {
      type: "array",
      items: { type: "object", properties: { id: {}, selector: {}, title: {}, content: {} } },
    },
  },
};

describe("canonical / fileShape", () => {
  it("ignores key order at every level but keeps array order", () => {
    expect(canonical({ b: 1, a: { d: 2, c: 3 } })).toBe(canonical({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });

  it("puts id first, then keys alphabetically", () => {
    expect(Object.keys(fileShape({ name: "x", id: 3, color: "y" }))).toEqual([
      "id",
      "color",
      "name",
    ]);
    expect(Object.keys(fileShape({ name: "x", color: "y" }))).toEqual(["color", "name"]);
  });
});

describe("file names", () => {
  it("are <id>-<slug>.json", () => {
    expect(slugify("Welcome tour: Billing & Plans!")).toBe("welcome-tour-billing-plans");
    expect(slugify("Ünïcödé café")).toBe("unicode-cafe");
    expect(slugify("", "tour")).toBe("tour");
    expect(slugify("x".repeat(80))).toHaveLength(50);
    expect(fileNameFor(12, "Welcome tour")).toBe("12-welcome-tour.json");
  });
});

describe("editable fields", () => {
  it("keep exactly what the update schema defines, steps included (with their ids)", () => {
    const fields = editableFields(serverTour, tour, updateTourSchema);
    expect(fields).toEqual({
      name: "Welcome",
      urlPattern: "*",
      steps: [{ id: 7, selector: "#a", title: "Hi", content: "Body" }],
    });
  });

  it("without a schema, drop server-managed fields by name", () => {
    const fields = editableFields(serverTour, tour, null);
    expect(fields).not.toHaveProperty("id");
    expect(fields).not.toHaveProperty("isActive");
    expect(fields).not.toHaveProperty("publication");
    expect(fields).not.toHaveProperty("createdAt");
    expect(fields).not.toHaveProperty("stepCount");
    expect(fields.steps).toEqual([{ id: 7, selector: "#a", title: "Hi", content: "Body" }]);
  });

  it("filterBySchema leaves unions and open objects alone", () => {
    expect(filterBySchema({ a: 1, b: 2 }, { anyOf: [{}, {}] })).toEqual({ a: 1, b: 2 });
    expect(
      filterBySchema({ a: 1, b: 2 }, { properties: { a: {} }, additionalProperties: {} })
    ).toEqual({ a: 1, b: 2 });
    expect(filterBySchema({ a: 1, b: 2 }, { properties: { a: {} } })).toEqual({ a: 1 });
  });
});

describe("changedFields (the push plan)", () => {
  const server = editableFields(serverTour, tour, updateTourSchema);

  it("is empty when the file matches the server, whatever the key order", () => {
    expect(
      changedFields({ id: 12, urlPattern: "*", name: "Welcome", steps: server.steps }, server)
    ).toEqual([]);
  });

  it("lists only the fields that differ", () => {
    const local = {
      id: 12,
      name: "Renamed",
      urlPattern: "*",
      steps: [{ ...(server.steps as any[])[0], title: "Edited" }],
    };
    expect(changedFields(local, server)).toEqual(["name", "steps"]);
  });

  it("ignores fields the file leaves out (they stay as they are)", () => {
    expect(changedFields({ id: 12, name: "Welcome" }, server)).toEqual([]);
  });
});

describe("local files", () => {
  const dir = () => {
    const root = mkdtempSync(join(tmpdir(), "cueston-sync-"));
    mkdirSync(join(root, "tours"));
    mkdirSync(join(root, "banners"));
    return root;
  };

  it("reads <dir>/<plural>/*.json; files without id are new items", () => {
    const root = dir();
    writeFileSync(
      join(root, "tours", "12-welcome.json"),
      JSON.stringify({ id: 12, name: "Welcome" })
    );
    writeFileSync(join(root, "banners", "new.json"), JSON.stringify({ name: "New" }));
    writeFileSync(join(root, "banners", "notes.txt"), "ignored");
    const items = readLocal(root, [tour, banner]);
    expect(items.map((item) => [item.def.type, item.id])).toEqual([
      ["tour", 12],
      ["banner", null],
    ]);
  });

  it("refuses duplicate ids, bad ids and broken JSON", () => {
    const root = dir();
    writeFileSync(join(root, "tours", "12-a.json"), JSON.stringify({ id: 12 }));
    writeFileSync(join(root, "tours", "12-b.json"), JSON.stringify({ id: 12 }));
    expect(() => readLocal(root, [tour])).toThrow(/Two files have tour id 12/);

    const second = dir();
    writeFileSync(join(second, "tours", "x.json"), JSON.stringify({ id: "12" }));
    expect(() => readLocal(second, [tour])).toThrow(UsageError);

    const third = dir();
    writeFileSync(join(third, "tours", "x.json"), "{oops");
    expect(() => readLocal(third, [tour])).toThrow(/Can't parse/);
  });

  it("writeItem names the file after the item and removes its old name", () => {
    const root = dir();
    writeFileSync(join(root, "tours", "new.json"), "{}");
    writeFileSync(join(root, "tours", "12-old-name.json"), "{}");
    writeFileSync(join(root, "tours", "120-other.json"), "{}");
    const file = writeItem(
      root,
      tour,
      12,
      { name: "New name", urlPattern: "*" },
      join(root, "tours", "new.json")
    );
    expect(file.endsWith(join("tours", "12-new-name.json"))).toBe(true);
    expect(readdirSync(join(root, "tours")).sort()).toEqual(["12-new-name.json", "120-other.json"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      id: 12,
      name: "New name",
      urlPattern: "*",
    });
    expect(readFileSync(file, "utf8").endsWith("}\n")).toBe(true);
    expect(existsSync(join(root, "tours", "new.json"))).toBe(false);
  });
});
