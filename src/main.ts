import { App, debounce, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_EXCLUDES, PathFilter } from "./core/filter.ts";
import { pull } from "./core/pull.ts";
import { sync, type SyncReport } from "./core/sync.ts";
import { emptyState, type SyncState } from "./core/types.ts";
import { GitHubRemote } from "./github.ts";
import { ObsidianFs } from "./obsidianFs.ts";

interface Settings {
  owner: string;
  repo: string;
  branch: string;
  excludes: string;
  maxFileMB: number;
  maxDeletes: number;
  /** Sync when Obsidian opens (kept under its old name so saved settings carry over). */
  pullOnOpen: boolean;
  /** Sync this often while Obsidian is open; 0 turns it off. */
  syncEveryMinutes: number;
  /** Sync shortly after you stop editing. */
  syncAfterEdits: boolean;
  /** The plugin list syncs to the desktops too; stay idle there unless asked. */
  allowOnDesktop: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  owner: "WinADuel",
  repo: "Obsidian_Everything",
  branch: "main",
  excludes: DEFAULT_EXCLUDES,
  maxFileMB: 25,
  maxDeletes: 20,
  pullOnOpen: true,
  syncEveryMinutes: 5,
  syncAfterEdits: true,
  allowOnDesktop: false,
};

const TOKEN_ID = "obsidian-phone-sync-github-token";
const EDIT_QUIET_MS = 30_000;

type Mode = "sync" | "pull" | "preview";
type StoredReport = SyncReport & { at: string; mode: Mode };

interface Stored {
  settings: Settings;
  state: SyncState;
  lastReport?: StoredReport;
}

export default class PhoneSyncPlugin extends Plugin {
  settings: Settings = DEFAULT_SETTINGS;
  state: SyncState = emptyState();
  lastReport?: StoredReport;
  private running = false;

  async onload(): Promise<void> {
    const stored = ((await this.loadData()) ?? {}) as Partial<Stored>;
    this.settings = { ...DEFAULT_SETTINGS, ...stored.settings };
    this.state = stored.state ?? emptyState();
    this.lastReport = stored.lastReport;

    this.addSettingTab(new PhoneSyncSettingTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "Sync with GitHub", () => this.run("sync"));
    this.addCommand({ id: "sync", name: "Sync with GitHub", callback: () => this.run("sync") });
    this.addCommand({ id: "pull", name: "Pull from GitHub only (send nothing)", callback: () => this.run("pull") });
    this.addCommand({ id: "dry-run", name: "Preview sync (change nothing)", callback: () => this.run("preview") });
    this.addCommand({
      id: "last-report",
      name: "Show last sync report",
      callback: () =>
        this.lastReport ? new ReportModal(this.app, this.lastReport).open() : new Notice("No sync has run yet."),
    });

    if (!this.isActiveHere()) return;
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.pullOnOpen) void this.run("sync", true);

