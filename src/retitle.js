// Custom tab titles for renamed Favs / Pins. Registered by the service worker only on the sites of
// renamed items (needs the optional "all sites" permission). Keeps the title even when the page
// keeps changing it (e.g. "Inbox (3)").
(() => {
  if (globalThis.__pinlineRetitle) return;
  globalThis.__pinlineRetitle = true;

  let name = null;
  let original = document.title;

  const apply = () => {
    if (!name || document.title === name) return;
    if (document.title) original = document.title;
    document.title = name;
  };

  // If the page fights back (sets its title every time we set ours), back off instead of looping.
  let fights = [];
  let pausedUntil = 0;
  new MutationObserver(() => {
    if (document.title === name) return;
    original = document.title; // the page set a (new) title: remember it, then put ours back
    const now = Date.now();
    if (now < pausedUntil) return;
    fights = fights.filter((t) => now - t < 2000);
    fights.push(now);
    if (fights.length > 20) {
      pausedUntil = now + 5000;
      setTimeout(apply, 5000);
      return;
    }
    apply();
  }).observe(document, { subtree: true, childList: true, characterData: true });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'title:set') return;
    const wasRenamed = !!name;
    name = msg.name || null;
    if (name) apply();
    else if (wasRenamed) document.title = original;
  });

  chrome.runtime
    .sendMessage({ type: 'title:get' })
    .then((res) => {
      name = res?.name || null;
      apply();
    })
    .catch(() => {});
})();
