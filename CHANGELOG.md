# Changelog

All notable changes to this plugin are documented here. The version is also the
release tag; each entry names the DeepSeek Harness version it was verified
against.

## 1.0.0 — 2026-11-19

First public release. Verified against DeepSeek Harness **0.2.2-rc.5**.

- Sidebar Session menu row **永久删除 / Delete permanently** with a confirmation
  dialog; the row is not danger-red and carries a trash icon.
- Deletes the conversation's session log directory (every retained format
  generation plus the writer lock), its projection-cache checkpoint, and its
  archive/pin marks.
- Cascades into **sub-agent sessions** below the conversation, followed only
  through `origin: 'subagent'` links. Every target directory is preflighted
  before the first unlink, and the toast reports how many children went.
- Refuses a conversation whose Agent is still loaded in the running app, and any
  tree with a loaded sub-agent session, instead of leaving a restorable ghost.
- Activation hygiene: drops archive marks and projection-cache rows whose
  session no longer exists.
