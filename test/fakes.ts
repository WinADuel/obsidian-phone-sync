import { gitBlobSha } from "../src/core/hash.ts";
import type { LocalFileStat, LocalFs, Remote, RemoteFile } from "../src/core/types.ts";

export const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
export const text = (b: ArrayBuffer): string => new TextDecoder().decode(b);

/** A GitHub branch held in memory: path -> contents. */
export class FakeRemote implements Remote {
  files = new Map<string, string>();
  blobs = new Map<string, ArrayBuffer>();
  commits = 0;
  failBlob = new Set<string>();

  async set(files: Record<string, string>): Promise<void> {
    this.files = new Map(Object.entries(files));
    this.commits++;
  }

  async head() {
    return { commitSha: `commit${this.commits}`, treeSha: `tree${this.commits}` };
  }

  async listFiles(): Promise<RemoteFile[]> {
    const out: RemoteFile[] = [];
    for (const [path, body] of this.files) {
      const data = bytes(body);
      const sha = await gitBlobSha(data);
      this.blobs.set(sha, data);
      out.push({ path, sha, size: data.byteLength });
    }
    return out;
  }

  async readBlob(sha: string): Promise<ArrayBuffer> {
    if (this.failBlob.has(sha)) throw new Error("network down");
    const b = this.blobs.get(sha);
    if (!b) throw new Error(`no blob ${sha}`);
    return b;
  }
}

/** A vault held in memory. Every write bumps a fake clock used as mtime. */
export class FakeFs implements LocalFs {
  files = new Map<string, { data: ArrayBuffer; mtime: number }>();
  trashed: string[] = [];
  reads = 0;
  private clock = 1;

  put(path: string, body: string): void {
    this.files.set(path, { data: bytes(body), mtime: this.clock++ });
  }

  get(path: string): string | undefined {
    const f = this.files.get(path);
    return f && text(f.data);
  }

  async list(skipDir: (dir: string) => boolean): Promise<LocalFileStat[]> {
    return [...this.files]
      .filter(([path]) => {
        const parts = path.split("/").slice(0, -1);
        return !parts.some((_, i) => skipDir(parts.slice(0, i + 1).join("/")));
      })
      .map(([path, f]) => ({ path, mtime: f.mtime, size: f.data.byteLength }));
  }

  async read(path: string): Promise<ArrayBuffer> {
    this.reads++;
    return this.files.get(path)!.data;
  }

  async write(path: string, data: ArrayBuffer) {
    const mtime = this.clock++;
    this.files.set(path, { data, mtime });
    return { mtime, size: data.byteLength };
  }

  async trash(path: string): Promise<void> {
    this.files.delete(path);
    this.trashed.push(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}
