# Changelog

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
