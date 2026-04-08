// Wait for the HTML DOM to load before binding our logic
document.addEventListener('DOMContentLoaded', () => {
  restoreOptions();
  refreshQueue();

  document.getElementById('options-form').addEventListener('submit', saveOptions);
  document.getElementById('refresh-queue').addEventListener('click', refreshQueue);
  document.getElementById('clear-queue').addEventListener('click', () => {
    if (confirm("Are you sure you want to completely clear the download queue?")) {
      browser.runtime.sendMessage({ type: "clear-queue" }).then(() => {
        refreshQueue();
      });
    }
  });
});

// Helper to load current values from Extension Native Storage (which persists across Firefox sessions)
function restoreOptions() {
  browser.storage.local.get({
    maxActiveDownloads: 1,
    downloadDelay: 5000,
    retryDelay: 30000,
    maxRetries: 10,
    scrapeExtensions: [".zip", ".mp4", ".mkv", ".avi", ".mov", ".webm", ".flv"]
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

    if (!response || !response.queue || response.queue.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty-state';
      li.textContent = 'Queue is currently empty';
      queueList.appendChild(li);
      return;
    }

    response.queue.forEach((item, index) => {
      const li = document.createElement('li');
      // Item can be a string or an object {url: string, folder: string}
      const url = typeof item === "string" ? item : item.url;
      li.textContent = `${index + 1}. ${url}`;
      queueList.appendChild(li);
    });
  }).catch(error => {
    console.error("Error fetching queue:", error);
    const queueList = document.getElementById('queue-list');
    queueList.innerHTML = '<li class="empty-state" style="color: red;">Error loading queue. Is the extension running?</li>';
  });
}
