// End-to-end pull of a real vault: GitHub is stood in for by a local git
// checkout, the phone by an empty temp folder. Run with
//   VAULT_REPO=/path/to/vault/checkout npm test
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DEFAULT_EXCLUDES, PathFilter } from "../src/core/filter.ts";
import { pull } from "../src/core/pull.ts";
import { emptyState, type LocalFs, type Remote, type SyncState } from "../src/core/types.ts";

const repo = process.env.VAULT_REPO;
const git = (...args: string[]) => execFileSync("git", ["-C", repo!, ...args], { maxBuffer: 1 << 30 });
const toBuf = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

const gitRemote: Remote = {
  async head() {
    return { commitSha: git("rev-parse", "HEAD").toString().trim(), treeSha: "HEAD" };
  },
  async listFiles(tree) {
    // "<mode> blob <sha> <size>\t<path>", NUL-separated so paths with spaces survive.
    return git("ls-tree", "-r", "-l", "-z", tree)
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split("\t");
        const [, type, sha, size] = meta.split(/\s+/);
        return { type, path, sha, size: Number(size) };
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

test("pulls a real vault into an empty folder byte for byte", { skip: !repo && "set VAULT_REPO" }, async () => {
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

  const expected = (await gitRemote.listFiles("HEAD")).filter((f) => !filter.excludes(f.path));
  assert.equal(r.downloaded.length, expected.length);
  for (const f of expected) {
    assert.deepEqual(readFileSync(join(phone, f.path)), git("cat-file", "blob", f.sha), f.path);
  }
  console.log(`pulled ${r.downloaded.length} files in ${seconds}s, skipped ${r.skippedLarge.length} large`);

  // Re-running is a no-op.
  const again = await pull(gitRemote, fs, state, opts);
  assert.deepEqual([again.downloaded, again.deleted, again.pendingPush, again.conflicts], [[], [], [], []]);
});
