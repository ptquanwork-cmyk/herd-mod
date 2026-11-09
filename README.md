# herd

A Claude Code mod that runs many Claude sessions side by side through [herdr](https://github.com/herdrdev/herdr). Give Claude a task and it splits the work across a grid of terminal panes, waits for them, checks the results and merges them.

## What you get

- **Parallel work from chat.** Ask for a task and Claude splits it into 2 to 4 sessions, one git worktree each, then reviews, tests and merges the branches. Questions and small edits stay in the chat.
- **`/herd`** opens a pane with every session's status and output, and shows herdr's own UI in the Terminal panel.
- **A 2×2 grid per tab.** Sessions of one project share a tab, so all of them are on screen. A fifth session starts a new tab.
- **Folders you have worked in.** Pick one to see only its sessions; new sessions start there.
- **`/herd-code [folder]`** browses, views and edits files in a pane, with a button to open real VS Code.

## Requirements

- Claude Code, in the desktop app or a terminal, with the `claude` command signed in
- [herdr](https://github.com/herdrdev/herdr) on your `PATH`
- git, for the split and merge workflow
- Windows for the **Browse…** folder dialog and the VS Code button; the rest uses herdr's own CLI and has only been run on Windows

## Install

At the prompt of a terminal session:

```
/plugin install herd --marketplace ptquanwork-cmyk/herd-mod
```

From a shell:

```
claude plugin install herd --marketplace ptquanwork-cmyk/herd-mod
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `ptquanwork-cmyk/herd-mod`, then Add plugin.

## What it does on your machine

- It adds the workflow above to the system prompt of every session, so Claude reaches for parallel sessions on its own. To stop that, disable the mod.
- It reads the project paths in `~/.claude.json` for the folder list. It reads nothing else from that file.
- Spawned sessions use your default permission mode, so check that mode before starting several at once. A session stuck on an approval shows as blocked in the Herd pane, and you answer it there.
- A session running inside herdr cannot spawn more sessions, which stops runaway spawning.

## Limits

The pane editor is a quick editor: Enter saves and Shift+Enter starts a new line, and files over about 90,000 characters are view-only. It refuses to save over a file that changed on disk since you opened it, until you confirm.

## Develop

```
claude plugin validate .
claude plugin test .
```
