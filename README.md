#A vibe coded Firefox Download Queue Manager

An addon that sequentially queues and automatically manages multiple file downloads to prevent browser performance degradation or rate limits on host websites.

# How to run

Open Firefox.
Visit: about:debugging#/runtime/this-firefox

Click “Load Temporary Add-on”.

Select the manifest.json file in your add-on folder.

## Features

- **Queue Links via Context Menu**: Right-click any link on a page and select "Queue Download" to add it to your download queue.
- **Scrape Page Links**: Right-click the page background and select "Queue All Video Links" to automatically queue all video links found on the page.
- **Keyboard Shortcut**: Press `Ctrl+Shift+Y` to queue all file links on your current page.
- **Automatic Retries**: If a download fails or is interrupted, the addon puts it in a retry timer. It automatically attempts to restart the download up to a configurable number of times.
- **Clear Queue Options**: Click the extension icon in your browser toolbar to open a quick menu to completely clear the active queue or jump to settings. You can also clear the queue from the settings page itself.
## Configuration

To access the options dashboard:
1. Open up a new tab in Firefox and navigate to `about:addons`.
2. Click **Extensions** on the left.
3. Find **Download Queue Manager** and click the `...` menu.
4. Select **Options** (or **Preferences**).

This will open the settings dashboard where you can refresh your active queue and manage the following options:

- **Max Active Downloads:** Adjusts the number of files that are permitted to download concurrently. Setting it higher means faster total downloads but can stress bandwidth or trigger host rate limits. (default: 1)
- **Download Delay (ms):** The pause time after a download finishes before the queue automatically starts the next one. This prevents rapid-fire requests that can trigger anti-bot measures. (default: 5000ms)
- **Retry Delay (ms):** The 'cool-off' duration the add-on waits before attempting to resume a failed or interrupted download. (default: 30000ms)
- **Max Retries:** The maximum number of consecutive times the extension will attempt to re-initiate a failed download before ultimately giving up and removing it from the queue. (default: 10)
- **Scrape Extensions:** A comma-separated list of file extensions used by the "Queue All Video Links" context menu to determine which links to scrape off the page. You can add or remove any file types you want here. (default: `.zip, .mp4, .mkv, .avi, .mov, .webm, .flv`)
