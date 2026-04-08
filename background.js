const MAX_ACTIVE_DOWNLOADS = 1;
const RETRY_DELAY = 30000;
const MAX_RETRIES = 10;
const DOWNLOAD_DELAY = 5000;

let downloadQueue = [];
let activeDownloads = 0;
let queuedUrls = new Set();
let downloadRetries = new Map();
let activeDownloadItems = new Map(); // downloadId -> {url, folder}

let retryScheduled = false;
let retryQueue = [];

let isWaiting = false;

let downloadFolder = "download_queue";

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
function processQueue() {

  if (isWaiting) return;

  while (activeDownloads < MAX_ACTIVE_DOWNLOADS && downloadQueue.length > 0) {

    const item = downloadQueue.shift();

    const url = typeof item === "string" ? item : item.url;
    const folder = typeof item === "string" ? downloadFolder : item.folder || downloadFolder;

    const filename = `${folder}/${extractFilename(url)}`;

    activeDownloads++;

    browser.downloads.download({
      url,
      filename,
      conflictAction: "uniquify"
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

  setTimeout(() => {

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
        scheduleRetry(nextRetry.url, nextRetry.folder);
      }

    }

  }, RETRY_DELAY);

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
browser.commands.onCommand.addListener(command => {

  if (command === "queue-video-links") {

    browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {

      if (tabs[0]) {
        browser.tabs.sendMessage(tabs[0].id, { type: "scrape-links" });
      }

    });

  }

});

// --- Handle scraped links ---
browser.runtime.onMessage.addListener((message, sender) => {

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