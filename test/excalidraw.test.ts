import { strict as assert } from "node:assert";
import { test } from "node:test";
import LZString from "lz-string";
import { isDrawing, mergeDrawing } from "../src/core/excalidraw.ts";
import { DEFAULT_EXCLUDES, PathFilter } from "../src/core/filter.ts";
import { sync } from "../src/core/sync.ts";
import { emptyState, type SyncState } from "../src/core/types.ts";
import { bytes, FakeFs, FakeRemote, text } from "./fakes.ts";

type El = { id: string; version: number; versionNonce?: number; type?: string; text?: string };

/** A drawing as the Excalidraw plugin saves it: compressed scene, 256-char lines. */
function drawing(elements: El[], opts: { textSection?: string; layout?: "wrapped" | "single" } = {}): string {
  const json = JSON.stringify({ type: "excalidraw", version: 2, elements, appState: {}, files: {} });
  const c = LZString.compressToBase64(json);
  const body = opts.layout === "single" ? c : (c.match(/.{1,256}/g) ?? []).join("\n\n");
  return [
    "---",
    "",
    "excalidraw-plugin: parsed",
    "tags: [excalidraw]",
    "",
    "---",
    "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==",
    "",
    "# Excalidraw Data",
    "",
    "## Text Elements",
    opts.textSection ?? "",
    "%%",
    "## Drawing",
    "```compressed-json",
    body,
    "```",
    "%%",
  ].join("\n");
}

function scene(data: string | ArrayBuffer): El[] {
  const s = typeof data === "string" ? data : text(data);
  const m = /```compressed-json\n([\s\S]*?)\n```/.exec(s)!;
  return JSON.parse(LZString.decompressFromBase64(m[1].replace(/\s/g, ""))).elements;
}

const ids = (els: El[]) => els.map((e) => `${e.id}:${e.version}`);
const stroke = (id: string, version = 1): El => ({ id, version, versionNonce: version, type: "freedraw" });

test("recognizes drawings by name or front matter", () => {
  assert.ok(isDrawing("a/Drawing 1.excalidraw.md", bytes("")));
  assert.ok(isDrawing("a/Drawing 1.excalidraw (GitHub conflict 2026-11-05 2).md", bytes("")));
  assert.ok(isDrawing("a/board.excalidraw", bytes("{}")));
  assert.ok(isDrawing("Excalidraw/Tryna draw.md", bytes(drawing([]))));
  assert.ok(!isDrawing("notes/plain.md", bytes("---\ntags: [x]\n---\nhello")));
});

test("strokes drawn on both sides are all kept", () => {
  const base = drawing([stroke("a")]);
  const ours = drawing([stroke("a"), stroke("b")]);
  const theirs = drawing([stroke("a"), stroke("c")]);
  const r = mergeDrawing(bytes(base), bytes(ours), bytes(theirs));
  assert.equal(r.kind, "merged");
  assert.deepEqual(ids(scene((r as { data: ArrayBuffer }).data)), ["a:1", "b:1", "c:1"]);
});

test("the newer version of an element wins, and untouched deletions stick", () => {
  const base = drawing([stroke("a"), stroke("b"), stroke("c")]);
  const ours = drawing([stroke("a", 3), stroke("b")]); // moved a, erased c
  const theirs = drawing([stroke("a", 2), stroke("b", 5), stroke("c")]); // edited a less, edited b
  const r = mergeDrawing(bytes(base), bytes(ours), bytes(theirs));
  assert.equal(r.kind, "merged");
  assert.deepEqual(ids(scene((r as { data: ArrayBuffer }).data)), ["a:3", "b:5"]);
});

test("an element one side erased but the other edited is kept", () => {
  const base = drawing([stroke("a")]);
  const r = mergeDrawing(bytes(base), bytes(drawing([])), bytes(drawing([stroke("a", 2)])));
  assert.deepEqual(ids(scene((r as { data: ArrayBuffer }).data)), ["a:2"]);
});

test("a drawing the other side only re-saved, or saved earlier, keeps ours untouched", () => {
  const els = [stroke("a"), stroke("b")];
  const ours = drawing([...els, stroke("c")]);
  assert.equal(mergeDrawing(bytes(drawing(els)), bytes(ours), bytes(drawing(els, { layout: "single" }))).kind, "keepOurs");
  assert.equal(mergeDrawing(null, bytes(ours), bytes(drawing([stroke("a")]))).kind, "keepOurs");
});

test("their text edits, or a drawing that won't decompress, are left to a conflict copy", () => {
  const base = drawing([{ id: "t", version: 1, type: "text", text: "hi" }], { textSection: "hi ^t\n" });
  const theirs = drawing([{ id: "t", version: 2, type: "text", text: "hello" }], { textSection: "hello ^t\n" });
  assert.equal(mergeDrawing(bytes(base), bytes(base), bytes(theirs)).kind, "unmergeable");
  const broken = drawing([stroke("a")]).replace(/```compressed-json\n./, "```compressed-json\n!");
  assert.equal(mergeDrawing(null, bytes(broken), bytes(drawing([]))).kind, "unmergeable");
});

test("sync merges a drawing changed on both devices, with no conflict copy", async () => {
  const remote = new FakeRemote();
  const fs = new FakeFs();
  let state: SyncState = emptyState();
  const run = () =>
    sync(remote, fs, state, {
      filter: new PathFilter(DEFAULT_EXCLUDES),
      maxFileBytes: 1_000_000,
      maxDeletes: 20,
      dryRun: false,
      today: "2026-11-05",
      message: "vault backup (iPad)",
      saveState: async (s) => {
        state = s;
      },
    });
  const path = "School/Drawing 2026-11-05 12.37.01.excalidraw.md";
  await remote.set({ [path]: drawing([stroke("a")]) });
  await run();

  fs.put(path, drawing([stroke("a"), stroke("ipad")]));
  await remote.set({ [path]: drawing([stroke("a"), stroke("iphone")]) });
  const r = await run();
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.merged, [path]);
  assert.deepEqual(ids(scene(fs.get(path)!)), ["a:1", "ipad:1", "iphone:1"]);
  assert.equal(remote.snapshot()[path], fs.get(path));

  // Only re-saved on the other device: the iPad's file is not rewritten.
  fs.put(path, drawing([stroke("a"), stroke("ipad"), stroke("iphone"), stroke("more")]));
  const before = fs.get(path);
  await remote.set({ [path]: drawing([stroke("a"), stroke("ipad"), stroke("iphone")], { layout: "single" }) });
  const writes = fs.files.get(path)!.mtime;
  const again = await run();
  assert.deepEqual(again.conflicts, []);
  assert.equal(fs.files.get(path)!.mtime, writes);
  assert.equal(remote.snapshot()[path], before);
});
