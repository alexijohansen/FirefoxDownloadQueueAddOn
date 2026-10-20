// Configurable constraints loaded from extension storage
let MAX_ACTIVE_DOWNLOADS = 1;
let RETRY_DELAY = 30000;
let MAX_RETRIES = 10;
let DOWNLOAD_DELAY = 5000;
// Wait 30 seconds after a download failure before starting another download
const FAILURE_DELAY = 30000;
let isPaused = true; // Global pause state

// In-memory queues to track our downloads
// Web Extensions don't organically provide sequential downloading natively, so we manage the logic.
let downloadQueue = [];
let activeDownloads = 0;
let queuedUrls = new Set(); // Prevent duplicates by maintaining a set of known URLs waiting
let downloadRetries = new Map(); // Keep track of fail counts per URL
let activeDownloadItems = new Map(); // Maps native Firefox download IDs -> {url, folder}

let retryScheduled = false;
let retryQueue = [];

let isWaiting = false;
let downloadFolder = "download_queue";

// --- Folder Task Queue Management ---
let folderTaskQueue = [];
let activeFolderTask = null; // { url, folderName, pendingFiles: 0, isScraping: false }

// --- Helper: persist queue to storage to survive browser crashes / restarts ---
let saveQueueTimeout = null;
function saveQueueState(immediate = false) {
  if (immediate) {
    if (saveQueueTimeout) clearTimeout(saveQueueTimeout);
    saveQueueTimeout = null;
    return browser.storage.local.set({
      savedDownloadQueue: downloadQueue,
      savedRetryQueue: retryQueue,
      savedQueuedUrls: Array.from(queuedUrls)
    });
  }
  if (saveQueueTimeout) clearTimeout(saveQueueTimeout);
  saveQueueTimeout = setTimeout(() => {
    browser.storage.local.set({
      savedDownloadQueue: downloadQueue,
      savedRetryQueue: retryQueue,
      savedQueuedUrls: Array.from(queuedUrls)
    }).catch(err => {
      console.error("Failed to save queue state:", err);
    });
    saveQueueTimeout = null;
  }, 50);
}

// Helper to update the browser toolbar icon badge
function updateBadge() {
  if (isPaused) {
    browser.browserAction.setBadgeText({ text: "⏸" });
    browser.browserAction.setBadgeBackgroundColor({ color: "#d73a49" });
  } else {
    const totalPending = downloadQueue.length + retryQueue.length;
    if (totalPending > 0) {
      browser.browserAction.setBadgeText({ text: totalPending.toString() });
      browser.browserAction.setBadgeBackgroundColor({ color: "#0060df" });
    } else {
      browser.browserAction.setBadgeText({ text: "" });
    }
  }
}

// Load stored settings and persisted queue on extension startup.
browser.storage.local.get([
  'maxActiveDownloads',
  'retryDelay',
  'maxRetries',
  'downloadDelay',
  'isPaused',
  'savedDownloadQueue',
  'savedRetryQueue',
  'savedQueuedUrls'
]).then((res) => {
  if (res.maxActiveDownloads !== undefined) MAX_ACTIVE_DOWNLOADS = res.maxActiveDownloads;
  if (res.retryDelay !== undefined) RETRY_DELAY = res.retryDelay;
  if (res.maxRetries !== undefined) MAX_RETRIES = res.maxRetries;
  if (res.downloadDelay !== undefined) DOWNLOAD_DELAY = res.downloadDelay;
  if (res.isPaused !== undefined) {
    isPaused = res.isPaused;
  } else {
    // Fresh install default to paused
    isPaused = true;
    browser.storage.local.set({ isPaused: true });
  }

  // Restore persisted queue after crash or restart
  if (Array.isArray(res.savedDownloadQueue)) {
    downloadQueue = res.savedDownloadQueue;
  }
  if (Array.isArray(res.savedRetryQueue)) {
    retryQueue = res.savedRetryQueue;
  }
  if (Array.isArray(res.savedQueuedUrls)) {
    queuedUrls = new Set(res.savedQueuedUrls);
  } else {
    queuedUrls = new Set();
    downloadQueue.forEach(item => queuedUrls.add(typeof item === 'string' ? item : item.url));
    retryQueue.forEach(item => queuedUrls.add(typeof item === 'string' ? item : item.url));
  }

  updateBadge();
  if (!isPaused) {
    processQueue();
  }
});

