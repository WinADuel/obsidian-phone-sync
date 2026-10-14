# Phone Sync

An Obsidian plugin that keeps the vault on an iPhone in sync with the same GitHub repo the desktops sync with through [Obsidian Git](https://github.com/Vinzent03/obsidian-git). The phone talks to GitHub's REST API instead of running git, so it never downloads the repo's history and stays fast on a large vault.

**Status: version 0.1 pulls only.** It brings GitHub's files onto the phone and keeps phone edits untouched. Pushing phone edits back to GitHub comes next.

## What a pull does

Each pull compares three snapshots of every file: what both sides had at the last sync, the phone now, and GitHub now.

| Situation | Result |
| --- | --- |
| Changed only on GitHub | Downloaded |
| Deleted on GitHub, untouched on the phone | Moved to the vault's `.trash` folder |
| Changed only on the phone | Left alone, waits for push |
| Changed on both | Phone copy kept; GitHub's saved beside it as `Note (GitHub conflict 2026-10-14).md` |

Nothing is overwritten that the phone changed. A pull that would delete more than 20 files stops and changes nothing. **Preview pull** in the command palette shows what would happen without doing it.

All plugins and settings in `.obsidian` sync. Left out by default (editable in settings): `.git/`, `.trash/`, the workspace layout files, `.DS_Store`, the `.smart-env/` and `.copilot/` caches, this plugin's own folder, and files over 25 MB.

The plugin stays idle on desktop, since the desktops use Obsidian Git and the list of enabled plugins syncs between devices.

## Install on iPhone

1. Create a [fine-grained GitHub token](https://github.com/settings/personal-access-tokens/new) with access to only the vault repo and **Contents: Read and write**.
2. In Obsidian on the iPhone, create a new empty vault. Turn off Restricted mode, then install **BRAT** from Community plugins.
3. In BRAT's settings, paste a GitHub token that can read this plugin's repo (needed because it is private), then choose **Add beta plugin** and enter `WinADuel/obsidian-phone-sync`.
4. Enable **Phone Sync**, open its settings, paste the vault token, and tap **Check**.
5. Run **Pull from GitHub** from the ribbon or command palette.
6. Restart Obsidian to load the synced plugins. Obsidian Git will load too and may complain that the phone has no git repo: open its settings and turn on **Disable on this device**. That setting stays on the phone.

On the first pull, the new vault's default `.obsidian` settings are replaced by your synced ones (the defaults go to `.trash`), and the list of enabled plugins is merged so BRAT and Phone Sync stay on.

## Development

```sh
npm install
npm run build   # typecheck and bundle main.js
npm test        # unit tests
VAULT_REPO=/path/to/vault/checkout npm test   # also pulls a real vault into a temp folder
```

To publish a release that BRAT installs, bump the version in `manifest.json` and `versions.json`, then run the **Release** workflow from the Actions tab. It tags the release with that version.

The sync logic in `src/core` has no Obsidian imports and is tested in Node with in-memory fakes. `src/github.ts` and `src/obsidianFs.ts` connect it to GitHub and the vault.
