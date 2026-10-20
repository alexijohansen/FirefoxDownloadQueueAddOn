// Wait for the HTML DOM to load before binding our logic
document.addEventListener('DOMContentLoaded', () => {
  restoreOptions();
  refreshQueue();

  document.getElementById('options-form').addEventListener('submit', saveOptions);
  document.getElementById('refresh-queue').addEventListener('click', refreshQueue);
  document.getElementById('toggle-pause').addEventListener('click', togglePause);
  document.getElementById('clear-queue').addEventListener('click', () => {
    if (confirm("Are you sure you want to completely clear the download queue?")) {
      browser.runtime.sendMessage({ type: "clear-queue" }).then(() => {
        refreshQueue();
      });
    }
  });

  // Folder filtering handlers
  const folderInput = document.getElementById('folder-input');
  const btnFilterFolder = document.getElementById('btn-filter-folder');
  const btnFilterHistory = document.getElementById('btn-filter-history');

  btnFilterFolder.addEventListener('click', () => {
    folderInput.click();
  });

  if (btnFilterHistory) {
    btnFilterHistory.addEventListener('click', handleFilterHistory);
  }

  folderInput.addEventListener('change', handleFolderSelected);

  // Banner close & toggle
  document.getElementById('close-banner-btn').addEventListener('click', () => {
    document.getElementById('filter-banner').style.display = 'none';
  });

  document.getElementById('toggle-removed-btn').addEventListener('click', () => {
    const listContainer = document.getElementById('removed-list-container');
    const toggleBtn = document.getElementById('toggle-removed-btn');
    if (listContainer.style.display === 'none') {
      listContainer.style.display = 'block';
      toggleBtn.textContent = 'Hide Details';
    } else {
      listContainer.style.display = 'none';
      toggleBtn.textContent = 'Show Details';
    }
  });

  // Add Links Panel handlers
  const addLinksPanel = document.getElementById('add-links-panel');
  const btnToggleAddLinks = document.getElementById('btn-toggle-add-links');
  const closeAddLinks = document.getElementById('close-add-links');
  const btnCancelLinks = document.getElementById('btn-cancel-links');
  const btnSubmitLinks = document.getElementById('btn-submit-links');

  btnToggleAddLinks.addEventListener('click', () => {
    const isHidden = addLinksPanel.style.display === 'none';
    addLinksPanel.style.display = isHidden ? 'block' : 'none';
    if (isHidden) {
      document.getElementById('manual-urls').focus();
    }
  });

  closeAddLinks.addEventListener('click', () => {
    addLinksPanel.style.display = 'none';
  });

  btnCancelLinks.addEventListener('click', () => {
    addLinksPanel.style.display = 'none';
  });

  btnSubmitLinks.addEventListener('click', handleAddLinksSubmit);

  // Queue item remove delegation
  document.getElementById('queue-list').addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.btn-remove-item');
    if (removeBtn) {
      const index = parseInt(removeBtn.getAttribute('data-index'), 10);
      if (!isNaN(index)) {
        browser.runtime.sendMessage({ type: "remove-queue-item", index }).then(() => {
          refreshQueue();
        });
      }
    }
  });

  // Handle URL hashes for direct navigation from popup
  handleUrlHash();

  // Keep Options page in sync if storage changes (e.g. paused from popup, or queue updated)
  browser.storage.local.onChanged.addListener((changes) => {
    if (changes.isPaused !== undefined || changes.savedDownloadQueue !== undefined) {
      refreshQueue();
    }
  });
});

function handleUrlHash() {
  const hash = window.location.hash;
  if (hash === '#filter-folder') {
    // Clean hash
    history.replaceState(null, '', window.location.pathname);
    // Short timeout to ensure window has focused
    setTimeout(() => {
      document.getElementById('folder-input').click();
    }, 150);
  } else if (hash === '#add-links') {
    history.replaceState(null, '', window.location.pathname);
    setTimeout(() => {
      document.getElementById('add-links-panel').style.display = 'block';
      document.getElementById('manual-urls').focus();
    }, 100);
  }
}

