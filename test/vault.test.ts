// End-to-end sync of a real vault: GitHub is stood in for by a bare clone of
// the vault (pushes go through the same blob/tree/commit/ref steps the GitHub
// API takes), the phone by an empty temp folder, and a desktop by a git
// checkout pushing to the same bare repo. Run with
//   VAULT_REPO=/path/to/vault/checkout npm test
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DEFAULT_EXCLUDES, PathFilter } from "../src/core/filter.ts";
import { pull } from "../src/core/pull.ts";
import { sync } from "../src/core/sync.ts";
import { emptyState, type LocalFs, type Remote, type SyncState } from "../src/core/types.ts";

const source = process.env.VAULT_REPO;
const work = mkdtempSync(join(tmpdir(), "vault-"));
const repo = join(work, "github.git");
if (source) execFileSync("git", ["clone", "-q", "--bare", source, repo]);
const branch = source ? execFileSync("git", ["-C", source, "rev-parse", "--abbrev-ref", "HEAD"]).toString().trim() : "";
const gitIn = (dir: string, args: string[], input?: Buffer | string, env?: Record<string, string>) =>
  execFileSync("git", ["-C", dir, ...args], { maxBuffer: 1 << 30, input, env: { ...process.env, ...env } });
const git = (...args: string[]) => gitIn(repo, args);
const toBuf = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const who = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

const gitRemote: Remote = {
  async head() {
    const commitSha = git("rev-parse", `refs/heads/${branch}`).toString().trim();
    return { commitSha, treeSha: git("rev-parse", `${commitSha}^{tree}`).toString().trim() };
  },
  async push(parentCommit, parentTree, changes, message) {
    const index = join(work, "push-index");
    const env = { ...who, GIT_INDEX_FILE: index };
    gitIn(repo, ["read-tree", parentTree], undefined, env);
    for (const c of changes) {
      if (c.data === null) {
        gitIn(repo, ["update-index", "--index-info"], `0 ${"0".repeat(40)}\t${c.path}\n`, env);
      } else {
        const sha = gitIn(repo, ["hash-object", "-w", "--stdin"], Buffer.from(c.data)).toString().trim();
        gitIn(repo, ["update-index", "--add", "--cacheinfo", `${c.mode},${sha},${c.path}`], undefined, env);
      }
    }
    const tree = gitIn(repo, ["write-tree"], undefined, env).toString().trim();
    const commit = gitIn(repo, ["commit-tree", tree, "-p", parentCommit, "-m", message], undefined, env).toString().trim();
    try {
      // Like GitHub's non-forced ref update: only moves if the branch is still at parentCommit.
      git("update-ref", `refs/heads/${branch}`, commit, parentCommit);
    } catch {
      return { ok: false, reason: "moved" };
    }
    return { ok: true, commitSha: commit };
  },
  async listFiles(tree) {
    // "<mode> blob <sha> <size>\t<path>", NUL-separated so paths with spaces survive.
    return git("ls-tree", "-r", "-l", "-z", tree)
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split("\t");
        const [mode, type, sha, size] = meta.split(/\s+/);
        return { mode, type, path, sha, size: Number(size) };
      })
      .filter((e) => e.type === "blob");
  },
  async readBlob(sha) {
    return toBuf(git("cat-file", "blob", sha));
  },
};

function dirFs(root: string): LocalFs & { trashed: string[] } {
  const trashed: string[] = [];
  return {
    trashed,
    async list(skipDir) {
      const out: { path: string; mtime: number; size: number }[] = [];
      const walk = (rel: string) => {
        for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
          const p = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) {
            if (!skipDir(p)) walk(p);
          } else {
            const s = statSync(join(root, p));
            out.push({ path: p, mtime: s.mtimeMs, size: s.size });
          }
        }
      };
      walk("");
      return out;
    },
    async read(p) {
      return toBuf(readFileSync(join(root, p)));
    },
    async write(p, data) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), Buffer.from(data));
      const s = statSync(join(root, p));
      return { mtime: s.mtimeMs, size: s.size };
    },
    async trash(p) {
      mkdirSync(dirname(join(root, ".trash", p)), { recursive: true });
      renameSync(join(root, p), join(root, ".trash", p));
      trashed.push(p);
    },
    async exists(p) {
      try {
        statSync(join(root, p));
        return true;
      } catch {
        return false;
      }
    },
  };
}

