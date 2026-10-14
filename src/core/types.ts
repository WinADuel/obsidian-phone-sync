// Shared types for the sync engine. Nothing in src/core imports "obsidian",
// so the engine can be tested in plain Node with fakes.

/** A file in the GitHub tree, identified by its git blob SHA. */
export interface RemoteFile {
  path: string;
  sha: string;
  size: number;
}

/** A file on the phone, before hashing. */
export interface LocalFileStat {
  path: string;
  mtime: number;
  size: number;
}

/** Read access to one branch of a GitHub repo. */
export interface Remote {
  /** The commit the branch points at, and that commit's root tree. */
  head(): Promise<{ commitSha: string; treeSha: string }>;
  /** Every file (blob) in a tree, recursively. */
  listFiles(treeSha: string): Promise<RemoteFile[]>;
  /** Raw bytes of one blob. */
  readBlob(sha: string): Promise<ArrayBuffer>;
}

/** The vault on this device. Paths are vault-relative with "/" separators. */
export interface LocalFs {
  /** Every file under the vault root, skipping folders `skipDir` returns true for. */
  list(skipDir: (dirPath: string) => boolean): Promise<LocalFileStat[]>;
  read(path: string): Promise<ArrayBuffer>;
  /** Write bytes, creating parent folders as needed. Returns the new file's stat. */
  write(path: string, data: ArrayBuffer): Promise<{ mtime: number; size: number }>;
  /** Move a file somewhere recoverable instead of deleting it outright. */
  trash(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/** What the phone remembers between syncs. */
export interface SyncState {
  /** Commit SHA of the last successful sync, or null before the first one. */
  commit: string | null;
  /** path -> blob SHA as of `commit`, for files both sides agreed on. */
  base: Record<string, string>;
  /** path -> hash of the local file, reused while mtime and size are unchanged. */
  hashCache: Record<string, { mtime: number; size: number; sha: string }>;
}

export const emptyState = (): SyncState => ({ commit: null, base: {}, hashCache: {} });
