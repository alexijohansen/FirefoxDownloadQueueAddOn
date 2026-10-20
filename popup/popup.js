let isPaused = true;

function updateUI() {
  browser.runtime.sendMessage({ type: "get-queue" }).then(response => {
    if (!response) return;

    const queueLength = response.queue ? response.queue.length : 0;
    isPaused = response.isPaused !== undefined ? response.isPaused : true;

    // Update Status Dot & Label
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    if (isPaused) {
      statusDot.className = 'status-dot paused';
      statusText.textContent = 'Paused';
    } else {
      statusDot.className = 'status-dot active';
      statusText.textContent = 'Running';
    }

    // Update Queue Badge
    const queueCount = document.getElementById('queue-count');
    queueCount.textContent = `${queueLength} queued`;

    // Update Button Icons & Text
    const iconPlay = document.querySelector('.icon-play');
    const iconPause = document.querySelector('.icon-pause');
    const toggleText = document.getElementById('toggle-text');

    if (isPaused) {
      if (iconPlay) iconPlay.style.display = 'block';
      if (iconPause) iconPause.style.display = 'none';
      if (toggleText) toggleText.textContent = 'Resume Queue';
    } else {
      if (iconPlay) iconPlay.style.display = 'none';
      if (iconPause) iconPause.style.display = 'block';
      if (toggleText) toggleText.textContent = 'Pause Queue';
    }
  }).catch(err => {
    console.error("Error updating popup UI:", err);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  updateUI();

  // Keep popup updated when storage (like isPaused) changes
  browser.storage.local.onChanged.addListener(() => {
    updateUI();
  });

  // Toggle pause/resume state
  document.getElementById('toggle-pause').addEventListener('click', () => {
    browser.storage.local.set({ isPaused: !isPaused });
  });

  // Clear download queue
  document.getElementById('clear-queue').addEventListener('click', () => {
    if (confirm("Are you sure you want to completely clear the download queue?")) {
      browser.runtime.sendMessage({ type: "clear-queue", showNotification: true }).then(() => {
        updateUI();
      });
    }
  });

  // Filter queue by folder: opens options page to trigger directory picker
  document.getElementById('filter-folder').addEventListener('click', () => {
    browser.tabs.create({
      url: browser.runtime.getURL("options/options.html#filter-folder")
    });
    window.close();
  });

  // Add links manually: opens options page with Add Links panel focused
  document.getElementById('add-links').addEventListener('click', () => {
    browser.tabs.create({
      url: browser.runtime.getURL("options/options.html#add-links")
    });
    window.close();
  });

  // Open options page
  document.getElementById('open-settings').addEventListener('click', () => {
    browser.runtime.openOptionsPage();
    window.close();
  });
});
