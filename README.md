# Grok Imagine Bulk Actions

Chrome extension for bulk actions on liked media in Grok Imagine.

## What It Does

- Download all liked media (images and videos) from `grok.com/imagine/*`
- Unlike and delete all liked posts in one run
- Shows in-page progress with cancel support
- Uses Grok API pagination and retries failed downloads
- Uses throttled request pacing for list, download starts, and unlike/delete actions
- Reloads the page after `Unfavorite + Delete All` completes

## Scope

Current popup actions:

- `Download All`
- `Unfavorite + Delete All`

## How It Works

- Content script fetches liked posts from:
  - `POST https://grok.com/rest/media/post/list`
- Unfavorite + delete actions call:
  - `POST https://grok.com/rest/media/post/unlike`
  - `POST https://grok.com/rest/media/post/delete`
- Downloads are delegated to service worker via `chrome.downloads`
- Files are stored under the Chrome downloads folder in:
  - `grok-saved/<timestamp>/...`

## Install (Unpacked)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this project folder

## Usage

1. Open any `https://grok.com/imagine/*` page while logged in
2. Click the extension icon
3. Run `Download All` or `Unfavorite + Delete All`
4. Keep the tab open until completion
5. After `Unfavorite + Delete All`, the page reloads automatically

## Project Files

- `manifest.json` - extension metadata and permissions
- `popup.html` - popup UI
- `popup.js` - popup actions and tab messaging
- `content.js` - API fetch, progress modal, action handlers
- `background.js` - download queue, progress tracking

## Notes

- This is an unofficial third-party tool.
- Grok UI/API changes can break behavior and require updates.
- Use at your own risk.

## Prepare Local Git Repository (No Push)

```bash
git init
git add .
git commit -m "Initial commit"
```

When ready later, add your own remote and push manually.
