# Grok Imagine Bulk Actions

Chrome extension for bulk downloading and deleting Grok Imagine assets.

## What It Does

- Downloads generated-only media or all media from the assets API
- Deletes generated media, all media, or every asset when run from Imagine, Saved, or Files pages
- Shows an in-page progress modal with cancel support
- Uses paginated API collection instead of DOM scrolling
- Retries downloads across multiple attempts
- Uses throttled request pacing for list collection, download starts, and background cleanup tasks
- Uses a deferred second pass for failed destructive actions
- Rechecks the selected asset scope after successful deletion until nothing remains or a failure occurs
- Reloads the page after destructive actions complete

## Popup Actions

Imagine-page actions:

- `Download All Generated`
- `Download All Media`
- `Delete All Generated`
- `Delete All Media`
- `Delete All Assets`

Files-page actions:

- `Download All Generated`
- `Download All Media`
- `Delete All Generated`
- `Delete All Media`
- `Delete All Assets`

Buttons are page-aware:

- Downloads are enabled on Imagine, Saved, and Files pages
- Asset deletion is enabled on Imagine, Saved, and Files pages
- All variants use `SOURCE_ANY`; media variants add repeated `mimeTypes` filters

## How It Works

- Content script collects `SOURCE_ANY` assets through paginated requests to:
  - `GET https://grok.com/rest/assets`
- Service worker deletes assets via:
  - `DELETE https://grok.com/rest/assets/{assetId}`
- Downloads are delegated to the service worker through `chrome.downloads`
- Only one background download or asset-deletion run is allowed at a time
- Downloaded files are written under the Chrome downloads folder in:
  - `grok-saved/<YYYY-MM-DD_HH-MM>/<file>`

## Current Behavior Notes

- `Download All Generated` downloads only media marked as model-generated
- `Download All Media` downloads both generated and uploaded images and videos
- `Delete All Generated` deletes only model-generated media
- `Delete All Media` deletes generated and uploaded media while preserving non-media assets
- `Delete All Assets` uses the unfiltered asset list and deletes media and non-media assets
- Asset deletion follows every assets API page, queues the selected scope, and stops early if requests still fail after the second pass
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
4. Keep the tab open until completion so the content script can keep polling progress
5. After destructive actions, the page reloads automatically

## Project Files

- `manifest.json` - extension metadata, permissions, content-script matches, and service worker registration
- `popup.html` - popup UI
- `popup.js` - page detection, button enable/disable logic, confirmations, and tab messaging
- `content.js` - API collection, progress modal UI, action orchestration, polling, and cancel handling
- `background.js` - background task runner for downloads and destructive actions, with a single global background-task lock

## Notes

- This is an unofficial third-party tool.
- Grok UI or API changes can break behavior and require updates.
- Use at your own risk.