// Add a listener to instantly enforce settings when a user changes them via the Options page or popup.
// The background script stays alive (persistent: true), so it can react immediately.
browser.storage.local.onChanged.addListener((changes) => {
  if (changes.maxActiveDownloads) MAX_ACTIVE_DOWNLOADS = changes.maxActiveDownloads.newValue;
  if (changes.retryDelay) RETRY_DELAY = changes.retryDelay.newValue;
  if (changes.maxRetries) MAX_RETRIES = changes.maxRetries.newValue;
  if (changes.downloadDelay) DOWNLOAD_DELAY = changes.downloadDelay.newValue;
  if (changes.isPaused !== undefined) {
    isPaused = changes.isPaused.newValue;
    updateBadge();
    if (!isPaused) {
      processQueue();
    }
  } else {
    processQueue(); // Try processing if other settings changed and we are active
  }
});

// --- Helper: clear queue completely ---
function clearQueueData() {
  downloadQueue = [];
  retryQueue = [];
  downloadRetries.clear();
  queuedUrls.clear();
  console.log("Download queue cleared.");
  updateBadge();
  saveQueueState(true);
}

// --- Helper: extract clean filename ---
function extractFilename(url) {
  try {
    const pathname = new URL(url).pathname;
    const rawName = pathname.split('/').pop();
    const decodedName = decodeURIComponent(rawName || "");
    return decodedName || `downloaded_file_${Date.now()}`;
  } catch (e) {
    return `downloaded_file_${Date.now()}`;
  }
}

// --- Helper: sanitize folder name ---
function sanitizeFolderName(name) {
  // Replace invalid filename characters with underscores
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || "scraped_folder";
}

// --- NEW: check if URL already active or queued ---
function isUrlActiveOrQueued(url) {
  // Active downloads
  for (const item of activeDownloadItems.values()) {
    if (item.url === url) return true;
  }

  // In main queue
  return downloadQueue.some(item =>
    (typeof item === "string" ? item : item.url) === url
  );
}

// --- Main queue processor ---
// The core orchestrator. Starts native Firefox downloads if below MAX_ACTIVE_DOWNLOADS.
function processQueue() {

  if (isPaused) {
    updateBadge();
    return;
  }

  if (isWaiting) return;

  while (activeDownloads < MAX_ACTIVE_DOWNLOADS && downloadQueue.length > 0) {

    const item = downloadQueue.shift();
    saveQueueState();

    const url = typeof item === "string" ? item : item.url;
    const folder = typeof item === "string" ? downloadFolder : item.folder || downloadFolder;

    const filename = `${folder}/${extractFilename(url)}`;

    activeDownloads++;

    // Tap into the native browser downloads API
    browser.downloads.download({
      url,
      filename,
      conflictAction: "uniquify" // Automatically appends (1), (2) to duplicate physical files on disk
    }).then(id => {

      console.log(`Started download ${id} for ${url} into ${filename}`);

      activeDownloadItems.set(id, { url, folder });

    }).catch(err => {

      console.error("Download start failed:", err);

      activeDownloads--;

      scheduleRetry(url, folder);

      waitAndProcessQueue(FAILURE_DELAY);

    });

  }

  updateBadge();
}

// --- Delay helper ---
// Manages the queue wait timer between downloads.
// Parameterizes the delay so it can be overridden (e.g. waiting FAILURE_DELAY on download failure).
// Protects against overlapping timeouts: if a longer wait (like FAILURE_DELAY) is active,
// a subsequent request for a shorter wait (like DOWNLOAD_DELAY) will not shorten it.
let waitTimer = null;
let resumeTime = 0;

function waitAndProcessQueue(delay = DOWNLOAD_DELAY) {
  const targetResumeTime = Date.now() + delay;

  if (targetResumeTime > resumeTime) {
    // Cancel any shorter active timer before extending the wait time
    if (waitTimer) {
      clearTimeout(waitTimer);
    }
    resumeTime = targetResumeTime;
    isWaiting = true;

    waitTimer = setTimeout(() => {
      isWaiting = false;
      waitTimer = null;
      resumeTime = 0;
      processQueue();
    }, delay);
  }
}

