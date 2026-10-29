// Placeholder for a sleeping pin: shows the site's title + favicon, loads nothing.
// The moment the tab becomes visible it replaces itself with the real page.
(() => {
  const params = new URLSearchParams(location.search);
  const url = params.get('url');
  let ok = false;
  try {
    ok = ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {}

  document.title = params.get('title') || url || 'Pinline';
  if (ok) {
    const icon = new URL(chrome.runtime.getURL('/_favicon/'));
    icon.searchParams.set('pageUrl', url);
    icon.searchParams.set('size', '32');
    document.getElementById('icon').href = icon.href;
  }

  const wake = () => {
    if (ok && document.visibilityState === 'visible') location.replace(url);
  };
  document.addEventListener('visibilitychange', wake);
  wake();
})();
