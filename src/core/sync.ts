import { gitBlobSha } from "./hash.ts";
import { pull, type PullOptions, type PullReport } from "./pull.ts";
import type { LocalFs, PushChange, Remote, SyncState } from "./types.ts";

export interface SyncOptions extends PullOptions {
  /** Commit message for the phone's changes. */
  message: string;
}

export interface SyncReport extends PullReport {
  /** Paths sent to GitHub in this sync (deletions included). */
  pushed: string[];
  /** The commit the push created, if any. */
  pushedCommit?: string;
}

/** How many times to re-pull and retry when a desktop pushes in the middle of a sync. */
const ATTEMPTS = 3;

/**
 * Pull GitHub's changes, then send the phone's changes back as one commit on top
 * of what was just pulled. If the branch moved in between, pull again and retry.
 */
export async function sync(remote: Remote, fs: LocalFs, state: SyncState, opts: SyncOptions): Promise<SyncReport> {
  let current = state;
  const saveState = async (s: SyncState) => {
    current = s;
    await opts.saveState(s);
  };

  for (let attempt = 1; ; attempt++) {
    const report: SyncReport = { ...(await pull(remote, fs, current, { ...opts, saveState })), pushed: [] };
    if (opts.dryRun || report.blocked || report.errors.length || report.toPush.length === 0) return report;

    const deletes = report.toPush.filter((c) => c.sha === null).length;
    if (deletes > opts.maxDeletes) {
      report.blocked = `This sync would delete ${deletes} files on GitHub, more than the limit of ${opts.maxDeletes}. Nothing was sent.`;
      return report;
    }

    // Read each file now and hash what was read, so an edit made while syncing is
    // recorded exactly as sent (and any later edit shows up as a change next time).
    const changes: PushChange[] = [];
    const sentShas: Record<string, string | null> = {};
    for (const c of report.toPush) {
      const data = c.sha === null ? null : await fs.read(c.path);
      sentShas[c.path] = data === null ? null : await gitBlobSha(data);
      changes.push({ path: c.path, mode: c.mode, data });
    }
    const result = await remote.push(report.head.commitSha, report.head.treeSha, changes, opts.message);
    if (!result.ok) {
      if (attempt < ATTEMPTS) continue;
      report.errors.push({ path: "", message: "GitHub kept changing during the sync; try again in a moment." });
      return report;
    }

    // GitHub now holds the phone's versions, so they become the new base.
    const next: SyncState = { ...current, base: { ...current.base }, commit: result.commitSha };
    for (const [path, sha] of Object.entries(sentShas)) {
      if (sha === null) delete next.base[path];
      else next.base[path] = sha;
    }
    await saveState(next);
    report.pushed = report.toPush.map((c) => c.path).sort();
    report.pushedCommit = result.commitSha;
    return report;
  }
}
