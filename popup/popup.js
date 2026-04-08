document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('clear-queue').addEventListener('click', () => {
    // We don't contain logic directly in the popup, as the popup is totally destroyed whenever the user clicks away.
    // We reliably message the 'background' instance of our code to execute logic instead.
    browser.runtime.sendMessage({ type: "clear-queue", showNotification: true }).then(() => {
      window.close(); // Tear down the popup after triggering
    });
  });

  document.getElementById('open-settings').addEventListener('click', () => {
    browser.runtime.openOptionsPage();
    window.close();
  });
});