// --- Retry scheduler ---
function scheduleRetry(url, folder) {

  const retries = downloadRetries.get(url) || 0;

  if (retries >= MAX_RETRIES) {
    console.error(`Giving up on ${url} after ${MAX_RETRIES} retries`);
    return;
  }

  downloadRetries.set(url, retries + 1);

  console.log(`Retry scheduled for ${url} in 30 seconds (attempt ${retries + 1})`);

  const alreadyQueued = retryQueue.some(item => item.url === url);

  // ✅ Prevent duplicates AND prevent retry if already active/queued
  if (!alreadyQueued && !isUrlActiveOrQueued(url)) {
    retryQueue.push({ url, folder });
    updateBadge();
    saveQueueState();
  }

  if (retryScheduled) return;

  retryScheduled = true;
  setTimeout(processNextRetry, RETRY_DELAY);

}

function processNextRetry() {
  retryScheduled = false;

  if (retryQueue.length > 0) {
    const nextRetry = retryQueue.shift();

    console.log(`Retrying ${nextRetry.url}`);

    // ✅ DOUBLE CHECK before re-queueing
    if (!isUrlActiveOrQueued(nextRetry.url)) {
      downloadQueue.unshift(nextRetry);
      updateBadge();
      saveQueueState();
    } else {
      console.log(`Skipping retry (already active/queued): ${nextRetry.url}`);
    }

    processQueue();

    // Schedule next retry if more remain
    if (retryQueue.length > 0) {
      retryScheduled = true;
      setTimeout(processNextRetry, RETRY_DELAY);
    }
  }
}

// --- Download state watcher ---
browser.downloads.onChanged.addListener(delta => {

  if (!delta.state) return;

  const meta = activeDownloadItems.get(delta.id);

  if (!meta) return;

  if (delta.state.current === "complete") {

    console.log(`Completed: ${meta.url}`);

    activeDownloads--;

    downloadRetries.delete(meta.url);

    activeDownloadItems.delete(delta.id);

    // ✅ Remove from retry queue
    retryQueue = retryQueue.filter(item => item.url !== meta.url);
    updateBadge();
    saveQueueState();

    // ✅ Track folder task completion
    if (activeFolderTask && meta.folder.startsWith(`${downloadFolder}/${activeFolderTask.folderName}`)) {
      activeFolderTask.pendingFiles--;
      checkFolderTaskCompletion();
    }

    waitAndProcessQueue();

  }

  if (delta.state.current === "interrupted") {

    console.error("Download interrupted:", meta.url);

    activeDownloads--;

    activeDownloadItems.delete(delta.id);

    // ✅ Even if it failed and we might retry, we still need to track its impact on the "current folder" status
    // But since scheduleRetry adds it back to the queue, we'll keep it as pending if we want to wait for retries too.
    // However, if we reach MAX_RETRIES, it will be lost.
    // For simplicity, let's say it's still pending if it's in the retry cycle.
    // If it's totally failed (reached max retries), we should decrement.

    scheduleRetry(meta.url, meta.folder);
    updateBadge();

    waitAndProcessQueue(FAILURE_DELAY);

  }

});

/**
 * Checks if the current folder task is completely finished (scraped + all files downloaded).
 */
function checkFolderTaskCompletion() {
  if (activeFolderTask && !activeFolderTask.isScraping && activeFolderTask.pendingFiles <= 0) {
    console.log(`Folder task completed: ${activeFolderTask.folderName}`);
    activeFolderTask = null;
    processFolderTasks();
  }
}

// --- Context Menus ---
// Register options shown when right clicking links or anywhere on a document.
browser.contextMenus.create({
  id: "queue-download",
  title: "Queue Download",
  contexts: ["link"]
});

browser.contextMenus.create({
  id: "scrape-video-links",
  title: "Queue All Video Links",
  contexts: ["page"]
});

browser.contextMenus.create({
  id: "scrape-video-links-usa",
  title: "Queue All Video Links (USA only)",
  contexts: ["page"]
});

browser.contextMenus.create({
  id: "queue-folder-download",
  title: "Queue Folder Download",
  contexts: ["link"]
});

