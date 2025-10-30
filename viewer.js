// viewer.js
const LAST_RESULTS_KEY = "lastSearchResult";

function escapeHtml(s) {
  if (!s) return "";
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;", '"':"&quot;","'":"&#39;"}[c]));
}

function qs(name) { return new URLSearchParams(location.search).get(name); }

// simple helper to scroll + highlight element
function highlightAndScroll(el) {
  if (!el) return;
  el.classList.add("highlight");
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => el.classList.remove("highlight"), 5000);
}

async function loadAndRender() {
  const titleEl = document.getElementById("title");
  const metaEl = document.getElementById("meta");
  const parasWrap = document.getElementById("paragraphs");
  const noResult = document.getElementById("noResult");
  const openBtn = document.getElementById("openSource");
  const copyBtn = document.getElementById("copyAll");

  // get the saved result
  const saved = await new Promise(resolve => chrome.storage.local.get([LAST_RESULTS_KEY], r => resolve(r[LAST_RESULTS_KEY])));

  if (!saved) {
    titleEl.textContent = "No summary saved";
    noResult.hidden = false;
    openBtn.disabled = true;
    copyBtn.disabled = true;
    return;
  }

  noResult.hidden = true;
  const sourceUrl = saved.sourceUrl || saved.query || "search";
  titleEl.textContent = `Summary for ${sourceUrl}`;
  metaEl.textContent = saved.paragraphs ? `${saved.paragraphs.length} paragraphs` : "";

  // paragraphs may be stored as 'paragraphs' array or we can try to synthesize from links/snippets
  const paragraphs = Array.isArray(saved.paragraphs) ? saved.paragraphs : [];

  parasWrap.innerHTML = "";
  if (paragraphs.length) {
    paragraphs.forEach(p => {
      const div = document.createElement("div");
      div.className = "para";
      div.id = `p${p.index}`;

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `¶${p.index}`;

      const txt = document.createElement("div");
      txt.className = "text";
      txt.innerHTML = escapeHtml(p.text);

      // add a small "copy" button to copy the paragraph text
      const controls = document.createElement("div");
      controls.style.marginTop = "6px";
      controls.style.display = "flex";
      controls.style.gap = "8px";

      const copyBtn = document.createElement("button");
      copyBtn.className = "btn secondary";
      copyBtn.textContent = "Copy ¶";
      copyBtn.addEventListener("click", () => {
        navigator.clipboard && navigator.clipboard.writeText(p.text);
      });

      const openAnchor = document.createElement("button");
      openAnchor.className = "btn";
      openAnchor.textContent = "Open context";
      openAnchor.addEventListener("click", async () => {
        // Attempt to open the original source (if available). If the source is a chrome-extension internal marker,
        // the popup that created it should have used viewer already.
        if (saved.sourceUrl && saved.sourceUrl.startsWith("http")) {
          try {
            chrome.tabs.create({ url: saved.sourceUrl, active: true });
          } catch (e) {
            window.open(saved.sourceUrl, "_blank");
          }
        } else {
          // nothing to open
          alert("No external source available for this summary.");
        }
      });

      controls.appendChild(copyBtn);
      controls.appendChild(openAnchor);

      div.appendChild(meta);
      div.appendChild(txt);
      div.appendChild(controls);
      parasWrap.appendChild(div);
    });
  } else {
    // show summary text if paragraphs not available
    const raw = document.createElement("div");
    raw.className = "para";
    raw.innerHTML = `<div class="text">${escapeHtml(saved.summaryText || "")}</div>`;
    parasWrap.appendChild(raw);
  }

  // open source button opens the original URL if present
  openBtn.addEventListener("click", () => {
    if (saved.sourceUrl && /^https?:\/\//i.test(saved.sourceUrl)) {
      chrome.tabs.create({ url: saved.sourceUrl, active: true });
    } else {
      alert("No external source available for this summary.");
    }
  });

  copyBtn.addEventListener("click", () => {
    const txt = saved.summaryText || (paragraphs.map(p => `¶${p.index}: ${p.text}`).join("\n\n"));
    navigator.clipboard && navigator.clipboard.writeText(txt);
  });

  // if a target param is present (e.g. ?target=%23p12) scroll and highlight
  const target = qs("target");
  if (target) {
    try {
      const id = decodeURIComponent(target).replace(/^#/, "");
      const el = document.getElementById(id);
      if (el) setTimeout(() => highlightAndScroll(el), 120);
    } catch (e) { /* ignore */ }
  }
}

document.addEventListener("DOMContentLoaded", loadAndRender);
