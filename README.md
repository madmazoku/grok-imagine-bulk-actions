# Grok Imagine Bulk Actions

Chrome extension for bulk download and cleanup actions on Grok imagine pages and the files page.

## What It Does

- Download all liked media from `grok.com/imagine` and `grok.com/imagine/saved`
- Unlike and delete all liked posts in one run
- Delete all files from `grok.com/files`
- Shows in-page progress with cancel support
- Uses Grok API pagination and retries failed downloads
- Uses throttled request pacing for list collection, download starts, and background cleanup tasks
- Uses a deferred second pass for failed destructive actions
- Reloads the page after destructive actions complete

## Scope

Current popup actions:

- `Download All`
- `Unfavorite + Delete All`
- `Delete All Files`

## How It Works

- Content script fetches liked posts from:
  - `POST https://grok.com/rest/media/post/list`
- Content script fetches files from:
  - `GET https://grok.com/rest/assets?pageSize=50&orderBy=ORDER_BY_LAST_USE_TIME&source=SOURCE_ANY&isLatest=true`
- Service worker executes destructive tasks in the background via:
  - `POST https://grok.com/rest/media/post/unlike`
  - `POST https://grok.com/rest/media/post/delete`
  - `DELETE https://grok.com/rest/assets-metadata/{assetId}`
- Downloads are delegated to service worker via `chrome.downloads`
- Only one background task run is allowed at a time across downloads, post cleanup, and file deletion
- Files are stored under the Chrome downloads folder in:
  - `grok-saved/<timestamp>/...`

## Install (Unpacked)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this project folder

## Usage

1. Open `https://grok.com/imagine`, `https://grok.com/imagine/saved`, or `https://grok.com/files`
2. Click the extension icon
3. Run the action that matches the current page
4. Disabled buttons indicate which page they work on
5. Keep the tab open until completion
6. After destructive actions, the page reloads automatically

## Project Files

- `manifest.json` - extension metadata and permissions
- `popup.html` - popup UI
- `popup.js` - page-aware popup actions and tab messaging
- `content.js` - API collection, progress modal, action handlers
- `background.js` - background task runner for downloads and destructive actions, with a single global background-task lock

## Notes

- This is an unofficial third-party tool.
- Grok UI/API changes can break behavior and require updates.
- Buttons are page-aware: post actions work on imagine pages, file deletion works on `/files`.
- Post cleanup and file deletion use the same deferred second-pass retry approach.
- Use at your own risk.

