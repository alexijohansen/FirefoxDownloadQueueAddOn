function scrapeLinksAndSend(usaOnly = false) {
  const videoExtensions = [".zip", ".mp4", ".mkv", ".avi", ".mov", ".webm", ".flv"];

  const allLinks = Array.from(document.querySelectorAll("a[href]"))
    .map(a => a.href)
    .filter(href => {
      try {
        if (!href.startsWith("http")) return false;

        const url = new URL(href);
        const pathname = decodeURIComponent(url.pathname).toLowerCase();

        const matchesExtension = videoExtensions.some(ext => pathname.endsWith(ext));

        if (!matchesExtension) return false;

        if (usaOnly) {
          return decodeURIComponent(href).includes("d3g");
        }

        return true;
      } catch (e) {
        return false;
      }
    });

  // Remove duplicates
  const uniqueLinks = [...new Set(allLinks)];

  browser.runtime.sendMessage({
    type: "video-links",
    links: uniqueLinks,
    usaOnly
  });
}

// --- Listen for messages from background ---
browser.runtime.onMessage.addListener((message, sender) => {

  if (message.type === "scrape-links") {
    scrapeLinksAndSend(false);
  }

  if (message.type === "scrape-links-usa") {
    scrapeLinksAndSend(true);
  }

});