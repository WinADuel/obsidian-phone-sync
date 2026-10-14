import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { Remote, RemoteFile } from "./core/types.ts";

// GitHub REST API through Obsidian's requestUrl, which works on iOS without CORS
// problems. Only read endpoints for now; pushing comes in a later step.

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
    return (tree.tree as { path: string; type: string; sha: string; size?: number }[])
      .filter((e) => e.type === "blob")
      .map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 }));
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

  private async request(path: string, accept: string): Promise<RequestUrlResponse> {
    const res = await requestUrl({
      url: `https://api.github.com/repos/${this.owner}/${this.repo}${path}`,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      throw: false,
    });
    if (res.status >= 400) {
      let detail = "";
      try {
        detail = res.json?.message ?? "";
      } catch {
        // body was not JSON
      }
      const hint =
        res.status === 401 ? " Check the token." :
        res.status === 404 ? " Check the owner, repo and branch, and that the token can read this repo." :
        res.status === 403 ? " The token may lack permission, or the API rate limit was hit." : "";
      throw new Error(`GitHub ${res.status}${detail ? `: ${detail}` : ""}.${hint}`);
    }
    return res;
  }
}
