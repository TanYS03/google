// contentScript.js (improved - drop-in replacement)
(function () {
  function extractParagraphs() {
    const root = document.querySelector("article") || document.querySelector("main") || document.body;
    const ps = Array.from(root.querySelectorAll("p"))
      .filter(p => p.innerText && p.innerText.trim().length > 30);

    ps.forEach((p, i) => {
      p.dataset.summId = String(i + 1);
    });

    const mapped = ps.map((p, i) => ({ index: i + 1, text: p.innerText.trim().slice(0, 3000) }));
    console.debug("contentScript: extractParagraphs ->", mapped.length, "paras");
    return mapped;
  }

  function highlightParagraph(indexOrIndices) {
    const indices = Array.isArray(indexOrIndices) ? indexOrIndices : [indexOrIndices];
    for (const idx of indices) {
      const el = document.querySelector(`[data-summ-id="${idx}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        const prev = el.style.outline;
        el.style.outline = "4px solid rgba(255,165,0,0.95)";
        setTimeout(() => { el.style.outline = prev || ""; }, 5000);
        console.debug("contentScript: highlighted ¶" + idx);
        return { ok: true };
      }
    }
    console.warn("contentScript: highlightParagraph not found for", indices);
    return { ok: false, msg: "Paragraph not found" };
  }

  // message API
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.action === 'extractParagraphs') {
      try {
        const paras = extractParagraphs();
        sendResponse({ ok: true, paragraphs: paras });
      } catch (e) {
        console.error("contentScript extractParagraphs error:", e);
        sendResponse({ ok: false, error: e.message });
      }
      return true; // keep channel open for async response (not used but safe)
    }
    if (msg?.action === 'highlightParagraph') {
      try {
        const res = highlightParagraph(msg.index || msg.indices);
        sendResponse(res);
      } catch (e) {
        console.error("contentScript highlightParagraph error:", e);
        sendResponse({ ok: false, error: e.message });
      }
      return true;
    }
  });

  // initial run
  try { extractParagraphs(); } catch (e) { /* ignore */ }

  // also run on load (helps if script injected early)
  window.addEventListener('load', () => {
    try { extractParagraphs(); } catch (e) { /* ignore */ }
  });

  // MutationObserver for SPAs / dynamic content - re-run extraction on DOM changes
  const observer = new MutationObserver((mutations) => {
    // cheap throttle: only call extractParagraphs when there are added nodes or subtree changes
    let shouldRun = false;
    for (const m of mutations) {
      if (m.addedNodes && m.addedNodes.length) { shouldRun = true; break; }
      if (m.type === 'childList' || m.type === 'subtree') { shouldRun = true; break; }
    }
    if (shouldRun) {
      try { extractParagraphs(); } catch (e) { /* ignore */ }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
