import { gitBlobSha } from "./hash.ts";
import { PathFilter } from "./filter.ts";
import { conflictCopyPath, planPull, type PullAction } from "./plan.ts";
import type { LocalFs, Remote, SyncState } from "./types.ts";

export interface PullOptions {
  filter: PathFilter;
  /** Files larger than this many bytes are skipped on both sides. */
  maxFileBytes: number;
  /** Stop instead of deleting when one pull would delete more files than this. */
  maxDeletes: number;
  /** Plan only; change nothing. */
  dryRun: boolean;
  /** Called after each file is written or deleted, so progress survives a crash. */
  saveState: (state: SyncState) => Promise<void>;
  /** Today's date as YYYY-MM-DD, used to name conflict copies. */
  today: string;
}

export interface PullReport {
  commit: string;
  dryRun: boolean;
  downloaded: string[];
  deleted: string[];
  conflicts: { path: string; copy: string }[];
  /** Phone settings files replaced by GitHub's on the first pull (old copy in trash). */
  replaced: string[];
  /** Files merged automatically, such as the enabled-plugins list. */
  merged: string[];
  pendingPush: string[];
  skippedLarge: string[];
  errors: { path: string; message: string }[];
  /** Set when the deletion brake stopped the pull before it changed anything. */
  blocked?: string;
}

const CONCURRENCY = 4;

export async function pull(
  remote: Remote,
  fs: LocalFs,
  state: SyncState,
  opts: PullOptions,
): Promise<PullReport> {
  const { filter, maxFileBytes } = opts;
  const head = await remote.head();

  // Remote snapshot.
  const skippedLarge = new Set<string>();
  const remoteShas: Record<string, string> = {};
  for (const f of await remote.listFiles(head.treeSha)) {
    if (filter.excludes(f.path)) continue;
    if (f.size > maxFileBytes) skippedLarge.add(f.path);
    else remoteShas[f.path] = f.sha;
  }

  // Local snapshot, hashing only files whose size or mtime changed.
  const localShas: Record<string, string> = {};
  const hashCache: SyncState["hashCache"] = {};
  for (const stat of await fs.list((dir) => filter.excludesDir(dir))) {
    if (filter.excludes(stat.path)) continue;
    if (stat.size > maxFileBytes) {
      skippedLarge.add(stat.path);
      continue;
    }
    const cached = state.hashCache[stat.path];
    const sha =
      cached && cached.mtime === stat.mtime && cached.size === stat.size
        ? cached.sha
        : await gitBlobSha(await fs.read(stat.path));
    localShas[stat.path] = sha;
    hashCache[stat.path] = { mtime: stat.mtime, size: stat.size, sha };
  }
  for (const path of skippedLarge) {
    delete remoteShas[path];
    delete localShas[path];
  }

  const base = Object.fromEntries(
    Object.entries(state.base).filter(([p]) => !filter.excludes(p) && !skippedLarge.has(p)),
  );
  const plan = planPull(base, localShas, remoteShas);

  const report: PullReport = {
    commit: head.commitSha,
    dryRun: opts.dryRun,
    downloaded: [],
    deleted: [],
    conflicts: [],
    replaced: [],
    merged: [],
    pendingPush: [],
    skippedLarge: [...skippedLarge].sort(),
    errors: [],
  };
  const deletes = plan.actions.filter((a) => a.kind === "delete").length;
  if (deletes > opts.maxDeletes) {
    report.blocked = `This pull would delete ${deletes} files, more than the limit of ${opts.maxDeletes}. Nothing was changed.`;
  }

  const firstPull = state.commit === null;
  if (opts.dryRun || report.blocked) {
    for (const a of plan.actions) recordPlanned(report, a, firstPull);
    return report;
  }

  // New state starts from what both sides already agree on; each applied action adds to it.
  const next: SyncState = { commit: state.commit, base: { ...plan.same }, hashCache };
  // Paths excluded or skipped this time keep their old base, so changing the
  // filter later does not turn them into conflicts.
  for (const [p, sha] of Object.entries(state.base)) if (!(p in base)) next.base[p] = sha;
  for (const a of plan.actions) {
    if (a.kind === "pendingPush" && base[a.path] !== undefined) next.base[a.path] = base[a.path];
  }

  const apply = async (a: PullAction): Promise<void> => {
    try {
      switch (a.kind) {
        case "download": {
          const stat = await fs.write(a.path, await remote.readBlob(a.sha));
          next.base[a.path] = a.sha;
          next.hashCache[a.path] = { ...stat, sha: a.sha };
          report.downloaded.push(a.path);
          break;
        }
        case "delete":
          await fs.trash(a.path);
          delete next.hashCache[a.path];
          report.deleted.push(a.path);
          break;
        case "conflict": {
          const theirs = await remote.readBlob(a.sha);
          const how = conflictStrategy(a.path, firstPull);
          if (how === "mergeList") {
            const merged = mergeJsonLists(await fs.read(a.path), theirs);
            const stat = await fs.write(a.path, merged);
            // GitHub's list is the base; the plugins only the phone enables wait for push.
            next.base[a.path] = a.sha;
            next.hashCache[a.path] = { ...stat, sha: await gitBlobSha(merged) };
            report.merged.push(a.path);
          } else if (how === "takeRemote") {
            await fs.trash(a.path);
            const stat = await fs.write(a.path, theirs);
            next.base[a.path] = a.sha;
            next.hashCache[a.path] = { ...stat, sha: a.sha };
            report.replaced.push(a.path);
          } else {
            let n = 1;
            let copy = conflictCopyPath(a.path, opts.today);
            while (await fs.exists(copy)) copy = conflictCopyPath(a.path, opts.today, ++n);
            await fs.write(copy, theirs);
            // Recording GitHub's version as the base means the phone's copy is treated
            // as the newer edit; GitHub's version is kept in the conflict copy.
            next.base[a.path] = a.sha;
            report.conflicts.push({ path: a.path, copy });
          }
          break;
        }
        case "pendingPush":
          report.pendingPush.push(a.path);
          return;
      }
      await opts.saveState(next);
    } catch (e) {
      report.errors.push({ path: a.path, message: e instanceof Error ? e.message : String(e) });
      // Keep the old base for a failed path so the next pull retries it.
      if (base[a.path] !== undefined && next.base[a.path] === undefined) next.base[a.path] = base[a.path];
    }
  };

  const queue = [...plan.actions];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let a = queue.shift(); a; a = queue.shift()) await apply(a);
    }),
  );

  if (report.errors.length === 0) next.commit = head.commitSha;
  await opts.saveState(next);
  for (const list of [report.downloaded, report.deleted, report.pendingPush, report.replaced, report.merged]) list.sort();
  return report;
}

