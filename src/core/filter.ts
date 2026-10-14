// Which paths the phone leaves alone. Patterns are one per line:
//   folder/      a folder anywhere it is named by its full path from the vault root
//   name         a file or folder with this exact name at any depth (e.g. .DS_Store)
//   path/to/file an exact vault-relative path
//   *.ext        any file ending in .ext
// Blank lines and lines starting with # are ignored.

export const DEFAULT_EXCLUDES = [
  "# Git and Obsidian internals",
  ".git/",
  ".trash/",
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  "# This plugin's own settings and sync state stay on this device",
  ".obsidian/plugins/obsidian-phone-sync/",
  "# BRAT's settings hold the token it uses to install this plugin",
  ".obsidian/plugins/obsidian42-brat/data.json",
  "# Per-device caches",
  ".DS_Store",
  ".smart-env/",
  ".copilot/",
].join("\n");

export class PathFilter {
  private folders: string[] = [];
  private names = new Set<string>();
  private exact = new Set<string>();
  private suffixes: string[] = [];

  constructor(patterns: string) {
    for (const raw of patterns.split(/\r?\n/)) {
      const p = raw.trim();
      if (!p || p.startsWith("#")) continue;
      if (p.endsWith("/")) this.folders.push(p);
      else if (p.startsWith("*.")) this.suffixes.push(p.slice(1));
      else if (p.includes("/")) this.exact.add(p);
      else this.names.add(p);
    }
  }

  /** True if this file path should not be synced. */
  excludes(path: string): boolean {
    if (this.exact.has(path)) return true;
    if (this.folders.some((f) => path.startsWith(f))) return true;
    if (this.suffixes.some((s) => path.endsWith(s))) return true;
    return path.split("/").some((part) => this.names.has(part));
  }

  /** True if nothing inside this folder can be synced, so listing can skip it. */
  excludesDir(dirPath: string): boolean {
    const withSlash = dirPath.endsWith("/") ? dirPath : dirPath + "/";
    if (this.folders.some((f) => withSlash.startsWith(f))) return true;
    return dirPath.split("/").some((part) => this.names.has(part));
  }
}
