import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_EXCLUDES, PathFilter } from "../src/core/filter.ts";
import { gitBlobSha } from "../src/core/hash.ts";
import { conflictCopyPath, planPull } from "../src/core/plan.ts";
import { pull, type PullOptions } from "../src/core/pull.ts";
import { emptyState, type SyncState } from "../src/core/types.ts";
import { bytes, FakeFs, FakeRemote } from "./fakes.ts";

test("blob hash matches git hash-object", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hash-"));
  for (const body of ["", "hello\n", "ünïcödé ✓\r\n", "x".repeat(100_000)]) {
    const file = join(dir, "f");
    writeFileSync(file, body);
    const expected = execFileSync("git", ["hash-object", file]).toString().trim();
    assert.equal(await gitBlobSha(bytes(body)), expected);
  }
});

test("default excludes", () => {
  const f = new PathFilter(DEFAULT_EXCLUDES);
  for (const p of [
    ".DS_Store",
    "School/.DS_Store",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    ".smart-env/smart_env.json",
    ".copilot/model-catalog-cache.json",
    ".obsidian/plugins/obsidian-phone-sync/data.json",
    ".trash/old.md",
  ]) assert.ok(f.excludes(p), p);
  for (const p of [
    "Note.md",
    ".obsidian/app.json",
    ".obsidian/community-plugins.json",
    ".obsidian/plugins/obsidian-git/data.json",
    ".obsidian/plugins/copilot/main.js",
    "Personal/Vault/300 Books/House of Leaves.pdf",
  ]) assert.ok(!f.excludes(p), p);
  assert.ok(f.excludesDir(".git"));
  assert.ok(f.excludesDir(".obsidian/plugins/obsidian-phone-sync"));
  assert.ok(!f.excludesDir(".obsidian/plugins"));
  assert.ok(new PathFilter("*.pdf").excludes("a/b.pdf"));
});

test("plan covers every base/local/remote combination", () => {
  const plan = planPull(
    { same: "A", localEdit: "A", remoteEdit: "A", both: "A", remoteDel: "A", localDel: "A", delEdit: "A", editDel: "A", bothDel: "A" },
    { same: "A", localEdit: "B", remoteEdit: "A", both: "B", remoteDel: "A", newLocal: "N", delEdit: undefined as never, editDel: "B", newBoth: "X" },
    { same: "A", localEdit: "A", remoteEdit: "C", both: "C", localDel: "A", newRemote: "R", delEdit: "C", newBoth: "Y" },
  );
  const kinds = Object.fromEntries(plan.actions.map((a) => [a.path, a.kind]));
  assert.deepEqual(kinds, {
    localEdit: "pendingPush",
    remoteEdit: "download",
    both: "conflict",
    remoteDel: "delete",
    localDel: "pendingPush",
    delEdit: "download",
    editDel: "pendingPush",
    newLocal: "pendingPush",
    newRemote: "download",
    newBoth: "conflict",
  });
  assert.deepEqual(plan.same, { same: "A" });
});

test("conflict copy names", () => {
  assert.equal(conflictCopyPath("a/Note.md", "2026-10-14"), "a/Note (GitHub conflict 2026-10-14).md");
  assert.equal(conflictCopyPath("README", "2026-10-14", 2), "README (GitHub conflict 2026-10-14 2)");
  assert.equal(conflictCopyPath(".obsidian/app.json", "d"), ".obsidian/app (GitHub conflict d).json");
});

function setup() {
  const remote = new FakeRemote();
  const fs = new FakeFs();
  let state: SyncState = emptyState();
  const run = async (o: Partial<PullOptions> = {}) => {
    const report = await pull(remote, fs, state, {
      filter: new PathFilter(DEFAULT_EXCLUDES),
      maxFileBytes: 1000,
      maxDeletes: 20,
      dryRun: false,
      today: "2026-10-14",
      saveState: async (s) => {
        state = s;
      },
      ...o,
    });
    return report;
  };
  return { remote, fs, run, state: () => state };
}

test("first pull fills an empty vault and skips excluded and large files", async () => {
  const { remote, fs, run, state } = setup();
  await remote.set({
    "Note.md": "hi",
    "Folder/Deep/Other.md": "there",
    ".obsidian/plugins/copilot/main.js": "code",
    ".obsidian/workspace.json": "layout",
    "Big.pdf": "x".repeat(2000),
  });
  const r = await run();
  assert.deepEqual(r.downloaded, [".obsidian/plugins/copilot/main.js", "Folder/Deep/Other.md", "Note.md"]);
  assert.deepEqual(r.skippedLarge, ["Big.pdf"]);
  assert.equal(fs.get("Folder/Deep/Other.md"), "there");
  assert.equal(fs.get(".obsidian/workspace.json"), undefined);
  assert.equal(state().commit, "commit1");

  // A second pull changes nothing and re-reads no files thanks to the hash cache.
  fs.reads = 0;
  const again = await run();
  assert.deepEqual([again.downloaded, again.deleted, again.pendingPush, again.conflicts], [[], [], [], []]);
  assert.equal(fs.reads, 0);
});

