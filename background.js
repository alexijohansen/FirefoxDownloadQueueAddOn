// Configurable constraints loaded from extension storage
let MAX_ACTIVE_DOWNLOADS = 1;
let RETRY_DELAY = 30000;
let MAX_RETRIES = 10;
let DOWNLOAD_DELAY = 5000;

// Load stored settings on extension startup to initialize our variables.
browser.storage.local.get(['maxActiveDownloads', 'retryDelay', 'maxRetries', 'downloadDelay']).then((res) => {
  if (res.maxActiveDownloads !== undefined) MAX_ACTIVE_DOWNLOADS = res.maxActiveDownloads;
  if (res.retryDelay !== undefined) RETRY_DELAY = res.retryDelay;
  if (res.maxRetries !== undefined) MAX_RETRIES = res.maxRetries;
  if (res.downloadDelay !== undefined) DOWNLOAD_DELAY = res.downloadDelay;
});

// Add a listener to instantly enforce settings when a user changes them via the Options page.
// The background script stays alive (persistent: true), so it can react immediately.
browser.storage.local.onChanged.addListener((changes) => {
  if (changes.maxActiveDownloads) MAX_ACTIVE_DOWNLOADS = changes.maxActiveDownloads.newValue;
  if (changes.retryDelay) RETRY_DELAY = changes.retryDelay.newValue;
  if (changes.maxRetries) MAX_RETRIES = changes.maxRetries.newValue;
  if (changes.downloadDelay) DOWNLOAD_DELAY = changes.downloadDelay.newValue;
  processQueue(); // Try processing if limit was increased
});

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

// --- Helper: clear queue completely ---
function clearQueueData() {
  downloadQueue = [];
  retryQueue = [];
  downloadRetries.clear();
  queuedUrls.clear();
  console.log("Download queue cleared.");
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

  if (isWaiting) return;

  while (activeDownloads < MAX_ACTIVE_DOWNLOADS && downloadQueue.length > 0) {

    const item = downloadQueue.shift();

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

      processQueue();

    });

  }

}

// --- Delay helper ---
function waitAndProcessQueue() {
  isWaiting = true;

  setTimeout(() => {
    isWaiting = false;
    processQueue();
  }, DOWNLOAD_DELAY);
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

    waitAndProcessQueue();

  }

  if (delta.state.current === "interrupted") {

    console.error(`Download interrupted: ${meta.url}`);

    activeDownloads--;

    activeDownloadItems.delete(delta.id);

    scheduleRetry(meta.url, meta.folder);

    waitAndProcessQueue();

  }

});

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

// --- Context menu handler ---
browser.contextMenus.onClicked.addListener((info, tab) => {

  if (info.menuItemId === "queue-download") {

    if (!queuedUrls.has(info.linkUrl)) {

      queuedUrls.add(info.linkUrl);

      downloadQueue.push(info.linkUrl);

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

});

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
    sendResponse({ queue: downloadQueue });
    return true; // Indicates asynchronous response (though not strictly necessary here, ensures compatibility)
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

    processQueue();

  }

});