// --- Context menu handler ---
browser.contextMenus.onClicked.addListener((info, tab) => {

  if (info.menuItemId === "queue-download") {

    if (!queuedUrls.has(info.linkUrl)) {

      queuedUrls.add(info.linkUrl);

      downloadQueue.push(info.linkUrl);
      saveQueueState();

      console.log(`Queued download: ${info.linkUrl}`);

      processQueue();

    } else {

      console.log(`Skipped duplicate: ${info.linkUrl}`);

    }

  }

  if (info.menuItemId === "scrape-video-links") {
    browser.tabs.sendMessage(tab.id, { type: "scrape-links" });
  }

  if (info.menuItemId === "scrape-video-links-usa") {
    browser.tabs.sendMessage(tab.id, { type: "scrape-links-usa" });
  }

  if (info.menuItemId === "queue-folder-download") {
    const url = info.linkUrl;
    // Fallback folder name from the URL
    let folderName = url.split('/').filter(Boolean).pop() || "scraped_folder";

    // Try to get the actual link text from the content script for a better folder name
    browser.tabs.sendMessage(tab.id, { type: "get-link-text", url: url })
      .then(response => {
        if (response && response.text) {
          folderName = sanitizeFolderName(response.text);
        }
      })
      .catch(err => {
        console.log("Could not get link text, using URL component instead.");
      })
      .finally(() => {
        console.log(`Queuing folder task: ${url} -> ${folderName}`);
        folderTaskQueue.push({ url, folderName, pendingFiles: 0, isScraping: false });
        processFolderTasks();
      });
  }

});

/**
 * Orchestrates the sequential processing of folder tasks.
 */
async function processFolderTasks() {
  if (activeFolderTask || folderTaskQueue.length === 0) return;

  activeFolderTask = folderTaskQueue.shift();
  activeFolderTask.isScraping = true;

  const scrapeUrl = activeFolderTask.url.endsWith('/') ? activeFolderTask.url : activeFolderTask.url + '/';
  console.log(`Starting folder task: ${activeFolderTask.folderName}`);

  await scrapeFolder(scrapeUrl, `${downloadFolder}/${activeFolderTask.folderName}`);

  activeFolderTask.isScraping = false;
  console.log(`Scraping finished for ${activeFolderTask.folderName}, waiting for ${activeFolderTask.pendingFiles} files...`);

  // Check if it's already done (e.g. empty folder)
  checkFolderTaskCompletion();
}

/**
 * Recursively scrapes a directory listing page.
 * @param {string} url The URL of the directory listing.
 * @param {string} currentFolder The relative folder path for downloads.
 */
async function scrapeFolder(url, currentFolder) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const html = await response.text();

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const links = Array.from(doc.querySelectorAll("a"));

    const originUrl = new URL(url);

    for (const link of links) {
      const href = link.getAttribute("href");
      if (!href) continue;

      // Ignore parent directory, current directory, query strings, and fragments
      if (href === "../" || href === "./" || href.startsWith("?") || href.startsWith("#")) continue;

      const absoluteUrl = new URL(href, url).href;
      const targetUrl = new URL(absoluteUrl);

      // 1. Must stay on the same domain
      if (targetUrl.hostname !== originUrl.hostname) {
        continue;
      }

      // 2. Must stay within the same folder branch (don't go "up" or "sideways")
      if (!absoluteUrl.startsWith(url)) {
        continue;
      }

      if (href.endsWith("/")) {
        // It's a directory, recurse
        const subFolderName = href.slice(0, -1);
        await scrapeFolder(absoluteUrl, `${currentFolder}/${subFolderName}`);
      } else {
        // It's a file, queue it
        if (!queuedUrls.has(absoluteUrl)) {
          queuedUrls.add(absoluteUrl);

          // Track pending files for the active folder task
          if (activeFolderTask) {
            activeFolderTask.pendingFiles++;
          }

          downloadQueue.push({ url: absoluteUrl, folder: currentFolder });
          saveQueueState();
          console.log(`Queued file: ${absoluteUrl} into ${currentFolder}`);
        }
      }
    }

    // Process the queue after finding new files
    processQueue();

  } catch (error) {
    console.error(`Error scraping ${url}:`, error);
  }
}

// --- Keyboard shortcut ---
// Defined in manifest.json "commands" block. Overrides Ctrl+Shift+Y to trigger scraping natively.
browser.commands.onCommand.addListener(command => {

  if (command === "queue-video-links") {

    // Query Firefox for the user's currently focused browser tab to send a direct message payload
    browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {

      if (tabs[0]) {
        browser.tabs.sendMessage(tabs[0].id, { type: "scrape-links" });
      }

    });

  }

});

// --- Helper: normalize filename for comparison ---
function normalizeFilename(filename) {
  if (!filename) return "";
  let name = filename.trim();
  try {
    name = decodeURIComponent(name);
  } catch (e) {}
  return name.toLowerCase();
}

// --- Helper: strip browser uniquify suffix e.g. "video (1).mp4" -> "video.mp4" ---
function stripUniquifySuffix(filename) {
  return filename.replace(/\s*\(\d+\)(?=\.[^.]+$)/i, '');
}