      if (this.settings.syncEveryMinutes > 0) {
        this.registerInterval(
          window.setInterval(() => void this.run("sync", true), this.settings.syncEveryMinutes * 60_000),
        );
      }
      if (this.settings.syncAfterEdits) {
        const later = debounce(() => void this.run("sync", true), EDIT_QUIET_MS, true);
        for (const event of ["modify", "create", "delete", "rename"] as const) {
          this.registerEvent(this.app.vault.on(event as "modify", () => later()));
        }
      }
    });
  }

  isActiveHere(): boolean {
    return Platform.isMobile || this.settings.allowOnDesktop;
  }

  getToken(): string {
    return this.app.secretStorage.getSecret(TOKEN_ID) ?? "";
  }

  setToken(token: string): void {
    this.app.secretStorage.setSecret(TOKEN_ID, token);
  }

  remote(): GitHubRemote {
    const { owner, repo, branch } = this.settings;
    return new GitHubRemote(owner, repo, branch, this.getToken());
  }

  async persist(): Promise<void> {
    const data: Stored = { settings: this.settings, state: this.state, lastReport: this.lastReport };
    await this.saveData(data);
  }

  /** `auto` runs (on open, on a timer, after edits) stay quiet unless something happened. */
  async run(mode: Mode, auto = false): Promise<void> {
    if (!this.isActiveHere()) {
      new Notice("Phone Sync is off on desktop, where Obsidian Git syncs. Turn it on in settings to use it here.");
      return;
    }
    if (!this.getToken()) {
      if (!auto) new Notice("Phone Sync: add a GitHub token in settings first.");
      return;
    }
    if (this.running) {
      if (!auto) new Notice("Phone Sync is already running.");
      return;
    }
    this.running = true;
    const notice = auto ? null : new Notice(mode === "preview" ? "Previewing sync…" : "Syncing with GitHub…", 0);
    try {
      const opts = {
        filter: new PathFilter(this.settings.excludes),
        maxFileBytes: this.settings.maxFileMB * 1024 * 1024,
        maxDeletes: this.settings.maxDeletes,
        dryRun: mode === "preview",
        today: localDate(new Date()),
        message: `vault backup (iPhone): ${localDate(new Date())} ${new Date().toTimeString().slice(0, 8)}`,
        saveState: async (s: SyncState) => {
          this.state = s;
          await this.persist();
        },
      };
      const fs = new ObsidianFs(this.app.vault.adapter);
      const report: SyncReport =
        mode === "pull"
          ? { ...(await pull(this.remote(), fs, this.state, opts)), pushed: [] }
          : await sync(this.remote(), fs, this.state, opts);
      this.lastReport = { ...report, at: new Date().toISOString(), mode };
      await this.persist();
      notice?.hide();

      const needsLook = report.errors.length > 0 || report.conflicts.length > 0 || !!report.blocked;
      const changed = report.downloaded.length + report.deleted.length + report.pushed.length + report.merged.length > 0;
      if (!auto || needsLook || changed) new Notice(summarize(report, mode), needsLook ? 0 : 5000);
      if (mode === "preview" || needsLook) new ReportModal(this.app, this.lastReport).open();
    } catch (e) {
      notice?.hide();
      new Notice(`Phone Sync failed: ${e instanceof Error ? e.message : String(e)}`, auto ? 8000 : 0);
    } finally {
      this.running = false;
    }
  }
}

function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function summarize(r: SyncReport, mode: Mode): string {
  if (r.blocked) return `Phone Sync stopped: ${r.blocked}`;
  const preview = mode === "preview";
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const toSend = preview ? r.pendingPush.length : r.pushed.length;
  const parts = [
    r.downloaded.length && `${plural(r.downloaded.length, "file")} ${preview ? "to download" : "downloaded"}`,
    r.deleted.length && `${plural(r.deleted.length, "file")} ${preview ? "to remove" : "removed"}`,
    toSend && `${plural(toSend, "change")} ${preview ? "to send" : "sent"}`,
    r.merged.length && `${plural(r.merged.length, "file")} merged`,
    r.conflicts.length && plural(r.conflicts.length, "conflict"),
    r.errors.length && plural(r.errors.length, "error"),
  ].filter(Boolean);
  const label = preview ? "Preview" : mode === "pull" ? "Pulled" : "Synced";
  return `${label}: ${parts.length ? parts.join(", ") : "already up to date"}.`;
}

class ReportModal extends Modal {
  constructor(app: App, private report: StoredReport) {
    super(app);
  }