function handleFolderSelected(e) {
  const input = e.target;
  const files = input.files;
  if (!files || files.length === 0) return;

  const btnFilter = document.getElementById('btn-filter-folder');
  const originalText = btnFilter.innerHTML;
  btnFilter.disabled = true;
  btnFilter.textContent = 'Scanning files...';

  // Extract metadata without loading file content into memory
  const fileData = Array.from(files).map(f => ({
    name: f.name,
    relativePath: f.webkitRelativePath,
    size: f.size
  }));

  // Identify folder name
  let folderName = "selected folder";
  if (files[0] && files[0].webkitRelativePath) {
    folderName = files[0].webkitRelativePath.split('/')[0] || folderName;
  }

  browser.runtime.sendMessage({
    type: "filter-queue-by-files",
    files: fileData
  }).then(response => {
    btnFilter.disabled = false;
    btnFilter.innerHTML = originalText;
    input.value = ''; // Reset so the same folder can be re-selected if files change

    if (!response || !response.success) {
      showFilterBanner("Error Filtering Folder", "Could not process folder files.", []);
      return;
    }

    showFilterBanner(
      `Folder Scan: "${folderName}"`,
      response,
      response.removedItems || []
    );

    refreshQueue();
  }).catch(err => {
    btnFilter.disabled = false;
    btnFilter.innerHTML = originalText;
    input.value = '';
    console.error("Filter error:", err);
    showFilterBanner("Error", `An error occurred: ${err.message}`, []);
  });
}

function handleFilterHistory() {
  const btn = document.getElementById('btn-filter-history');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Checking...';

  browser.runtime.sendMessage({ type: "filter-queue-by-history" }).then(response => {
    btn.disabled = false;
    btn.innerHTML = originalText;

    if (!response || !response.success) {
      showFilterBanner("History Check", "Could not check download history.", []);
      return;
    }

    showFilterBanner(
      "Firefox Download History Check",
      response,
      response.removedItems || []
    );

    refreshQueue();
  }).catch(err => {
    btn.disabled = false;
    btn.innerHTML = originalText;
    console.error("History filter error:", err);
    showFilterBanner("Error", `An error occurred: ${err.message}`, []);
  });
}

function showFilterBanner(title, result, removedItems) {
  const banner = document.getElementById('filter-banner');
  const bannerTitle = document.getElementById('filter-banner-title');
  const bannerDesc = document.getElementById('filter-banner-desc');
  const toggleBtn = document.getElementById('toggle-removed-btn');
  const listContainer = document.getElementById('removed-list-container');
  const removedList = document.getElementById('removed-list');

  banner.style.display = 'flex';
  bannerTitle.textContent = title;

  if (typeof result === 'string') {
    bannerDesc.textContent = result;
    toggleBtn.style.display = 'none';
    listContainer.style.display = 'none';
    return;
  }

  const { totalScanned, skippedIncomplete, removedCount, remainingCount } = result;

  let desc = `Scanned ${totalScanned} file(s) in folder. Removed ${removedCount} already-downloaded file(s) from the queue. ${remainingCount} file(s) remain to download.`;
  if (skippedIncomplete > 0) {
    desc += ` (Skipped ${skippedIncomplete} incomplete or empty file(s) so they can complete).`;
  }
  bannerDesc.textContent = desc;

  if (removedItems && removedItems.length > 0) {
    removedList.innerHTML = '';
    removedItems.forEach(item => {
      const li = document.createElement('li');
      li.textContent = item.filename || item.url;
      li.title = item.url;
      removedList.appendChild(li);
    });
    toggleBtn.style.display = 'inline-block';
    toggleBtn.textContent = `Show Removed Files (${removedItems.length})`;
    listContainer.style.display = 'none';
  } else {
    toggleBtn.style.display = 'none';
    listContainer.style.display = 'none';
  }
}

function handleAddLinksSubmit() {
  const urlsText = document.getElementById('manual-urls').value;
  const folderInput = document.getElementById('manual-folder').value.trim() || "download_queue";
  const keepPaused = document.getElementById('add-paused-check').checked;
  const statusEl = document.getElementById('add-links-status');

  // Parse links by line or whitespace
  const links = urlsText
    .split(/[\r\n\s]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('ftp://')));

  if (links.length === 0) {
    statusEl.textContent = 'Please enter at least one valid HTTP/HTTPS URL.';
    statusEl.style.color = '#d73a49';
    statusEl.classList.add('visible');
    return;
  }

  if (keepPaused) {
    browser.storage.local.set({ isPaused: true });
  }

  browser.runtime.sendMessage({
    type: "add-links",
    links: links,
    folder: folderInput
  }).then(response => {
    if (response) {
      statusEl.textContent = `Added ${response.addedCount} links to queue (${response.skippedCount} skipped/duplicate).`;
      statusEl.style.color = 'var(--success-color)';
      statusEl.classList.add('visible');
      document.getElementById('manual-urls').value = '';
      refreshQueue();

      setTimeout(() => {
        statusEl.classList.remove('visible');
        document.getElementById('add-links-panel').style.display = 'none';
      }, 2000);
    }
  }).catch(err => {
    statusEl.textContent = 'Error adding links.';
    statusEl.style.color = '#d73a49';
    statusEl.classList.add('visible');
  });
}