/**
 * Filters the download queue and retry queue against a list of files existing in a local folder.
 * Removes files that are already completed on disk, leaving incomplete downloads (.part files) in the queue.
 * @param {Array<{ name: string, relativePath: string, size: number }>} existingFiles
 * @param {Set<string>|null} historyUrls
 */
function filterQueueByFiles(existingFiles, historyUrls = null) {
  if (!Array.isArray(existingFiles)) {
    return { success: false, error: "Invalid files list" };
  }

  const existingNames = new Set();
  const existingPaths = new Set();
  let skippedIncomplete = 0;
  const totalScanned = existingFiles.length;

  for (const file of existingFiles) {
    const rawName = file.name || "";
    const lowerName = rawName.toLowerCase();

    // Incomplete downloads (.part / .crdownload) or 0-byte aborted files shouldn't cause queue removal
    if (lowerName.endsWith(".part") || lowerName.endsWith(".crdownload") || file.size === 0) {
      skippedIncomplete++;
      continue;
    }

    const normName = normalizeFilename(rawName);
    existingNames.add(normName);
    existingNames.add(lowerName);

    // Also index without uniquify suffix ("video (1).mp4" -> "video.mp4")
    const stripped = stripUniquifySuffix(rawName);
    existingNames.add(normalizeFilename(stripped));
    existingNames.add(stripped.toLowerCase());

    if (file.relativePath) {
      const normPath = file.relativePath.toLowerCase().replace(/\\/g, '/');
      existingPaths.add(normPath);
      // Strip selected root folder prefix (e.g. "folderName/sub/file.mp4" -> "sub/file.mp4")
      const slashIdx = normPath.indexOf('/');
      if (slashIdx !== -1) {
        existingPaths.add(normPath.substring(slashIdx + 1));
      }
    }
  }

  function matchesExisting(item) {
    const url = typeof item === "string" ? item : item.url;
    const folder = typeof item === "string" ? downloadFolder : (item.folder || downloadFolder);

    // 0. Direct match against known download history URLs
    if (historyUrls && historyUrls.has(url)) {
      return true;
    }

    const targetFilename = extractFilename(url);
    const normTarget = normalizeFilename(targetFilename);

    // 1. Direct match on extracted filename
    if (existingNames.has(normTarget) || existingNames.has(targetFilename.toLowerCase())) {
      return true;
    }

    // 2. Relative path match
    const expectedPath = `${folder}/${targetFilename}`.toLowerCase().replace(/\\/g, '/');
    if (existingPaths.has(expectedPath)) {
      return true;
    }
    const slashIdx = folder.indexOf('/');
    if (slashIdx !== -1) {
      const subPath = `${folder.substring(slashIdx + 1)}/${targetFilename}`.toLowerCase().replace(/\\/g, '/');
      if (existingPaths.has(subPath)) {
        return true;
      }
    }

    // 3. Fallback: Check raw segment from URL pathname or query param
    try {
      const parsed = new URL(url);
      const rawSegment = parsed.pathname.split('/').pop();
      if (rawSegment && (existingNames.has(normalizeFilename(rawSegment)) || existingNames.has(rawSegment.toLowerCase()))) {
        return true;
      }
      for (const param of ['file', 'filename', 'name']) {
        const val = parsed.searchParams.get(param);
        if (val && (existingNames.has(normalizeFilename(val)) || existingNames.has(val.toLowerCase()))) {
          return true;
        }
      }
    } catch (e) {}

    return false;
  }

  const removedItems = [];
  const keptDownloadQueue = [];

  for (const item of downloadQueue) {
    if (matchesExisting(item)) {
      removedItems.push(item);
      const url = typeof item === "string" ? item : item.url;
      queuedUrls.delete(url);
      downloadRetries.delete(url);
    } else {
      keptDownloadQueue.push(item);
    }
  }
  downloadQueue = keptDownloadQueue;

  const keptRetryQueue = [];
  for (const item of retryQueue) {
    if (matchesExisting(item)) {
      removedItems.push(item);
      queuedUrls.delete(item.url);
      downloadRetries.delete(item.url);
    } else {
      keptRetryQueue.push(item);
    }
  }
  retryQueue = keptRetryQueue;

  saveQueueState(true);
  updateBadge();

  return {
    success: true,
    totalScanned,
    skippedIncomplete,
    removedCount: removedItems.length,
    remainingCount: downloadQueue.length + retryQueue.length,
    removedItems: removedItems.map(item => ({
      url: typeof item === "string" ? item : item.url,
      filename: extractFilename(typeof item === "string" ? item : item.url)
    }))
  };
}