  onOpen(): void {
    const r = this.report;
    const preview = r.mode === "preview";
    this.setTitle(preview ? "Sync preview" : "Last sync");
    const el = this.contentEl;
    el.createEl("p", { text: `${new Date(r.at).toLocaleString()} · GitHub at ${r.commit.slice(0, 7)}` });
    if (r.blocked) el.createEl("p", { text: r.blocked });
    const section = (title: string, items: string[]) => {
      if (!items.length) return;
      el.createEl("h4", { text: `${title} (${items.length})` });
      const ul = el.createEl("ul");
      for (const item of items.slice(0, 200)) ul.createEl("li", { text: item });
      if (items.length > 200) ul.createEl("li", { text: `…and ${items.length - 200} more` });
    };
    section("Errors", r.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)));
    section("Conflicts (your copy kept, GitHub's saved beside it)", r.conflicts.map((c) => `${c.path} → ${c.copy}`));
    section(preview ? "Would download" : "Downloaded", r.downloaded);
    section(preview ? "Would replace with GitHub's settings" : "Replaced with GitHub's settings (old copy in trash)", r.replaced);
    section(preview ? "Would merge" : "Merged", r.merged);
    section(preview ? "Would move to trash" : "Moved to trash", r.deleted);
    if (preview || r.mode === "pull") section("Changed on this phone, not sent yet", r.pendingPush);
    else section(`Sent to GitHub${r.pushedCommit ? ` (${r.pushedCommit.slice(0, 7)})` : ""}`, r.pushed);
    section("Skipped, larger than the size limit", r.skippedLarge);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class PhoneSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: PhoneSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();

    const text = (name: string, desc: string, key: "owner" | "repo" | "branch") =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) =>
        t.setValue(p.settings[key]).onChange(async (v) => {
          p.settings[key] = v.trim();
          await p.persist();
        }),
      );

    new Setting(containerEl)
      .setName("GitHub token")
      .setDesc("Fine-grained token for this repo only, with Contents read and write. Stored on this device only, never synced.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder(p.getToken() ? "•••••• saved" : "github_pat_…").onChange((v) => p.setToken(v.trim()));
      });
    text("Owner", "GitHub user or organization that owns the vault repo.", "owner");
    text("Repository", "Name of the vault repo.", "repo");
    text("Branch", "Branch the desktops push to.", "branch");

    new Setting(containerEl)
      .setName("Check connection")
      .addButton((b) =>
        b.setButtonText("Check").onClick(async () => {
          try {
            new Notice(await p.remote().check());
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e), 0);
          }
        }),
      );

    new Setting(containerEl)
      .setName("Sync when Obsidian opens")
      .addToggle((t) =>
        t.setValue(p.settings.pullOnOpen).onChange(async (v) => {
          p.settings.pullOnOpen = v;
          await p.persist();
        }),
      );

    new Setting(containerEl)
      .setName("Sync after editing")
      .setDesc("Sync 30 seconds after you stop changing files. Takes effect after restarting Obsidian.")
      .addToggle((t) =>
        t.setValue(p.settings.syncAfterEdits).onChange(async (v) => {
          p.settings.syncAfterEdits = v;
          await p.persist();
        }),
      );

    new Setting(containerEl)
      .setName("Sync every (minutes)")
      .setDesc("While Obsidian is open. 0 turns it off. Takes effect after restarting Obsidian.")
      .addText((t) =>
        t.setValue(String(p.settings.syncEveryMinutes)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0) {
            p.settings.syncEveryMinutes = n;
            await p.persist();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Largest file to sync (MB)")
      .setDesc("Bigger files are left alone on both sides.")
      .addText((t) =>
        t.setValue(String(p.settings.maxFileMB)).onChange(async (v) => {
          const n = Number(v);
          if (n > 0) {
            p.settings.maxFileMB = n;
            await p.persist();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Deletion limit")
      .setDesc("Stop and change nothing if one sync would delete more files than this.")
      .addText((t) =>
        t.setValue(String(p.settings.maxDeletes)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isInteger(n) && n >= 0) {
            p.settings.maxDeletes = n;
            await p.persist();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Excluded paths")
      .setDesc("One per line. folder/ for a folder, name for any file or folder with that name, *.ext for a file type, # for comments.")
      .addTextArea((t) => {
        t.inputEl.rows = 12;
        t.setValue(p.settings.excludes).onChange(async (v) => {
          p.settings.excludes = v;
          await p.persist();
        });
      });

    new Setting(containerEl)
      .setName("Run on desktop too")
      .setDesc("Off by default: your desktops sync with Obsidian Git, and this plugin's on/off state syncs to them.")
      .addToggle((t) =>
        t.setValue(p.settings.allowOnDesktop).onChange(async (v) => {
          p.settings.allowOnDesktop = v;
          await p.persist();
        }),
      );

    new Setting(containerEl)
      .setName("Forget sync history")
      .setDesc("Treat the next pull as the first one. Files that differ from GitHub become conflict copies; nothing is overwritten.")
      .addButton((b) =>
        b.setButtonText("Reset").setWarning().onClick(async () => {
          p.state = emptyState();
          await p.persist();
          new Notice("Sync history cleared.");
        }),
      );
  }
}