function recordPlanned(report: PullReport, a: PullAction, firstPull: boolean): void {
  if (a.kind === "download") report.downloaded.push(a.path);
  else if (a.kind === "delete") report.deleted.push(a.path);
  else if (a.kind === "pendingPush") report.pendingPush.push(a.path);
  else {
    const how = conflictStrategy(a.path, firstPull);
    if (how === "mergeList") report.merged.push(a.path);
    else if (how === "takeRemote") report.replaced.push(a.path);
    else report.conflicts.push({ path: a.path, copy: "(conflict copy)" });
  }
}

const PLUGIN_LIST = ".obsidian/community-plugins.json";

/**
 * How to settle a file changed on both sides.
 * - The enabled-plugins list is merged, so neither side's plugins get switched off.
 * - On the first pull, the phone's .obsidian files are just a new vault's defaults,
 *   so GitHub's settings win and the phone's go to the trash.
 * - Everything else keeps the phone's copy and saves GitHub's beside it.
 */
export function conflictStrategy(path: string, firstPull: boolean): "mergeList" | "takeRemote" | "copy" {
  if (path === PLUGIN_LIST) return "mergeList";
  if (firstPull && path.startsWith(".obsidian/")) return "takeRemote";
  return "copy";
}

/** Union of two JSON string arrays, GitHub's order first. Falls back to GitHub's if either is not a list. */
export function mergeJsonLists(ours: ArrayBuffer, theirs: ArrayBuffer): ArrayBuffer {
  const parse = (b: ArrayBuffer): unknown => {
    try {
      return JSON.parse(new TextDecoder().decode(b));
    } catch {
      return null;
    }
  };
  const a = parse(theirs);
  const b = parse(ours);
  if (!Array.isArray(a) || !Array.isArray(b)) return theirs;
  const merged = [...a, ...b.filter((x) => !a.includes(x))];
  return new TextEncoder().encode(JSON.stringify(merged, null, 2)).buffer as ArrayBuffer;
}
