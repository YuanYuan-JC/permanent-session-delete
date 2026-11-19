# Permanent delete

Deletes a conversation for good instead of archiving it. The row lives in the
**sidebar Session menu** under the name **Delete permanently** / **永久删除**
with a trash icon, placed after the other Session actions. The row is not
danger-red; the confirmation dialog carries the warning.

## Use it

1. Find the conversation row in the sidebar and open its `···` / context menu.
2. Choose **Delete permanently**. A confirmation dialog names the consequence
   and offers **Cancel** / **Delete permanently**; only the second button
   removes anything. There is no undo.
3. After a confirmed deletion the dialog closes, the row leaves the list on
   refresh, and a toast reports the result.

The conversation does not need to be open. Deleting from the sidebar does not
change the conversation you are currently viewing.

## What it removes

- Every stored generation of the conversation's log, and its writer lock
  (`~/.dsh/sessions/<project>/<session-id>/`).
- Every stored sub-agent session below it: children, grandchildren, and deeper,
  followed only through `origin: 'subagent'` links so an ordinary fork is never
  touched. Their logs and cache rows go with the conversation, and the toast
  reports how many.
- The conversation's projection-cache checkpoint, so titles and statistics do
  not linger.
- Its archive mark and pin, so no stale id keeps a hidden or pinned slot.
- On every activation the plugin also drops archive marks and projection-cache
  rows whose Session no longer exists, so earlier deletions cannot leave
  invisible dead ids or stale checkpoints behind. Cache rows are derived and
  rebuildable; they are removed through the open storage domain so the backend's
  memory and files agree.

## Why an opened conversation is refused

The running app keeps an opened conversation's Agent in memory for the app's
lifetime and no plugin API disposes it. Deleting such a Session removes its
files, but the in-memory log survives: the row then stays visible (archived or
not) and its content remains restorable until the app restarts. The plugin
therefore refuses that case with a clear message instead of reporting a
deletion the sidebar contradicts.

Restart DeepSeek Harness, then delete the row from the sidebar **without
opening it first**. A conversation whose row is cold can always be deleted
completely and immediately.

## Refusals

- **Conversation loaded in this run** — refused, as described above; nothing is
  deleted or archived.
- **A sub-agent session still loaded in this run** — the whole tree is refused,
  so a running child cannot be half-deleted.
- **Unknown file layout** — if any session directory in the tree holds anything
  besides `session*.jsonl*` and `session.lock`, the plugin deletes nothing and
  reports the mismatch rather than guessing. Every directory is checked before
  the first unlink.
- **Missing conversation** — already gone; reported without side effects.

A blank conversation that was never written to disk has no session directory;
its records are dropped without filesystem work.

## Limits

- Deletion is permanent: there is no trash, undo, or restore path.
- Attachment bytes under `~/.dsh/attachments` are shared objects and are not
  removed with the conversation.
- Built for the shipped JSONL session-persistence backend of this Desktop
  profile. The row is user-only; the agent has no tool for it.
- The live-conversation refusal is deliberate until DSH exposes a supported way
  to release a Session's Agent. When that API lands, the live path can drop the
  refusal and delete in place.
