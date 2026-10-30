// Hidden page used only to write to the clipboard (service workers cannot).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'offscreen:copy' || sender.id !== chrome.runtime.id) return;
  const t = document.getElementById('t');
  t.value = msg.text;
  t.select();
  sendResponse({ ok: document.execCommand('copy') });
});
