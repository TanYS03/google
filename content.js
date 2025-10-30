// content.js - simple extractor used by popup.js
function extractVisibleParagraphs() {
  const root = document.querySelector('article, main, [role="main"]') || document.body;
  const nodes = Array.from(root.querySelectorAll('p'));
  const paragraphs = nodes
    .map(p => p.innerText && p.innerText.trim())
    .filter(Boolean)
    .map((text, i) => ({ index: i+1, text: text.slice(0, 5000) })); // limit
  return paragraphs;
}

function findPdfUrlOnPage() {
  // direct .pdf anchors
  const a = document.querySelector('a[href$=".pdf"]');
  if (a && a.href) return a.href;
  // embed/object/iframe
  const embed = document.querySelector('embed[type="application/pdf"], object[type="application/pdf"], iframe[src$=".pdf"]');
  if (embed) return embed.src || embed.getAttribute('data') || null;
  // viewer embedded blob maybe; try to sniff viewer embed iframe
  const iframe = document.querySelector('iframe');
  if (iframe && iframe.src && iframe.src.includes('pdf')) return iframe.src;
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return;
  if (msg.action === 'extractParagraphs') {
    const pdfUrl = findPdfUrlOnPage();
    if (pdfUrl) {
      sendResponse({ ok: true, type: 'pdf', url: pdfUrl });
      return;
    }
    const paragraphs = extractVisibleParagraphs();
    sendResponse({ ok: true, type: 'html', paragraphs });
  } else if (msg.action === 'highlightParagraph' && typeof msg.index === 'number') {
    // naive highlight: try to find nth paragraph and scroll
    const pNodes = Array.from(document.querySelectorAll('article p, main p, p'));
    const node = pNodes[msg.index - 1];
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      node.style.background = 'rgba(255,255,0,0.5)';
      setTimeout(()=> node.style.transition = 'background 1s', 50);
      setTimeout(()=> node.style.background = '', 2000);
    }
    sendResponse({ ok: true });
  }
});