test("syncs a real vault with a phone folder and a desktop checkout", { skip: !source && "set VAULT_REPO" }, async () => {
  const phone = mkdtempSync(join(tmpdir(), "phone-"));
  const fs = dirFs(phone);
  let state: SyncState = emptyState();
  const filter = new PathFilter(DEFAULT_EXCLUDES);
  const opts = {
    filter,
    maxFileBytes: 25 * 1024 * 1024,
    maxDeletes: 20,
    dryRun: false,
    today: "2026-10-14",
    saveState: async (s: SyncState) => {
      state = s;
    },
  };

  const started = Date.now();
  const r = await pull(gitRemote, fs, state, opts);
  const seconds = (Date.now() - started) / 1000;
  assert.deepEqual(r.errors, []);

  const expected = (await gitRemote.listFiles((await gitRemote.head()).treeSha)).filter((f) => !filter.excludes(f.path));
  assert.equal(r.downloaded.length, expected.length);
  for (const f of expected) {
    assert.deepEqual(readFileSync(join(phone, f.path)), git("cat-file", "blob", f.sha), f.path);
  }
  console.log(`pulled ${r.downloaded.length} files in ${seconds}s, skipped ${r.skippedLarge.length} large`);

  // Re-running is a no-op.
  const again = await pull(gitRemote, fs, state, opts);
  assert.deepEqual([again.downloaded, again.deleted, again.pendingPush, again.conflicts], [[], [], [], []]);

  // The phone edits, adds and deletes notes, then syncs.
  const notes = expected.filter((f) => f.path.endsWith(".md") && !f.path.startsWith("."));
  const [edited, deleted, deskEdited] = [notes[0].path, notes[1].path, notes[2].path];
  const added = "Phone Notes/From my iPhone 2026-10-14.md";
  writeFileSync(join(phone, edited), readFileSync(join(phone, edited), "utf8") + "\nAdded on the phone.\n");
  await fs.write(added, new TextEncoder().encode("# From the phone\n").buffer as ArrayBuffer);
  renameSync(join(phone, deleted), join(work, "gone.md"));
  const before = (await gitRemote.head()).commitSha;
  const syncOpts = { ...opts, message: "vault backup (iPhone): test" };
  const pushed = await sync(gitRemote, fs, state, syncOpts);
  assert.deepEqual(pushed.errors, []);
  assert.deepEqual(pushed.pushed, [added, deleted, edited].sort());
  const changed = git("diff", "--name-status", before, `refs/heads/${branch}`).toString().trim().split("\n").sort();
  assert.deepEqual(changed, [`A\t${added}`, `D\t${deleted}`, `M\t${edited}`].sort());
  assert.equal(git("rev-parse", `refs/heads/${branch}^`).toString().trim(), before);

  // A desktop (Obsidian Git) pulls the phone's commit, edits another note and pushes.
  const desktop = join(work, "desktop");
  execFileSync("git", ["clone", "-q", "--branch", branch, repo, desktop]);
  assert.match(readFileSync(join(desktop, edited), "utf8"), /Added on the phone\./);
  writeFileSync(join(desktop, deskEdited), "Rewritten on the Mac.\n");
  gitIn(desktop, ["commit", "-qam", "vault backup: desktop"], undefined, who);
  gitIn(desktop, ["push", "-q", "origin", branch]);

  // The phone edits a different note in the meantime; its sync pulls the desktop edit and pushes on top.
  writeFileSync(join(phone, edited), "Second phone edit.\n");
  const both = await sync(gitRemote, fs, state, syncOpts);
  assert.deepEqual(both.errors, []);
  assert.deepEqual(both.downloaded, [deskEdited]);
  assert.deepEqual(both.pushed, [edited]);
  assert.equal(readFileSync(join(phone, deskEdited), "utf8"), "Rewritten on the Mac.\n");
  gitIn(desktop, ["pull", "-q", "--ff-only"]);
  assert.equal(readFileSync(join(desktop, edited), "utf8"), "Second phone edit.\n");

  const settled = await sync(gitRemote, fs, state, syncOpts);
  assert.deepEqual([settled.pushed, settled.downloaded], [[], []]);
});
