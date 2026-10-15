import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { PushChange, PushResult, Remote, RemoteFile } from "./core/types.ts";

// GitHub REST API through Obsidian's requestUrl, which works on iOS without CORS
// problems. Pushing uses the Git Data API: blobs, one tree, one commit, then a
// non-forced branch update, so a desktop push in between is detected, never overwritten.

export class GitHubRemote implements Remote {
  constructor(
    private owner: string,
    private repo: string,
    private branch: string,
    private token: string,
  ) {}

  async head(): Promise<{ commitSha: string; treeSha: string }> {
    const ref = await this.json(`/git/ref/heads/${encodeURIComponent(this.branch)}`);
    const commitSha: string = ref.object.sha;
    const commit = await this.json(`/git/commits/${commitSha}`);
    return { commitSha, treeSha: commit.tree.sha };
  }

  async listFiles(treeSha: string): Promise<RemoteFile[]> {
    const tree = await this.json(`/git/trees/${treeSha}?recursive=1`);
    if (tree.truncated) {
      throw new Error("GitHub returned a truncated file list; the repo has too many files for one request.");
    }
    return (tree.tree as { path: string; type: string; sha: string; size?: number; mode: string }[])
      .filter((e) => e.type === "blob")
      .map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0, mode: e.mode }));
  }

  async push(parentCommit: string, parentTree: string, changes: PushChange[], message: string): Promise<PushResult> {
    const entries: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
    const queue = [...changes];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let c = queue.shift(); c; c = queue.shift()) {
          let sha: string | null = null;
          if (c.data) {
            const blob = await this.send("POST", "/git/blobs", { content: toBase64(c.data), encoding: "base64" });
            sha = blob.json.sha;
          }
          entries.push({ path: c.path, mode: c.mode, type: "blob", sha });
        }
      }),
    );
    const tree = await this.send("POST", "/git/trees", { base_tree: parentTree, tree: entries });
    const commit = await this.send("POST", "/git/commits", {
      message,
      tree: tree.json.sha,
      parents: [parentCommit],
    });
    const ref = await this.send(
      "PATCH",
      `/git/refs/heads/${encodeURIComponent(this.branch)}`,
      { sha: commit.json.sha, force: false },
      [422],
    );
    // 422 "Update is not a fast forward": someone pushed since we pulled.
    if (ref.status === 422) return { ok: false, reason: "moved" };
    return { ok: true, commitSha: commit.json.sha };
  }

  async readBlob(sha: string): Promise<ArrayBuffer> {
    const res = await this.request(`/git/blobs/${sha}`, "application/vnd.github.raw+json");
    return res.arrayBuffer;
  }

  /** Cheap call used by the settings tab to check the token and repo. */
  async check(): Promise<string> {
    const repo = await this.json("");
    return `Connected to ${repo.full_name} (${repo.private ? "private" : "public"}).`;
  }

  private async json(path: string): Promise<any> {
    return (await this.request(path, "application/vnd.github+json")).json;
  }

  private send(method: string, path: string, body: unknown, allow: number[] = []): Promise<RequestUrlResponse> {
    return this.request(path, "application/vnd.github+json", { method, body: JSON.stringify(body) }, allow);
  }

  private async request(
    path: string,
    accept: string,
    extra: { method?: string; body?: string } = {},
    allow: number[] = [],
  ): Promise<RequestUrlResponse> {
    const res = await requestUrl({
      url: `https://api.github.com/repos/${this.owner}/${this.repo}${path}`,
      method: extra.method ?? "GET",
      body: extra.body,
      contentType: extra.body ? "application/json" : undefined,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      throw: false,
    });
    if (res.status >= 400 && !allow.includes(res.status)) {
      let detail = "";
      try {
        detail = res.json?.message ?? "";
      } catch {
        // body was not JSON
      }
      const hint =
        res.status === 401 ? " Check the token." :
        res.status === 404 ? " Check the owner, repo and branch, and that the token can read this repo." :
        res.status === 403 ? " The token may lack permission (Contents: Read and write), or the API rate limit was hit." : "";
      throw new Error(`GitHub ${res.status}${detail ? `: ${detail}` : ""}.${hint}`);
    }
    return res;
  }
}

function toBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