test("later pulls follow GitHub, keep phone edits, and make conflict copies", async () => {
  const { remote, fs, run } = setup();
  await remote.set({ "a.md": "1", "b.md": "1", "c.md": "1", "d.md": "1" });
  await run();

  fs.put("b.md", "phone edit");
  fs.put("c.md", "phone edit");
  fs.put("new-on-phone.md", "new");
  await remote.set({ "a.md": "desktop edit", "b.md": "1", "c.md": "desktop edit", "e.md": "new" });

  const r = await run();
  assert.deepEqual(r.downloaded, ["a.md", "e.md"]);
  assert.deepEqual(r.deleted, ["d.md"]);
  assert.deepEqual(r.pendingPush, ["b.md", "new-on-phone.md"]);
  assert.deepEqual(r.conflicts, [{ path: "c.md", copy: "c (GitHub conflict 2026-10-14).md" }]);
  assert.equal(fs.get("a.md"), "desktop edit");
  assert.equal(fs.get("b.md"), "phone edit");
  assert.equal(fs.get("c.md"), "phone edit");
  assert.equal(fs.get("c (GitHub conflict 2026-10-14).md"), "desktop edit");
  assert.deepEqual(fs.trashed, ["d.md"]);

  // The conflict is settled: the phone's c.md now counts as the newer edit.
  const after = await run();
  assert.deepEqual(after.conflicts, []);
  assert.ok(after.pendingPush.includes("c.md"));
});

test("a non-empty vault on first pull gets conflict copies, never overwrites", async () => {
  const { remote, fs, run } = setup();
  fs.put("a.md", "phone version");
  await remote.set({ "a.md": "github version" });
  const r = await run();
  assert.equal(fs.get("a.md"), "phone version");
  assert.equal(r.conflicts.length, 1);
});

test("dry run and the deletion brake change nothing", async () => {
  const { remote, fs, run, state } = setup();
  await remote.set({ "a.md": "1", "b.md": "1", "c.md": "1" });
  const preview = await run({ dryRun: true });
  assert.equal(preview.downloaded.length, 3);
  assert.equal(fs.files.size, 0);
  assert.equal(state().commit, null);

  await run();
  await remote.set({});
  const blocked = await run({ maxDeletes: 2 });
  assert.match(blocked.blocked ?? "", /delete 3 files/);
  assert.equal(fs.files.size, 3);
});

test("a failed download is retried on the next pull", async () => {
  const { remote, fs, run, state } = setup();
  await remote.set({ "a.md": "1", "b.md": "2" });
  await remote.listFiles();
  const shaB = await gitBlobSha(bytes("2"));
  remote.failBlob.add(shaB);
  const r = await run();
  assert.deepEqual(r.errors.map((e) => e.path), ["b.md"]);
  assert.equal(state().commit, null);

  remote.failBlob.clear();
  const retry = await run();
  assert.deepEqual(retry.downloaded, ["b.md"]);
  assert.equal(fs.get("b.md"), "2");
  assert.equal(state().commit, "commit1");
});

test("first pull into a fresh vault takes GitHub's settings and merges the plugin list", async () => {
  const { remote, fs, run } = setup();
  // What a brand-new phone vault looks like after installing BRAT and this plugin.
  fs.put(".obsidian/app.json", "{}");
  fs.put(".obsidian/community-plugins.json", '["obsidian42-brat","obsidian-phone-sync"]');
  await remote.set({
    ".obsidian/app.json": '{"vimMode":true}',
    ".obsidian/community-plugins.json": '["dataview","obsidian-git"]',
    "Note.md": "hi",
  });
  const r = await run();
  assert.deepEqual(r.replaced, [".obsidian/app.json"]);
  assert.deepEqual(r.merged, [".obsidian/community-plugins.json"]);
  assert.deepEqual(r.conflicts, []);
  assert.equal(fs.get(".obsidian/app.json"), '{"vimMode":true}');
  assert.deepEqual(JSON.parse(fs.get(".obsidian/community-plugins.json")!), [
    "dataview",
    "obsidian-git",
    "obsidian42-brat",
    "obsidian-phone-sync",
  ]);
  assert.deepEqual(fs.trashed, [".obsidian/app.json"]);

  // Later, a settings file changed on both sides is a normal conflict again.
  fs.put(".obsidian/app.json", '{"vimMode":false}');
  await remote.set({
    ".obsidian/app.json": '{"vimMode":true,"x":1}',
    ".obsidian/community-plugins.json": '["dataview","obsidian-git"]',
    "Note.md": "hi",
  });
  const later = await run();
  assert.deepEqual(later.replaced, []);
  assert.equal(later.conflicts.length, 1);
  // The phone-only plugins in the merged list wait to be pushed.
  assert.ok(later.pendingPush.includes(".obsidian/community-plugins.json"));
});
