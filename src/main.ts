import { App, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_EXCLUDES, PathFilter } from "./core/filter.ts";
import { pull, type PullReport } from "./core/pull.ts";
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
  pullOnOpen: boolean;
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
  allowOnDesktop: false,
};

const TOKEN_ID = "obsidian-phone-sync-github-token";

interface Stored {
  settings: Settings;
  state: SyncState;
  lastReport?: PullReport & { at: string };
}

export default class PhoneSyncPlugin extends Plugin {
  settings: Settings = DEFAULT_SETTINGS;
  state: SyncState = emptyState();
  lastReport?: Stored["lastReport"];
  private running = false;

  async onload(): Promise<void> {
    const stored = ((await this.loadData()) ?? {}) as Partial<Stored>;
    this.settings = { ...DEFAULT_SETTINGS, ...stored.settings };
    this.state = stored.state ?? emptyState();
    this.lastReport = stored.lastReport;

    this.addSettingTab(new PhoneSyncSettingTab(this.app, this));
    this.addRibbonIcon("cloud-download", "Pull from GitHub", () => this.runPull(false));
    this.addCommand({ id: "pull", name: "Pull from GitHub", callback: () => this.runPull(false) });
    this.addCommand({
      id: "dry-run",
      name: "Preview pull (change nothing)",
      callback: () => this.runPull(true),
    });
    this.addCommand({
      id: "last-report",
      name: "Show last sync report",
      callback: () =>
        this.lastReport
          ? new ReportModal(this.app, this.lastReport).open()
          : new Notice("No sync has run yet."),
    });

    if (this.settings.pullOnOpen && this.isActiveHere()) {
      this.app.workspace.onLayoutReady(() => this.runPull(false, true));
    }
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

  async runPull(dryRun: boolean, quiet = false): Promise<void> {
    if (!this.isActiveHere()) {
      new Notice("Phone Sync is off on desktop, where Obsidian Git syncs. Turn it on in settings to use it here.");
      return;
    }
    if (!this.getToken()) {
      if (!quiet) new Notice("Phone Sync: add a GitHub token in settings first.");
      return;
    }
    if (this.running) {
      new Notice("Phone Sync is already running.");
      return;
    }
    this.running = true;
    const notice = new Notice(dryRun ? "Previewing pull…" : "Pulling from GitHub…", 0);
    try {
      const report = await pull(this.remote(), new ObsidianFs(this.app.vault.adapter), this.state, {
        filter: new PathFilter(this.settings.excludes),
        maxFileBytes: this.settings.maxFileMB * 1024 * 1024,
        maxDeletes: this.settings.maxDeletes,
        dryRun,
        today: new Date().toISOString().slice(0, 10),
        saveState: async (s) => {
          this.state = s;
          await this.persist();
        },
      });
      this.lastReport = { ...report, at: new Date().toISOString() };
      await this.persist();
      notice.hide();
      const msg = summarize(report);
      new Notice(msg, report.errors.length || report.conflicts.length || report.blocked ? 0 : 5000);
      if (dryRun || report.errors.length || report.conflicts.length || report.blocked) {
        new ReportModal(this.app, this.lastReport).open();
      }
    } catch (e) {
      notice.hide();
      new Notice(`Phone Sync failed: ${e instanceof Error ? e.message : String(e)}`, 0);
    } finally {
      this.running = false;
    }
  }
}

function summarize(r: PullReport): string {
  if (r.blocked) return `Phone Sync stopped: ${r.blocked}`;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [
    r.downloaded.length && `${plural(r.downloaded.length, "file")} ${r.dryRun ? "to download" : "downloaded"}`,
    r.deleted.length && `${plural(r.deleted.length, "file")} ${r.dryRun ? "to remove" : "removed"}`,
    r.conflicts.length && plural(r.conflicts.length, "conflict"),
    r.errors.length && plural(r.errors.length, "error"),
  ].filter(Boolean);
  return `${r.dryRun ? "Preview" : "Pulled"}: ${parts.length ? parts.join(", ") : "already up to date"}.`;
}

class ReportModal extends Modal {
  constructor(app: App, private report: PullReport & { at: string }) {
    super(app);
  }

  onOpen(): void {
    const r = this.report;
    this.setTitle(r.dryRun ? "Pull preview" : "Last sync");
    const el = this.contentEl;
    el.createEl("p", { text: `${new Date(r.at).toLocaleString()} · commit ${r.commit.slice(0, 7)}` });
    if (r.blocked) el.createEl("p", { text: r.blocked });
    const section = (title: string, items: string[]) => {
      if (!items.length) return;
      el.createEl("h4", { text: `${title} (${items.length})` });
      const ul = el.createEl("ul");
      for (const item of items.slice(0, 200)) ul.createEl("li", { text: item });
      if (items.length > 200) ul.createEl("li", { text: `…and ${items.length - 200} more` });
    };
    section("Errors", r.errors.map((e) => `${e.path}: ${e.message}`));
    section("Conflicts (your copy kept, GitHub's saved beside it)", r.conflicts.map((c) => `${c.path} → ${c.copy}`));
    section(r.dryRun ? "Would download" : "Downloaded", r.downloaded);
    section(r.dryRun ? "Would replace with GitHub's settings" : "Replaced with GitHub's settings (old copy in trash)", r.replaced);
    section(r.dryRun ? "Would merge" : "Merged", r.merged);
    section(r.dryRun ? "Would move to trash" : "Moved to trash", r.deleted);
    section("Changed on this phone, waiting for push (coming in a later version)", r.pendingPush);
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
      .setName("Pull when Obsidian opens")
      .addToggle((t) =>
        t.setValue(p.settings.pullOnOpen).onChange(async (v) => {
          p.settings.pullOnOpen = v;
          await p.persist();
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
