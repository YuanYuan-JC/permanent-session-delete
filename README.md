# Permanent delete for DeepSeek Harness

[![test](https://github.com/YuanYuan-JC/permanent-session-delete/actions/workflows/test.yml/badge.svg)](https://github.com/YuanYuan-JC/permanent-session-delete/actions/workflows/test.yml)

Adds a **永久删除 / Delete permanently** row to the sidebar Session menu of
DeepSeek Harness. Unlike the built-in *Archive* action, it removes the
conversation from disk: session log, projection cache, workspace marks, and
every sub-agent session that ran under it.

> **Irreversible.** There is no trash, undo, or restore path. Delete is
> confirmation-gated, but the confirmation is the only safety net.

This is a third-party plugin. It stays maintained while DSH has no native
delete, and will be marked deprecated once the official feature ships.

## Compatibility

| Plugin | DeepSeek Harness | Notes |
|---|---|---|
| `1.0.x` | `0.2.2-rc.5` | Verified against the Desktop profile with JSONL persistence |

`package.json` declares `engines.dsh` (`>=0.2.2-rc.5 <0.3.0-0`), so the Plugin
Manager refuses an installation on an unverified DSH version instead of
running against APIs it has not seen.

## Install

From GitHub:

```sh
dsh plugin --profile <profile> add github:YuanYuan-JC/permanent-session-delete
```

Or in the app: **Plugins → Add plugin**, then a local checkout. The profile
links the checkout, so edits take effect after reloading the plugin (or
restarting the app).

## Behavior

- Works on **cold** conversations — rows the current app run has not opened.
  The row disappears on the next list refresh and cannot be restored.
- Cascades into **sub-agent sessions** below the conversation (children,
  grandchildren, …), following only `origin: 'subagent'` links. Ordinary forks
  are never touched, and the toast reports how many child sessions went.
- Clears the conversation's **archive mark and pin**, and deletes its
  **projection-cache checkpoint**.
- Refuses a conversation whose Agent is still loaded in this app run: DSH keeps
  an opened conversation in memory for the process lifetime and exposes no way
  for a plugin to release it, so deleting it would leave a restorable ghost.
  Restart the app and delete the row without opening it first.
- Refuses the whole tree when any sub-agent session is still loaded or any
  session directory has an unknown layout; every directory is preflighted before
  the first unlink.

On activation the plugin also drops archive marks and projection-cache rows
whose session no longer exists, so earlier deletions leave no invisible residue.

## Use

1. Open the sidebar Session row's `···` menu.
2. Choose **永久删除 / Delete permanently**.
3. Confirm in the dialog. The toast reports how many sub-agent sessions went
   with it.

## Develop

```sh
node --test test/*.test.mjs
```

The Host half (`index.js`) owns the `POST /api/session.permanentDelete` route and
the deletion logic; the browser half (`client.js`) registers the menu row and
the confirmation dialog through the public Slot and context-menu services.

## Limits

- Attachment bytes under the DSH home are shared and are not removed.
- Built for the Desktop profile's JSONL persistence backend.
- Live-session deletion waits for a future DSH API that can release a Session's
  Agent.

## License

[MIT](LICENSE)
