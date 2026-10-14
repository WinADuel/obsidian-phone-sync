import { normalizePath, type DataAdapter } from "obsidian";
import type { LocalFileStat, LocalFs } from "./core/types.ts";

// The vault through Obsidian's DataAdapter. The adapter (unlike vault.getFiles)
// also sees dot-folders such as .obsidian, which is where plugins live.

export class ObsidianFs implements LocalFs {
  constructor(private adapter: DataAdapter) {}

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
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
    }
    await this.adapter.writeBinary(path, data);
    const stat = await this.adapter.stat(path);
    return { mtime: stat?.mtime ?? Date.now(), size: stat?.size ?? data.byteLength };
  }

  trash(path: string): Promise<void> {
    // Moves the file into the vault's .trash folder, which this plugin never syncs.
    return this.adapter.trashLocal(path);
  }

  exists(path: string): Promise<boolean> {
    return this.adapter.exists(path);
  }
}
