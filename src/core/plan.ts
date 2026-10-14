// Decides what a pull does to each path by comparing three snapshots:
//   base   - blob SHA both sides agreed on at the last sync
//   local  - blob SHA of the file on the phone now
//   remote - blob SHA on GitHub now
// `undefined` means the file does not exist in that snapshot.

export type PullAction =
  /** Take GitHub's version: the phone has not touched this file since the last sync. */
  | { kind: "download"; path: string; sha: string }
  /** GitHub deleted it and the phone has not touched it. */
  | { kind: "delete"; path: string }
  /** Both sides changed it. Keep the phone's copy and save GitHub's next to it. */
  | { kind: "conflict"; path: string; sha: string }
  /** Only the phone changed it (edit, new file or deletion); left for the push step. */
  | { kind: "pendingPush"; path: string };

export interface PullPlan {
  actions: PullAction[];
  /** Paths already identical on both sides, with their SHA. */
  same: Record<string, string>;
}

export function planPull(
  base: Record<string, string>,
  local: Record<string, string>,
  remote: Record<string, string>,
): PullPlan {
  const actions: PullAction[] = [];
  const same: Record<string, string> = {};
  const paths = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);

  for (const path of [...paths].sort()) {
    const b = base[path];
    const l = local[path];
    const r = remote[path];

    if (l === r) {
      if (r !== undefined) same[path] = r;
      continue; // identical, or deleted on both sides
    }
    if (l === b) {
      // The phone has not changed it, so follow GitHub.
      actions.push(r === undefined ? { kind: "delete", path } : { kind: "download", path, sha: r });
      continue;
    }
    if (r === b) {
      actions.push({ kind: "pendingPush", path });
      continue;
    }
    // Both changed since the last sync.
    if (l === undefined) {
      // Deleted on the phone but edited on GitHub: keep the edited copy.
      actions.push({ kind: "download", path, sha: r! });
    } else if (r === undefined) {
      // Edited on the phone but deleted on GitHub: keep the edited copy.
      actions.push({ kind: "pendingPush", path });
    } else {
      actions.push({ kind: "conflict", path, sha: r });
    }
  }
  return { actions, same };
}

/** "Folder/Note.md" -> "Folder/Note (GitHub conflict 2026-10-14).md" */
export function conflictCopyPath(path: string, date: string, n = 1): string {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const tag = n > 1 ? `GitHub conflict ${date} ${n}` : `GitHub conflict ${date}`;
  return `${dir}${stem} (${tag})${ext}`;
}