function extractFilename(url) {
  try {
    const pathname = new URL(url).pathname;
    const rawName = pathname.split('/').pop();
    const decodedName = decodeURIComponent(rawName || "");
    return decodedName || url;
  } catch (e) {
    return url;
  }
}

function togglePause() {
  browser.storage.local.get({ isPaused: true }).then(res => {
    const nextState = !res.isPaused;
    browser.storage.local.set({ isPaused: nextState });
  });
}

// Helper to load current values from Extension Native Storage (which persists across Firefox sessions)
function restoreOptions() {
  browser.storage.local.get({
    maxActiveDownloads: 1,
    downloadDelay: 5000,
    retryDelay: 30000,
    maxRetries: 10,
    scrapeExtensions: [".zip", ".7z", ".mp4", ".mkv", ".avi", ".mov", ".webm", ".flv"]
  }).then((res) => {
    document.getElementById('maxActiveDownloads').value = res.maxActiveDownloads;
    document.getElementById('downloadDelay').value = res.downloadDelay;
    document.getElementById('retryDelay').value = res.retryDelay;
    document.getElementById('maxRetries').value = res.maxRetries;
    document.getElementById('scrapeExtensions').value = res.scrapeExtensions.join(', ');
  });
}

function saveOptions(e) {
  e.preventDefault();
  
  const maxActiveDownloads = parseInt(document.getElementById('maxActiveDownloads').value, 10);
  const downloadDelay = parseInt(document.getElementById('downloadDelay').value, 10);
  const retryDelay = parseInt(document.getElementById('retryDelay').value, 10);
  const maxRetries = parseInt(document.getElementById('maxRetries').value, 10);
  
  // Create array from comma separated string
  const extInput = document.getElementById('scrapeExtensions').value;
  const scrapeExtensions = extInput.split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => s.startsWith('.') ? s : `.${s}`); // Ensure extensions start with dot

  // Securely persist into local database
  browser.storage.local.set({
    maxActiveDownloads,
    downloadDelay,
    retryDelay,
    maxRetries,
    scrapeExtensions
  }).then(() => {
    const status = document.getElementById('status');
    status.textContent = 'Options saved.';
    status.classList.add('visible');
    setTimeout(() => {
      status.classList.remove('visible');
    }, 2000);
  });
}

function refreshQueue() {
  browser.runtime.sendMessage({ type: "get-queue" }).then(response => {
    const queueList = document.getElementById('queue-list');
    queueList.innerHTML = ''; // Clear current

    const queueLength = response && response.queue ? response.queue.length : 0;
    const isPaused = response && response.isPaused !== undefined ? response.isPaused : true;

    // Update queue badge pill
    const badge = document.getElementById('queue-badge-count');
    if (badge) {
      badge.textContent = `${queueLength} queued`;
      if (isPaused) {
        badge.classList.add('paused');
      } else {
        badge.classList.remove('paused');
      }
    }

    // Sync the Pause/Resume button text and styling
    const toggleBtn = document.getElementById('toggle-pause');
    if (toggleBtn) {
      if (isPaused) {
        toggleBtn.textContent = 'Resume Queue';
        toggleBtn.className = 'btn primary';
      } else {
        toggleBtn.textContent = 'Pause Queue';
        toggleBtn.className = 'btn secondary';
      }
    }

    if (!response || !response.queue || response.queue.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty-state';
      li.innerHTML = `
        <div class="empty-state-icon">📥</div>
        <div class="empty-state-title">Queue is currently empty</div>
        <div class="empty-state-subtitle">Use <strong>Add Links</strong> above, right-click file links on any page, or press <kbd>Ctrl+Shift+Y</kbd> to scrape video links.</div>
      `;
      queueList.appendChild(li);
      return;
    }

    response.queue.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = 'queue-item';

      const url = typeof item === "string" ? item : item.url;
      const folder = typeof item === "string" ? "download_queue" : (item.folder || "download_queue");
      const filename = extractFilename(url);

      li.innerHTML = `
        <div class="queue-item-main">
          <div class="queue-item-header">
            <span class="queue-index">#${index + 1}</span>
            <span class="queue-filename" title="${filename}">${filename}</span>
            <span class="queue-folder-badge" title="Destination folder">📁 ${folder}</span>
          </div>
          <div class="queue-url" title="${url}">${url}</div>
        </div>
        <div class="queue-item-actions">
          <button class="btn-icon-danger btn-remove-item" data-index="${index}" title="Remove from queue">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      `;

      queueList.appendChild(li);
    });
  }).catch(error => {
    console.error("Error fetching queue:", error);
    const queueList = document.getElementById('queue-list');
    queueList.innerHTML = '<li class="empty-state" style="color: #d73a49;">Error loading queue. Is the extension running?</li>';
  });
}
