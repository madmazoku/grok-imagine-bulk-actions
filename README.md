# Grok Imagine Bulk Actions

Chrome extension for bulk download and cleanup actions on Grok imagine pages and the files page.

## What It Does

- Downloads media from liked Grok posts by calling the Grok API directly
- Unfavorites and deletes liked posts in one run
- Deletes files from `grok.com/files`
- Shows an in-page progress modal with cancel support
- Uses paginated API collection instead of DOM scrolling
- Retries downloads across multiple attempts
- Uses throttled request pacing for list collection, download starts, and background cleanup tasks
- Uses a deferred second pass for failed destructive actions
- Rechecks the files list after a successful delete batch until nothing remains or a failure occurs
- Reloads the page after destructive actions complete

## Popup Actions

Imagine-page actions:

- `Download All`
- `Unfavorite + Delete All`
- `100`, `500`, `1000` limits for `Unfavorite + Delete All`

Files-page actions:

- `Delete All Files`
- `100`, `500`, `1000` limits for `Delete All Files`

Buttons are page-aware:

- Post actions are enabled on `https://grok.com/imagine`, `https://grok.com/imagine/*`, and `https://grok.com/imagine/saved`
- File deletion is enabled on `https://grok.com/files` and `https://grok.com/files/*`

## How It Works

- Content script collects liked posts from:
  - `POST https://grok.com/rest/media/post/list`
- Content script collects files from:
  - `GET https://grok.com/rest/assets`
- Service worker performs destructive actions in the background via:
  - `POST https://grok.com/rest/media/post/unlike`
  - `POST https://grok.com/rest/media/post/delete`
  - `DELETE https://grok.com/rest/assets-metadata/{assetId}`
- Downloads are delegated to the service worker through `chrome.downloads`
- Only one background run is allowed at a time across downloads, post cleanup, and file deletion
- Downloaded files are written under the Chrome downloads folder in:
  - `grok-saved/<YYYY-MM-DD_HH-MM>/<file>`

## Current Behavior Notes

- The post source is currently hardcoded to `MEDIA_POST_SOURCE_LIKED`
- `Download All` downloads media from liked posts only; it does not switch source based on whether you opened `/imagine` or `/imagine/saved`
- Post cleanup works on top-level liked post IDs collected from the same liked-post API
- File deletion runs in batches and stops early if any delete requests still fail after the second pass
- Cancel support stops queued work and lets already started background requests drain
- The content script responds to popup messages directly; there is no script-injection fallback path

## Permissions

- `activeTab`
- `downloads`
- `storage`
- `scripting`
- Host permission: `https://grok.com/*`

## Install (Unpacked)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this project folder

## Usage

1. Open `https://grok.com/imagine`, `https://grok.com/imagine/saved`, or `https://grok.com/files`
2. Click the extension icon
3. Run the action that matches the current page
4. Use the `100`, `500`, or `1000` buttons if you want to cap destructive collection size
5. Keep the tab open until completion so the content script can keep polling progress
6. After destructive actions, the page reloads automatically

## Project Files

- `manifest.json` - extension metadata, permissions, content-script matches, and service worker registration
- `popup.html` - popup UI
- `popup.js` - page detection, button enable/disable logic, limit-button wiring, and tab messaging
- `content.js` - API collection, progress modal UI, action orchestration, polling, and cancel handling
- `background.js` - background task runner for downloads and destructive actions, with a single global background-task lock

## Notes

- This is an unofficial third-party tool.
- Grok UI or API changes can break behavior and require updates.
- Use at your own risk.

