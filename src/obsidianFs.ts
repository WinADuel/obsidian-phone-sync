import { normalizePath, TFile, type DataAdapter, type Vault } from "obsidian";
import type { LocalFileStat, LocalFs } from "./core/types.ts";

// The vault through Obsidian's DataAdapter. The adapter (unlike vault.getFiles)
// also sees dot-folders such as .obsidian, which is where plugins live.

export class ObsidianFs implements LocalFs {
  private adapter: DataAdapter;

  constructor(private vault: Vault) {
    this.adapter = vault.adapter;
  }

  async list(skipDir: (dirPath: string) => boolean): Promise<LocalFileStat[]> {
    const out: LocalFileStat[] = [];
    // Adapters differ on whether the root is "" or "/" and whether results carry a
    // leading slash; normalize to plain vault-relative paths.
    const clean = (p: string) => p.replace(/^\/+/, "");
    const walk = async (dir: string): Promise<void> => {
      const listed = await this.adapter.list(dir || "/");
      const files = listed.files.map(clean);
      const folders = listed.folders.map(clean);
      for (const path of files) {
        const stat = await this.adapter.stat(path);
        if (stat?.type === "file") out.push({ path, mtime: stat.mtime, size: stat.size });
      }
      for (const folder of folders) if (!skipDir(folder)) await walk(folder);
    };
    await walk("");
    return out;
  }

  read(path: string): Promise<ArrayBuffer> {
    return this.adapter.readBinary(path);
  }

  async write(path: string, data: ArrayBuffer): Promise<{ mtime: number; size: number }> {
    path = normalizePath(path);
    const open = this.vault.getAbstractFileByPath(path);
    if (open instanceof TFile) {
      // Through the vault, so open views hear about it: Excalidraw folds the new
      // version into a drawing you have open instead of saving over it.
      await this.vault.modifyBinary(open, data);
    } else {
      await this.makeParents(path);
      await this.adapter.writeBinary(path, data);
    }
    const stat = await this.adapter.stat(path);
    return { mtime: stat?.mtime ?? Date.now(), size: stat?.size ?? data.byteLength };
  }

  async rename(from: string, to: string): Promise<{ mtime: number; size: number }> {
    from = normalizePath(from);
    to = normalizePath(to);
    await this.makeParents(to);
    await this.adapter.rename(from, to);
    const stat = await this.adapter.stat(to);
    return { mtime: stat?.mtime ?? Date.now(), size: stat?.size ?? 0 };
  }

  trash(path: string): Promise<void> {
    // Moves the file into the vault's .trash folder, which this plugin never syncs.
    return this.adapter.trashLocal(path);
  }

  private async makeParents(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
    }
  }

  async removeEmptyFolders(filePaths: string[]): Promise<void> {
    // Deepest folders first, so a parent emptied by its child's removal goes too.
    const dirs = new Set<string>();
    for (const p of filePaths) {
      const parts = normalizePath(p).split("/").slice(0, -1);
      for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    for (const dir of [...dirs].sort((a, b) => b.split("/").length - a.split("/").length)) {
      try {
        if (!(await this.adapter.exists(dir))) continue;
        const listed = await this.adapter.list(dir);
        if (listed.files.length || listed.folders.length) continue;
        await this.adapter.rmdir(dir, false);
      } catch {
        // Leave a folder we can't inspect or remove; it's only tidying.
      }
    }
  }

  exists(path: string): Promise<boolean> {
    return this.adapter.exists(path);
  }
}
