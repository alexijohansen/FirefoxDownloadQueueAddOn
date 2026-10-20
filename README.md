# A vibe coded Firefox Download Queue Manager

An addon that sequentially queues and automatically manages multiple file downloads to prevent browser performance degradation or rate limits on host websites.

# How to run

1. Open Firefox.
2. Visit: `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on...**
4. Select the `manifest.json` file in your add-on folder.

## Features

- **Crash-Resilient Persistent Queue**: The download queue, retry queue, and queued links are automatically persisted to extension storage (`browser.storage.local`). If your machine or browser crashes, your queued downloads are preserved upon restart.
- **Check Download Folder (Remove Completed Files)**: Point to any folder containing downloaded files. The extension scans the directory (and subdirectories), matches completed files against your queue, and automatically removes any already-downloaded files from the queue while safely leaving incomplete (`.part` / `.crdownload`) files in the queue so they can finish.
- **Add Links with Queue Paused**: Easily queue up links while paused (via the "Add Links" button, right-click context menu, or page scraping) without starting downloads until you are ready.
- **Manual "Add Links" Tool**: Paste multiple URLs (one per line) directly in the options dashboard or via the popup to add them to the queue in bulk with a custom destination folder.
- **Queue Links via Context Menu**: Right-click any link on a page and select "Queue Download" to add it to your download queue.
- **Scrape Page Links**: Right-click the page background and select "Queue All Video Links" to automatically queue all video links found on the page.
- **Keyboard Shortcut**: Press `Ctrl+Shift+Y` to queue all file links on your current page.
- **Automatic Retries**: If a download fails or is interrupted, the addon puts it in a retry timer. It automatically attempts to restart the download up to a configurable number of times.
- **Failure Delay Cool-down**: If a download fails (either failing to start or getting interrupted), the queue pauses for 30 seconds before attempting to start the next download in the queue to avoid rapid-fire failures.
- **Clear & Individual Item Management**: Remove individual items directly from the queue or clear the entire queue with a single click.

## Crash Recovery Workflow

If your machine or browser crashed during a download session:
1. Open the **Download Queue Manager** (via toolbar popup or Options page).
2. Ensure the queue is in the **Paused** state (it defaults to paused).
3. Add any new or re-scraped links to the queue if desired.
4. Click **Check Download Folder** (or **Filter by Folder** in the toolbar popup).
5. Select your download folder in the file picker.
6. The addon will scan your files, report how many matching files were found, and automatically remove them from the queue.
7. Review your remaining queue and click **Resume Queue** to continue downloading only the missing files!

## Configuration

To access the options dashboard:
1. Open up a new tab in Firefox and navigate to `about:addons`.
2. Click **Extensions** on the left.
3. Find **Download Queue Manager** and click the `...` menu.
4. Select **Options** (or **Preferences**), or click the settings cog icon in the toolbar popup.

This will open the settings dashboard where you can refresh your active queue and manage the following options:

- **Max Active Downloads:** Adjusts the number of files that are permitted to download concurrently. Setting it higher means faster total downloads but can stress bandwidth or trigger host rate limits. (default: 1)
- **Download Delay (ms):** The pause time after a download finishes before the queue automatically starts the next one. This prevents rapid-fire requests that can trigger anti-bot measures. (default: 5000ms)
- **Retry Delay (ms):** The 'cool-off' duration the add-on waits before attempting to resume a failed or interrupted download. (default: 30000ms)
- **Max Retries:** The maximum number of consecutive times the extension will attempt to re-initiate a failed download before ultimately giving up and removing it from the queue. (default: 10)
- **Scrape Extensions:** A comma-separated list of file extensions used by the "Queue All Video Links" context menu to determine which links to scrape off the page. You can add or remove any file types you want here. (default: `.zip, .mp4, .mkv, .avi, .mov, .webm, .flv`)