/**
 * Automatically checks Firefox's native download records without needing a directory picker.
 */
async function filterQueueByHistory() {
  try {
    const completed = await browser.downloads.search({ state: "complete" });
    const existingFiles = [];
    const historyUrls = new Set();

    for (const d of completed) {
      if (d.exists === false) continue; // Skip files deleted from disk
      if (d.url) {
        historyUrls.add(d.url);
      }
      const rawName = d.filename ? d.filename.split(/[\\/]/).pop() : "";
      if (rawName) {
        existingFiles.push({
          name: rawName,
          relativePath: rawName,
          size: d.fileSize || 1
        });
      }
    }

    const res = filterQueueByFiles(existingFiles, historyUrls);
    return {
      ...res,
      isHistory: true
    };
  } catch (err) {
    console.error("Error searching download history:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Manually add URLs to the download queue.
 */
function addLinksToQueue(links, folder = downloadFolder) {
  let addedCount = 0;
  let skippedCount = 0;

  for (const rawLink of links) {
    const link = (rawLink || "").trim();
    if (!link) continue;

    try {
      new URL(link);
    } catch (e) {
      skippedCount++;
      continue;
    }

    if (!queuedUrls.has(link)) {
      queuedUrls.add(link);
      downloadQueue.push({ url: link, folder: folder || downloadFolder });
      addedCount++;
    } else {
      skippedCount++;
    }
  }

  saveQueueState(true);
  updateBadge();

  if (!isPaused) {
    processQueue();
  }

  return {
    addedCount,
    skippedCount,
    queueLength: downloadQueue.length
  };
}

// --- Handle messages ---
// Allows the content script or extension UI (Popups/Options) to talk to this background script.
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === "clear-queue") {
    clearQueueData();

    if (message.showNotification) {
      browser.notifications.create({
        type: "basic",
        title: "Download Queue Manager",
        message: "Download queue has been fully cleared!"
      });
    }

    sendResponse({ success: true });
    return;
  }

  if (message.type === "get-queue") {
    sendResponse({
      queue: downloadQueue,
      retryQueue: retryQueue,
      isPaused: isPaused,
      activeDownloads: activeDownloads
    });
    return true; // Indicates asynchronous response (though not strictly necessary here, ensures compatibility)
  }

  if (message.type === "filter-queue-by-files") {
    const result = filterQueueByFiles(message.files || []);
    sendResponse(result);
    return;
  }

  if (message.type === "filter-queue-by-history") {
    filterQueueByHistory().then(result => {
      sendResponse(result);
    });
    return true; // Asynchronous response
  }

  if (message.type === "add-links" && Array.isArray(message.links)) {
    const result = addLinksToQueue(message.links, message.folder);
    sendResponse(result);
    return;
  }

  if (message.type === "remove-queue-item" && typeof message.index === "number") {
    if (message.index >= 0 && message.index < downloadQueue.length) {
      const removed = downloadQueue.splice(message.index, 1)[0];
      const url = typeof removed === "string" ? removed : removed.url;
      queuedUrls.delete(url);
      downloadRetries.delete(url);
      saveQueueState(true);
      updateBadge();
      sendResponse({ success: true, queueLength: downloadQueue.length });
    } else {
      sendResponse({ success: false, error: "Index out of bounds" });
    }
    return;
  }

  if (message.type === "video-links" && Array.isArray(message.links)) {

    const timestamp = new Date().toISOString()
      .replace(/:/g, "-")
      .replace(/\..+/, "")
      .replace("T", "_");

    const batchFolder = `${downloadFolder}/${timestamp}`;

    const filteredLinks = message.usaOnly
      ? message.links.filter(link => decodeURIComponent(link).includes("d3g"))
      : message.links;

    filteredLinks.forEach(link => {

      if (!queuedUrls.has(link)) {

        queuedUrls.add(link);

        downloadQueue.push({ url: link, folder: batchFolder });

      } else {

        console.log(`Skipped duplicate in batch: ${link}`);

      }

    });

    console.log(`Queued ${filteredLinks.length} video links${message.usaOnly ? " (USA only)" : ""} into ${batchFolder}`);

    saveQueueState(true);
    processQueue();

  }

});