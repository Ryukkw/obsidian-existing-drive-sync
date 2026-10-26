# Changelog

## 0.1.4

- Show a compact floating progress panel at the top of Obsidian, including while editing notes on iPhone.
- Open detailed progress only when the panel, settings button or progress command is clicked; manual sync no longer opens a modal automatically.
- Show current operation, percentage and file counter. Dismiss the panel for the current run or let it hide five seconds after success.
- Label a failed attempt as the last run's error, clear it on a fresh run, and ignore terminal notifications from superseded sessions.
- Abort old synchronization sessions on plugin unload/reload, including remaining upload chunks and local writes after an outstanding download.
- Wait for both discovery tasks to settle before reporting failure or allowing the next run.

Validation: 64 automated tests; production banner checked in a 390×844 mobile browser viewport using Obsidian's theme, including overflow, dismissal, detail clicks, stale errors and automatic hiding. Physical iPhone verification remains pending.

## 0.1.3

- Add a live progress window that opens on manual sync and can be reopened from settings or the command palette.
- Show scanning counts, processed/total files, percentage, current file and operation, and upload/download/conflict/deletion totals.
- Keep long-running synchronization visible through a persistent mobile notification.
- Keep errors and partial progress visible in the progress window and settings until the next run.
- Advance the completed counter only after each file action is checkpointed. Discovery uses an indeterminate bar until the total is known.

## 0.1.2

- Fix false HTTP 412 errors when downloading unchanged files from Google Drive. Metadata ETags are no longer sent as media preconditions; downloaded content is still verified against the scanned MD5 checksum.
- Preserve conditional checks for cloud uploads and trash operations.
- Verify the fix with a regression test and a read-only download from the real Google Drive API.

## 0.1.1

- Select an existing vault folder inside the plugin, including shared folders.
- Browse nested folders and filter the current folder list.

## 0.1.0

- Initial experimental two-way Google Drive synchronization for local Obsidian vaults.
- Attachments, conflict copies, checkpoints, local backups and cloud trash support.
