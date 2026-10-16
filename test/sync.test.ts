import { strict as assert } from "node:assert";
import { test } from "node:test";
import { defaultExcludes, PathFilter } from "../src/core/filter.ts";
import { mergeText } from "../src/core/merge3.ts";
import { sync, type SyncOptions } from "../src/core/sync.ts";
import { emptyState, type SyncState } from "../src/core/types.ts";
import { bytes, FakeFs, FakeRemote, text } from "./fakes.ts";

function setup() {
  const remote = new FakeRemote();
  const fs = new FakeFs();
  let state: SyncState = emptyState();
  const run = (o: Partial<SyncOptions> = {}) =>
    sync(remote, fs, state, {
      filter: new PathFilter(defaultExcludes(".obsidian")),
      configDir: ".obsidian",
      maxFileBytes: 1000,
      maxDeletes: 20,
      dryRun: false,
      today: "2026-10-14",
      message: "vault backup (iPhone)",
      saveState: async (s) => {
        state = s;
      },
      ...o,
    });
  return { remote, fs, run, state: () => state };
}

test("phone edits, new files and deletions go up as one commit", async () => {
  const { remote, fs, run } = setup();
  await remote.set({ "a.md": "1", "b.md": "1", "c.md": "1" });
  await run();

  fs.put("a.md", "edited on phone");
  fs.put("Daily/new.md", "new");
  fs.files.delete("c.md");
  const r = await run();
  assert.deepEqual(r.pushed, ["Daily/new.md", "a.md", "c.md"]);
  assert.deepEqual(remote.snapshot(), { "a.md": "edited on phone", "b.md": "1", "Daily/new.md": "new" });
  assert.equal(remote.pushes.length, 1);

  // Nothing left to send afterwards.
  const again = await run();
  assert.deepEqual([again.pushed, again.downloaded, again.pendingPush], [[], [], []]);
  assert.equal(remote.pushes.length, 1);
});

test("a desktop push during the sync is pulled in, then the phone's change is retried", async () => {
  const { remote, fs, run } = setup();
  await remote.set({ "a.md": "1", "b.md": "1" });
  await run();

  fs.put("a.md", "phone");
  remote.beforeNextPush = () => remote.set({ "a.md": "1", "b.md": "desktop" });
  const r = await run();
  assert.deepEqual(remote.snapshot(), { "a.md": "phone", "b.md": "desktop" });
  assert.equal(fs.get("b.md"), "desktop");
  assert.deepEqual(r.pushed, ["a.md"]);
});

test("a note edited on both sides is merged line by line when the edits don't overlap", async () => {
  const { remote, fs, run } = setup();
  const note = "# Title\n\nfirst\n\nmiddle\n\nlast\n";
  await remote.set({ "n.md": note });
  await run();

  fs.put("n.md", note.replace("first", "first, from the phone"));
  await remote.set({ "n.md": note.replace("last", "last, from the Mac") });
  const r = await run();
  const merged = "# Title\n\nfirst, from the phone\n\nmiddle\n\nlast, from the Mac\n";
  assert.deepEqual(r.merged, ["n.md"]);
  assert.deepEqual(r.conflicts, []);
  assert.equal(fs.get("n.md"), merged);
  assert.equal(remote.snapshot()["n.md"], merged);
});

test("overlapping edits keep the phone's note, save GitHub's as a copy, and send both", async () => {
  const { remote, fs, run } = setup();
  await remote.set({ "n.md": "line\n" });
  await run();

  fs.put("n.md", "phone line\n");
  await remote.set({ "n.md": "mac line\n" });
  const r = await run();
  const copy = "n (GitHub conflict 2026-10-14).md";
  assert.deepEqual(r.conflicts.map((c) => [c.path, c.copy]), [["n.md", copy]]);
  assert.deepEqual(remote.snapshot(), { "n.md": "phone line\n", [copy]: "mac line\n" });
});

test("non-note files edited on both sides become conflict copies, not merges", async () => {
  const { remote, fs, run } = setup();
  await remote.set({ "board.canvas": "{}" });
  await run();
  fs.put("board.canvas", '{"a":1}');
  await remote.set({ "board.canvas": '{"b":1}' });
  const r = await run();
  assert.equal(r.conflicts.length, 1);
});

test("first sync of a new phone vault sends up only what the phone added", async () => {
  const { remote, fs, run } = setup();
  fs.put(".obsidian/app.json", "{}");
  fs.put(".obsidian/community-plugins.json", '["obsidian42-brat","obsidian-phone-sync"]');
  fs.put(".obsidian/plugins/obsidian42-brat/main.js", "brat");
  fs.put(".obsidian/plugins/obsidian42-brat/data.json", '{"token":"secret"}');
  fs.put(".obsidian/plugins/obsidian-phone-sync/data.json", "{}");
  fs.put(".obsidian/workspace-mobile.json", "{}");
  await remote.set({
    ".obsidian/app.json": '{"vimMode":true}',
    ".obsidian/community-plugins.json": '["dataview"]',
    "Note.md": "hi",
  });
  const r = await run();
  assert.deepEqual(r.pushed, [".obsidian/community-plugins.json", ".obsidian/plugins/obsidian42-brat/main.js"]);
  const after = remote.snapshot();
  assert.deepEqual(JSON.parse(after[".obsidian/community-plugins.json"]), [
    "dataview",
    "obsidian42-brat",
    "obsidian-phone-sync",
  ]);
  assert.equal(after[".obsidian/app.json"], '{"vimMode":true}');
  assert.equal(after[".obsidian/plugins/obsidian42-brat/data.json"], undefined);
  assert.equal(after[".obsidian/workspace-mobile.json"], undefined);
});

test("deleting many files on the phone stops before anything is sent", async () => {
  const { remote, fs, run } = setup();
  await remote.set({ "a.md": "1", "b.md": "1", "c.md": "1" });
  await run();
  fs.files.clear();
  const r = await run({ maxDeletes: 2 });
  assert.match(r.blocked ?? "", /delete 3 files on GitHub/);
  assert.equal(Object.keys(remote.snapshot()).length, 3);
});

test("preview sends nothing", async () => {
  const { remote, fs, run } = setup();
  await remote.set({ "a.md": "1" });
  await run();
  fs.put("a.md", "2");
  const r = await run({ dryRun: true });
  assert.deepEqual(r.pendingPush, ["a.md"]);
  assert.deepEqual(r.pushed, []);
  assert.equal(remote.snapshot()["a.md"], "1");
});

test("an executable file keeps its mode when edited on the phone", async () => {
  const { remote, fs, run } = setup();
  await remote.set({ "run.sh": "echo 1" });
  remote.modes.set("run.sh", "100755");
  await run();
  fs.put("run.sh", "echo 2");
  await run();
  assert.equal(remote.modes.get("run.sh"), "100755");
});

test("mergeText refuses non-text and merges disjoint edits", () => {
  const m = mergeText(bytes("a\nb\nc\nd\n"), bytes("A\nb\nc\nd\n"), bytes("a\nb\nc\nD\n"));
  assert.equal(m && text(m), "A\nb\nc\nD\n");
  assert.equal(mergeText(bytes("x"), new Uint8Array([0xff, 0xfe]).buffer as ArrayBuffer, bytes("y")), null);
});
