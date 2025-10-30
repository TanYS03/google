
// ---------- CONFIG ----------
const CSE_API_KEY = "API_KEY";
const CSE_CX = CX_KEY";
const GEMINI_KEY = "GEMINI_KEY";
// ----------------------------

const LAST_RESULTS_KEY = "lastSearchResult";
const ALLOWED_SITES_KEY = "allowedSites";

let currentParagraphs = null;

console.log("AI interfaces:", { window_ai: window.ai, chrome_ai: window.chrome && chrome.chrome?.ai || (window.chrome && window.chrome.ai) });

// ---------- storage (single canonical copy) ----------
function storageGet(key) {
  return new Promise(resolve => chrome.storage.local.get([key], res => resolve(res[key])));
}
function storageSet(key, value) {
  return new Promise(resolve => chrome.storage.local.set({ [key]: value }, () => resolve()));
}
function storageRemove(key) {
  return new Promise(resolve => chrome.storage.local.remove([key], () => resolve()));
}

// ---------- small DOM helpers ----------
function getEl(id) { return document.getElementById(id); }
function setStatus(msg) { const s = getEl("status"); if (s) s.innerText = msg || ""; }
function clearResults() { const r = getEl("result"); if (r) r.innerHTML = ""; }
function escapeHtml(s) { if (!s) return ""; return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;", '"':"&quot;","'":"&#39;"}[c])); }

// ---------- defaults ----------
const DEFAULT_SITES = ["researchgate.net", "semanticscholar.org", "sciencedirect.com"];


// top-level: used by popup and click handlers
async function openUrlAndHighlight(url, index) {
  if (!url) return;
  try {
    const allTabs = await chrome.tabs.query({});
    let existing = allTabs.find(t => t.url && (t.url === url || sameBaseUrl(t.url, url)));

    // helper to inject content script and then send highlight
    async function injectAndSend(tabId) {
      try {
        // inject contentScript.js (ensure file name matches your extension)
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['contentScript.js']
        });
      } catch (injectErr) {
        // injection may fail on some pages (e.g., Chrome Web Store, extension pages, some cross-origin frames)
        console.warn("Injection failed:", injectErr);
      }

      // Try to send message
      chrome.tabs.sendMessage(tabId, { action: "highlightParagraph", index }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          console.warn("Message failed or no response; lastError:", chrome.runtime.lastError, "resp:", resp);
        }
      });
    }

    if (existing) {
      // focus window containing the tab (optional)
      try { await chrome.windows.update(existing.windowId, { focused: true }); } catch(e){}

      // try sending first; if fails, inject & resend
      chrome.tabs.sendMessage(existing.id, { action: "highlightParagraph", index }, async (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          // try injecting then sending
          await injectAndSend(existing.id);

          // as a final effort reload and try again (sometimes CSP blocks until reload)
          chrome.tabs.reload(existing.id, {}, () => {
            const listener = (tabId, changeInfo) => {
              if (tabId === existing.id && changeInfo.status === "complete") {
                chrome.tabs.onUpdated.removeListener(listener);
                injectAndSend(existing.id);
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
          });
        }
      });
      return;
    }

    // No existing tab: create one and wait for load to finish, then inject and message
    chrome.tabs.create({ url, active: true }, (tab) => {
      if (!tab || !tab.id) { openViewerFallback(url, index); return; }
      const onUpdated = async (tabId, changeInfo) => {
        if (tabId !== tab.id) return;
        if (changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['contentScript.js'] });
          } catch (e) {
            console.warn("Injection after open failed:", e);
            // fallback to viewer if injection not possible
            openViewerFallback(url, index);
            return;
          }
          chrome.tabs.sendMessage(tab.id, { action: "highlightParagraph", index }, (resp) => {
            if (chrome.runtime.lastError || !resp || !resp.ok) {
              // fallback viewer if messaging still fails
              openViewerFallback(url, index);
            }
          });
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
    });

  } catch (err) {
    console.error("openUrlAndHighlight error:", err);
    openViewerFallback(url, index);
  }
}

function openViewerFallback(url, index) {
  const viewer = chrome.runtime.getURL("viewer.html") + `?target=%23p${index}&source=last`;
  chrome.tabs.create({ url: viewer, active: true });
}

// ---------- UI / init ----------
document.addEventListener("DOMContentLoaded", async () => {
  // cache DOM
  const checkboxContainer = getEl("checkboxContainer");
  const addSiteBtn = getEl("addSiteBtn");
  const newSiteInput = getEl("newSiteInput");
  const addPresetsBtn = getEl("addPresetsBtn");
  const searchBtn = getEl("searchBtn");
  const engineSize = getEl("engineSize");

  if (!checkboxContainer || !addSiteBtn || !newSiteInput || !addPresetsBtn || !searchBtn) {
    console.error("Missing elements in popup.html");
    return;
  }

  // load saved site presets and last results
  await loadSites();
  await restoreLastResult();


  // add site
  addSiteBtn.addEventListener("click", async () => {
    const newSite = (newSiteInput.value || "").trim();
    if (!newSite) return alert("Enter a valid site domain.");
    const stored = (await storageGet(ALLOWED_SITES_KEY)) || DEFAULT_SITES.slice();
    if (!stored.includes(newSite)) {
      stored.push(newSite);
      await storageSet(ALLOWED_SITES_KEY, stored);
      await loadSites();
    }
    newSiteInput.value = "";
  });

  // apply presets -> save currently checked as allowedSites
  addPresetsBtn.addEventListener("click", async () => {
    const selected = Array.from(checkboxContainer.querySelectorAll('input[type=checkbox]:checked')).map(cb => cb.value.trim()).filter(Boolean);
    await storageSet(ALLOWED_SITES_KEY, selected);
    alert("✅ Sites saved: " + selected.join(", "));
  });

  // MAIN SEARCH button - single canonical handler
  searchBtn.addEventListener("click", async () => {
    const q = (getEl("query") || {}).value || "";
    if (!q.trim()) { alert("Please enter a search term"); return; }
    const num = engineSize ? Number(engineSize.value) : 5;
    // gather checked boxes (pass selectedSites to performSearch)
    const selectedSites = Array.from(checkboxContainer.querySelectorAll('input[type=checkbox]:checked')).map(cb => cb.value.trim()).filter(Boolean);
    await performSearch(q.trim(), num, selectedSites);
  });

  // wire optional page/url/find controls if present
  const summarizePageBtn = getEl("summarizePageBtn");
  if (summarizePageBtn) summarizePageBtn.addEventListener("click", summarizeCurrentTab);

  const summarizeUrlBtn = getEl("summarizeUrlBtn");
  if (summarizeUrlBtn) summarizeUrlBtn.addEventListener("click", async () => {
    const url = (getEl("urlToSummarize")||{}).value || "";
    if (!url) return alert("Paste URL first.");
    await summarizeUrl(url.trim());
  });

  const findBtn = getEl("findBtn");
  if (findBtn) findBtn.addEventListener("click", async () => {
    const q = (getEl("findQuery")||{}).value || "";
    if (!q.trim()) return alert("Enter a query.");
    await findOnPage(q.trim());
  });

  // PDF file input handler
  const fileInput = document.getElementById("pdfFileInput");
  if (fileInput) {
    fileInput.addEventListener("change", async (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (!f) return;
      setStatus("Reading PDF file...");
      try {
        const ab = await f.arrayBuffer();
        const paragraphs = await extractParagraphsFromPdfArrayBuffer(ab, 50);
        if (!paragraphs.length) { setStatus("No text found in PDF."); return; }
        currentParagraphs = paragraphs;
        setStatus("Summarizing PDF...");
        const prompt = buildParagraphPrompt(paragraphs);
        const modelText = await callGemini(prompt);
        const bullets = parseBulletsWithRefs(modelText);
        await renderAndPersistResult({
          sourceUrl: f.name,
          paragraphsCount: paragraphs.length,
          summaryText: modelText,
          bullets,
          paragraphs: paragraphs.slice(0,80).map(p=>({index:p.index, text:p.text.slice(0,300)}))
        });
        setStatus("");
      } catch (err) {
        console.error(err);
        setStatus("❌ PDF processing failed: " + (err.message || err));
      }
    });
  }
});

// ---------- loadSites ----------
async function loadSites() {
  const stored = (await storageGet(ALLOWED_SITES_KEY)) || DEFAULT_SITES.slice();
  const container = getEl("checkboxContainer");
  if (!container) return;
  container.innerHTML = "";
  stored.forEach(site => {
    const div = document.createElement("div");
    div.className = "site-item";

    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = site;

    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + site));

    const delBtn = document.createElement("button");
    delBtn.textContent = "–";
    delBtn.className = "delete-btn";
    delBtn.addEventListener("click", async () => {
      const updated = (await storageGet(ALLOWED_SITES_KEY)) || [];
      const filtered = updated.filter(s => s !== site);
      await storageSet(ALLOWED_SITES_KEY, filtered);
      await loadSites();
    });

    div.appendChild(label);
    div.appendChild(delBtn);
    container.appendChild(div);
  });
}

// ---------- Google CSE helper ----------
function buildSearchQuery(originalQuery, sites=[]) {
  const cleaned = originalQuery.trim();
  if (!cleaned) return "";
  const sitePart = (sites || []).map(s => `site:${s.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}`).join(" OR ");
  return sitePart ? `${cleaned} ${sitePart}` : cleaned;
}
async function googleCSEQuery(q, num = 5, sites = []) {
  const query = buildSearchQuery(q, sites);
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(CSE_API_KEY)}&cx=${encodeURIComponent(CSE_CX)}&q=${encodeURIComponent(query)}&num=${num}`;
  const resp = await fetch(url);
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`CSE error ${resp.status}: ${txt}`);
  const data = JSON.parse(txt);
  return data.items || [];
}

// ---------- Summarization wrappers ----------
async function summarizeWithGeminiNano(prompt) {
  try {
    const ai = (window.ai || (window.chrome && (window.chrome.ai || chrome.ai)));
    if (!ai) {
      console.info("Gemini Nano: window.ai not present");
      return null;
    }


    // 1) ai.createSession (preferred)
    if (typeof ai.createSession === "function") {
      try {
        console.info("Gemini Nano: attempting ai.createSession(...)");
        const session = await ai.createSession({ model: "gemini-nano" });
        // session.prompt or session.send could exist depending on runtime
        if (typeof session.prompt === "function") {
          const res = await session.prompt(prompt);
          console.info("Gemini Nano: used ai.createSession + session.prompt");
          return typeof res === "string" ? res : (res?.output || JSON.stringify(res));
        } else if (typeof session.send === "function") {
          const res2 = await session.send({ input: prompt });
          console.info("Gemini Nano: used ai.createSession + session.send");
          return typeof res2 === "string" ? res2 : (res2?.output || JSON.stringify(res2));
        }
      } catch (err) {
        console.warn("Gemini Nano createSession failed:", err);
        // continue to other fallbacks
      }
    }

    // 2) ai.create (older surface)
    if (typeof ai.create === "function") {
      try {
        console.info("Gemini Nano: attempting ai.create({model:'gemini-nano'})");
        const session = await ai.create({ model: "gemini-nano" });
        if (typeof session.prompt === "function") {
          const res = await session.prompt(prompt);
          console.info("Gemini Nano: used ai.create + session.prompt");
          return typeof res === "string" ? res : (res?.output || JSON.stringify(res));
        } else if (typeof session.send === "function") {
          const res2 = await session.send({ input: prompt });
          console.info("Gemini Nano: used ai.create + session.send");
          return typeof res2 === "string" ? res2 : (res2?.output || JSON.stringify(res2));
        }
      } catch (err) {
        console.warn("Gemini Nano ai.create failed:", err);
      }
    }

    // 3) ai.prompt (global prompt helper)
    if (typeof ai.prompt === "function") {
      try {
        console.info("Gemini Nano: attempting ai.prompt(...)");
        const res = await ai.prompt(prompt);
        console.info("Gemini Nano: used ai.prompt");
        return typeof res === "string" ? res : (res?.output || JSON.stringify(res));
      } catch (err) {
        console.warn("Gemini Nano ai.prompt failed:", err);
      }
    }

    // 4) ai.createTextSession or ai.createText? (older variants you had)
    if (typeof ai.createTextSession === "function") {
      try {
        console.info("Gemini Nano: attempting ai.createTextSession()");
        const s = await ai.createTextSession();
        const res = await s.prompt(prompt);
        console.info("Gemini Nano: used ai.createTextSession");
        return typeof res === "string" ? res : (res?.output || JSON.stringify(res));
      } catch (err) {
        console.warn("Gemini Nano createTextSession failed:", err);
      }
    }

    // If nothing succeeded:
    console.info("Gemini Nano: available but no supported API method succeeded");
    return null;

  } catch (err) {
    console.warn("Gemini Nano unexpected error:", err);
    return null;
  }
}

async function summarizeWithGeminiFlash(prompt) {
  const candidates = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-pro-latest"];
  for (const model of candidates) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
    try {
      console.info(`Gemini Flash: calling cloud model ${model}`);
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      const txt = await resp.text();
      if (!resp.ok) {
        console.warn(`Gemini Flash: model ${model} returned HTTP ${resp.status}`);
        continue;
      }
      const data = JSON.parse(txt);
      const out = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (out) {
        console.info(`Gemini Flash: succeeded with model ${model}`);
        return out;
      }
      console.warn(`Gemini Flash: model ${model} returned no candidate text`);
    } catch (err) {
      console.warn(`Gemini Flash: model ${model} error:`, err);
    }
  }
  throw new Error("All Gemini Flash endpoints failed.");
}

// helper: compare two URLs to decide if they point to same page (basic)
function sameBaseUrl(a,b) {
  if (!a || !b) return false;
  try {
    const A = new URL(a);
    const B = new URL(b);
    // same origin
    if (A.origin !== B.origin) return false;
    // consider same if pathnames are equal or one is index/default or differs only by trailing slash
    const norm = p => p.replace(/\/(index\.html|default\.(asp|html))?$/i, '').replace(/\/+$/, '') || '/';
    return norm(A.pathname) === norm(B.pathname);
  } catch (e) {
    return false;
  }
}

async function openUrl(url, options = {}) {
  // options: { openActive: boolean } - if true open active tab (viewer)
  try {
    // Normal web links
    if (/^https?:\/\//i.test(url)) {
      if (chrome && chrome.tabs && typeof chrome.tabs.create === "function") {
        chrome.tabs.create({ url, active: false }, (tab) => {
          try { chrome.storage.local.set({ lastOpenedURL: url }); } catch (e) {}
        });
        return;
      } else {
        window.open(url, "_blank");
        return;
      }
    }



    // Pass along a target fragment so viewer can jump to a paragraph (e.g. #p3).
    const viewerUrl = chrome.runtime.getURL("viewer.html") + "?source=last" + (options.target ? `&target=${encodeURIComponent(options.target)}` : "");
    // viewer opened active so user sees it
    if (chrome && chrome.tabs && typeof chrome.tabs.create === "function") {
      chrome.tabs.create({ url: viewerUrl, active: true });
      return;
    } else {
      window.open(viewerUrl, "_blank");
      return;
    }
  } catch (err) {
    console.error("openUrl error", err);
    throw err;
  }
}

// ---------- render and persist (works for both CSE-results and paragraph-based results) ----------
async function renderAndPersistResult(resultObj) {
  // resultObj: { query, sites, summaryText, links:[{title,link,snippet}], bullets:[{text, paraRefs}], paragraphs:[{index,text}], sourceUrl }
  const r = getEl("result");
  if (!r) return;
  r.innerHTML = "";

  // header
  const header = document.createElement("div");
  header.innerHTML = `<b>Summary for ${escapeHtml(resultObj.sourceUrl || resultObj.query || "search")}</b>`;
  r.appendChild(header);

  // render bullets if present
  const summaryDiv = document.createElement("div");
  summaryDiv.style.marginTop = "8px";

  if (Array.isArray(resultObj.bullets) && resultObj.bullets.length) {
    resultObj.bullets.forEach((b) => {
      const el = document.createElement("div");
      el.className = "summary-bullet";
      const text = document.createElement("div");
      text.innerHTML = escapeHtml(b.text);
      el.appendChild(text);

      if (b.paraRefs && b.paraRefs.length) {
        const citeWrap = document.createElement("div");
        citeWrap.style.marginTop = "6px";
        b.paraRefs.forEach(idx => {
          const btn = document.createElement("button");
          btn.textContent = `¶${idx}`;
          btn.style.marginRight = "6px";

          // when clicked: try to highlight in active tab if it's the same source,
          // otherwise open the extension viewer and jump to that paragraph.
          btn.addEventListener("click", async () => {
          try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const activeUrl = tabs && tabs[0] && tabs[0].url ? tabs[0].url : null;

            // If the active tab is the same page we summarized, just message it
            if (activeUrl && resultObj.sourceUrl && sameBaseUrl(activeUrl, resultObj.sourceUrl)) {
              chrome.tabs.sendMessage(tabs[0].id, { action: "highlightParagraph", index: idx }, (resp) => {
                if (chrome.runtime.lastError) {
                  // If message fails (maybe content script not injected), fallback to openUrlAndHighlight
                  openUrlAndHighlight(resultObj.sourceUrl, idx);
                }
              });
              return;
            }

            // Otherwise open the page (or reuse existing tab) and ask it to highlight the paragraph
            await openUrlAndHighlight(resultObj.sourceUrl, idx);

          } catch (err) {
            console.error("citation click error", err);
            alert("Could not navigate to paragraph: " + (err.message || err));
          }
        });

          citeWrap.appendChild(btn);
        });
        el.appendChild(citeWrap);
      }
      summaryDiv.appendChild(el);
    });
  } else if (resultObj.summaryText) {
    const raw = document.createElement("div");
    raw.innerHTML = escapeHtml(resultObj.summaryText).replace(/\n/g, "<br>");
    summaryDiv.appendChild(raw);
  }
  r.appendChild(summaryDiv);

  // sources / links area - render as buttons (not raw anchor href)
  if (Array.isArray(resultObj.links) && resultObj.links.length) {
    const sourcesHtml = document.createElement("div");
    sourcesHtml.style.marginTop = "10px";
    sourcesHtml.innerHTML = `<b>Top sources (${resultObj.links.length}):</b>`;
    resultObj.links.forEach((l, idx) => {
      const item = document.createElement("div");
      item.className = "result-item";

      // create a button instead of anchor (prevents default navigation & popup-close)
      const btn = document.createElement("button");
      btn.className = "result-link";
      btn.dataset.url = l.link;
      btn.dataset.idx = idx;
      btn.textContent = l.title;

      const snippetDiv = document.createElement("div");
      snippetDiv.className = "snippet";
      snippetDiv.textContent = l.snippet || "";

      item.appendChild(btn);
      item.appendChild(snippetDiv);
      sourcesHtml.appendChild(item);

      // click handler per button
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        const url = btn.dataset.url;
        if (!url) return;

        // If the URL contains a #pN fragment, extract it and call openUrlAndHighlight so it scrolls on load
        const fragMatch = url.match(/#p(\d+)$/i);
        if (fragMatch) {
          const pIndex = Number(fragMatch[1]);
          await openUrlAndHighlight(url.split('#')[0], pIndex);
          return;
        }

        // Otherwise just open the link (background tab) - keep popup open when possible
        try {
          await openUrl(url);
        } catch (err) {
          console.error("open source link failed", err);
          setStatus("❌ Could not open link");
        }
      });
    });
    r.appendChild(sourcesHtml);
  }

  // small sourceUrl link at bottom (readonly)
  if (resultObj.sourceUrl) {
    const src = document.createElement("div");
    src.style.marginTop = "10px";
    // use button to open viewer / external
    const openBtn = document.createElement("button");
    openBtn.textContent = resultObj.sourceUrl;
    openBtn.title = "Open source (background tab or viewer)";
    openBtn.addEventListener("click", async () => {
      try { await openUrl(resultObj.sourceUrl); } catch (err) { console.error(err); }
    });
    src.innerHTML = `<b>Source</b>: `;
    src.appendChild(openBtn);
    r.appendChild(src);
  }

  // persist compact representation BEFORE attaching click handlers so restore works immediately
  await storageSet(LAST_RESULTS_KEY, resultObj);

  setStatus("");
}

// ---------- restore last result ----------
async function restoreLastResult() {
  try {
    const saved = await storageGet(LAST_RESULTS_KEY);
    if (!saved) return;
    await renderAndPersistResult(saved);
  } catch (err) {
    console.warn("restore failed", err);
  }
}

// ---------- performSearch (CSE -> summarize -> render) ----------
async function performSearch(query, maxResults = 5, selectedSites = []) {
  clearResults();
  setStatus("🔎 Searching relevant research...");

  try {
    let effectiveSites = Array.isArray(selectedSites) && selectedSites.length ? selectedSites : Array.from((document.getElementById("checkboxContainer") || document.body).querySelectorAll("input[type=checkbox]:checked")).map(cb=>cb.value.trim()).filter(Boolean);
    if (!effectiveSites.length) effectiveSites = (await storageGet(ALLOWED_SITES_KEY)) || DEFAULT_SITES.slice();

    const items = await googleCSEQuery(query, maxResults, effectiveSites);
    if (!items || items.length === 0) { setStatus("No results found."); return; }

    const links = items.map(it => ({ title: it.title, link: it.link, snippet: it.snippet || "" }));

    // Build summarization prompt from returned links
    let prompt = `Summarize the key findings from these research links in 3-6 concise bullet points. For each bullet append the source URL in parentheses.\n\n`;
    for (const l of links) {
      prompt += `- ${l.title}\n  ${l.snippet}\n  ${l.link}\n\n`;
    }

    setStatus("🧠 Generating summary...");
    let summary = await summarizeWithGeminiNano(prompt);
    if (!summary) summary = await summarizeWithGeminiFlash(prompt);

    await renderAndPersistResult({ query, sites: effectiveSites, summaryText: summary, links });

  } catch (err) {
    console.error("performSearch error", err);
    setStatus("❌ Error: " + (err.message || err));
  }
}

// ---------- Paragraph-based helpers for page & pdf summarization ----------
function buildParagraphPrompt(paragraphs, userInstruction=null) {
  // paragraphs: [{index, text}]
  let prompt = `I will give you numbered paragraphs from an article. Produce 3-6 concise bullet points summarizing the main results or findings. For each bullet, append which paragraph index (¶N or ¶N-M) supports this bullet. If you quote or summarize an exact line, include the paragraph index.\n\n`;
  paragraphs.forEach(p => prompt += `Paragraph ${p.index}:\n${p.text}\n\n`);
  prompt += `\nOutput: bullet points only, each ended by parentheses with paragraph indexes like (¶2) or (¶2-3).`;
  if (userInstruction) prompt += `\nAlso: ${userInstruction}`;
  return prompt;
}
function parseBulletsWithRefs(modelText) {
  if (!modelText) return [];
  // split by new line starting with hyphen or numeric bullet
  const lines = modelText.split(/\n/).map(s=>s.trim()).filter(Boolean);
  // gather lines that start with dash or digit or otherwise treat all lines as bullets
  const bullets = [];
  for (const l of lines) {
    // only take lines that look like bullets or treat as bullet
    let text = l.replace(/^-+\s*/, "").replace(/^\d+\.\s*/, "");
    // find refs
    const refs = [];
    const re = /\(¶\s*([\d]+)(?:-(\d+))?\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[2]) {
        const start = Number(m[1]), end = Number(m[2]);
        for (let k=start;k<=end;k++) refs.push(k);
      } else {
        refs.push(Number(m[1]));
      }
    }
    text = text.replace(/\(¶\s*\d+(?:-\d+)?\)/g, "").trim();
    bullets.push({ text, paraRefs: Array.from(new Set(refs)) });
  }
  return bullets;
}
async function callGemini(prompt) {
  console.info("callGemini: attempting Gemini Nano first...");
  const nanoOut = await summarizeWithGeminiNano(prompt);
  if (nanoOut) {
    console.info("callGemini: using Gemini Nano (local)");
    console.debug("=== Gemini Nano output start ===\n", nanoOut, "\n=== end ===");
    return nanoOut;
  }

  console.info("callGemini: Gemini Nano unavailable or failed — falling back to Gemini Flash (cloud)");
  const flashOut = await summarizeWithGeminiFlash(prompt);
  console.info("callGemini: using Gemini Flash (cloud)");
  console.debug("=== Gemini Flash output start ===\n", flashOut, "\n=== end ===");
  return flashOut;
}

// ---------- summarize current tab (content script required) ----------
async function summarizeCurrentTab() {
  setStatus("Extracting page text...");
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || !tabs[0]) return alert("No active tab found.");
  const tab = tabs[0];
  const tabUrl = tab.url || '';

  // First try content script extraction (works for normal HTML article pages)
  chrome.tabs.sendMessage(tab.id, { action: "extractParagraphs" }, async (resp) => {
    if (resp && resp.ok && resp.paragraphs && resp.paragraphs.length) {
      // got paragraphs, proceed
      const paragraphs = resp.paragraphs;
      // call your summarization flow that uses paragraphs (buildParagraphPrompt, callGemini, etc.)
      // ... existing code
      return;
    }

    // fallback: if URL looks like PDF, ask background to fetch bytes and parse via pdf.js
    if (looksLikePdfUrl(tabUrl)) {
      setStatus("PDF detected — fetching PDF via background...");
      const pdfResp = await bgFetchPdfArrayBuffer(tabUrl);
      if (!pdfResp || !pdfResp.ok) {
        setStatus("❌ Could not fetch PDF via background: " + (pdfResp?.error || 'unknown'));
        return;
      }
      try {
        const paragraphs = await extractParagraphsFromPdfArrayBuffer(pdfResp.buffer, 40);
        if (!paragraphs.length) { setStatus("No text extracted from PDF."); return; }
        // build prompt and summarize as usual
        const prompt = buildParagraphPrompt(paragraphs);
        const modelText = await callGemini(prompt);
        const bullets = parseBulletsWithRefs(modelText);
        const resultObj = {
          sourceUrl: tabUrl,
          paragraphsCount: paragraphs.length,
          summaryText: modelText,
          bullets,
          paragraphs: paragraphs.slice(0, 80).map(p => ({ index: p.index, text: p.text.slice(0,300) }))
        };
        await renderAndPersistResult(resultObj);
        setStatus("");
      } catch (err) {
        console.error(err);
        setStatus("❌ PDF parse failed: " + err.message);
      }
      return;
    }

    // if neither content script nor PDF fallback worked, try background fetch of HTML
    setStatus("Could not extract from page; trying background fetch of page HTML...");
    const pageResp = await bgFetchText(tabUrl);
    if (!pageResp || !pageResp.ok) {
      setStatus("❌ Could not fetch URL (CORS or blocked). Try copying the URL and using 'Summarize URL'.");
      return;
    }
    // parse HTML string and extract paragraphs as in summarizeUrl()
    const parser = new DOMParser();
    const doc = parser.parseFromString(pageResp.text, "text/html");
    const root = doc.querySelector("article") || doc.querySelector("main") || doc.body;
    const ps = Array.from(root.querySelectorAll("p")).filter(p => p.textContent && p.textContent.trim().length > 30);
    const paragraphs = ps.map((p,i) => ({ index: i+1, text: p.textContent.trim().slice(0,3000) }));
    if (!paragraphs.length) { setStatus("No paragraphs found in fetched HTML."); return; }
    setStatus("Summarizing...");
    const prompt = buildParagraphPrompt(paragraphs);
    const modelText = await callGemini(prompt);
    const bullets = parseBulletsWithRefs(modelText);
    await renderAndPersistResult({
      sourceUrl: tabUrl,
      paragraphsCount: paragraphs.length,
      summaryText: modelText,
      bullets,
      paragraphs: paragraphs.slice(0,80).map(p => ({ index: p.index, text: p.text.slice(0,300) }))
    });
    setStatus("");
  });
}

// ---------- summarize arbitrary URL (fetch -> parse -> summarize) ----------
async function summarizeUrl(url) {
  setStatus("Fetching URL...");
  clearResults();

  try {
    // If the URL looks like a PDF, fetch PDF bytes (try background fetch first)
    if (looksLikePdfUrl(url)) {
      setStatus("Detected PDF URL — fetching PDF via background...");
      const pdfResp = await bgFetchPdfArrayBuffer(url);
      if (!pdfResp || !pdfResp.ok) {
        throw new Error(pdfResp?.error || "Background PDF fetch failed");
      }
      // extract paragraphs from bytes
      const paragraphs = await extractParagraphsFromPdfArrayBuffer(pdfResp.buffer, 40);
      if (!paragraphs || paragraphs.length === 0) {
        setStatus("No text extracted from PDF."); 
        return;
      }
      setStatus("Summarizing PDF content...");
      const prompt = buildParagraphPrompt(paragraphs);
      const modelText = await callGemini(prompt);
      const bullets = parseBulletsWithRefs(modelText);
      const resultObj = {
        sourceUrl: url,
        paragraphsCount: paragraphs.length,
        summaryText: modelText,
        bullets,
        paragraphs: paragraphs.slice(0, 80).map(p => ({ index: p.index, text: p.text.slice(0, 300) }))
      };
      await renderAndPersistResult(resultObj);
      setStatus("");
      return;
    }

    // Try direct fetch from popup (fast path when CORS allows)
    let html;
    let resp;
    try {
      resp = await fetch(url);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      html = await resp.text();
    } catch (errFetch) {
      // on fetch error (likely CORS), fall back to background fetch
      setStatus("Direct fetch failed (CORS). Trying background fetch...");
      const pageResp = await bgFetchText(url);
      if (!pageResp || !pageResp.ok) {
        throw new Error(pageResp?.error || "Background fetch failed");
      }
      html = pageResp.text;
      resp = null;
    }

    // If fetch succeeded and returned OK and content appears to have paragraphs, proceed
    if (resp && resp.ok) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      const root = doc.querySelector("article") || doc.querySelector("main") || doc.body;
      const ps = Array.from(root.querySelectorAll("p")).filter(p => p.innerText && p.innerText.trim().length > 30);
      if (ps.length) {
        const paragraphs = ps.map((p,i) => ({ index: i+1, text: p.innerText.trim().slice(0,3000) }));
        setStatus("Summarizing...");
        const prompt = buildParagraphPrompt(paragraphs);
        const modelText = await callGemini(prompt);
        const bullets = parseBulletsWithRefs(modelText);
        await renderAndPersistResult({
          sourceUrl: url,
          paragraphsCount: paragraphs.length,
          summaryText: modelText,
          bullets,
          paragraphs: paragraphs.slice(0,80).map(p => ({index: p.index, text: p.text.slice(0,300)}))
        });
        setStatus("");
        return;
      }
      // else fallthrough to background fetch
    }

    // If we get here, either initial fetch failed, returned non-ok, or no paragraphs -> try background fetch
    setStatus("Initial fetch failed or no paragraphs found — trying background fetch (extension privileged)...");
    const bgResp = await bgFetchText(url);
    if (!bgResp || !bgResp.ok) {
      setStatus(`❌ Could not fetch/summarize URL: HTTP ${bgResp?.status || bgResp?.error || 'error'}`);
      return;
    }

    // parse bgResp.text
    const parser2 = new DOMParser();
    const doc2 = parser2.parseFromString(bgResp.text, "text/html");
    const root2 = doc2.querySelector("article") || doc2.querySelector("main") || doc2.body;
    const ps2 = Array.from(root2.querySelectorAll("p")).filter(p => p.innerText && p.innerText.trim().length > 30);
    if (!ps2.length) {
      setStatus("No paragraphs found on the fetched page.");
      return;
    }
    const paragraphs = ps2.map((p,i) => ({ index: i+1, text: p.innerText.trim().slice(0,3000) }));
    setStatus("Summarizing...");
    const prompt2 = buildParagraphPrompt(paragraphs);
    const modelText2 = await callGemini(prompt2);
    const bullets2 = parseBulletsWithRefs(modelText2);
    await renderAndPersistResult({
      sourceUrl: url,
      paragraphsCount: paragraphs.length,
      summaryText: modelText2,
      bullets: bullets2,
      paragraphs: paragraphs.slice(0,80).map(p => ({index: p.index, text: p.text.slice(0,300)}))
    });
    setStatus("");
  } catch (err) {
    console.error("summarizeUrl error:", err);
    setStatus("❌ Could not fetch/summarize URL: " + (err.message || err));
  }
}

// helper: ask background to fetch page text or pdf bytes
function bgFetchText(url) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'fetchUrlText', url }, (resp) => resolve(resp));
  });
}
function bgFetchPdfArrayBuffer(url) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'fetchPdfArrayBuffer', url }, (resp) => resolve(resp));
  });
}

// detect PDF by URL heuristics
function looksLikePdfUrl(url) {
  try {
    const u = new URL(url);
    return /\.pdf($|\?)/i.test(u.pathname) || u.pathname.toLowerCase().includes('/pdf/');
  } catch (e) { return false; }
}

// extract paragraphs from PDF ArrayBuffer using pdf.js
async function extractParagraphsFromPdfArrayBuffer(arrayBuffer, pageLimit = 30) {
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  const totalPages = pdf.numPages;
  const pagesToRead = Math.min(totalPages, pageLimit);
  const paragraphs = [];
  for (let pageNum = 1; pageNum <= pagesToRead; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const txtContent = await page.getTextContent();
    const pageText = txtContent.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
    if (!pageText) continue;
    // naive splitting into paragraphs (tweak to suit your PDF layout)
    const chunks = pageText.split(/(?<=\.)\s+|\n{1,}/).map(s => s.trim()).filter(Boolean);
    for (const c of chunks) paragraphs.push({ index: paragraphs.length + 1, text: c });
  }
  return paragraphs;
}

async function summarizePdfUrl(url) {
  setStatus("Extracting PDF text...");
  try {
    const paragraphs = await extractParagraphsFromPdfUrl(url, 40);
    if (!paragraphs.length) { setStatus("No text extracted."); return; }
    setStatus("Summarizing PDF...");
    const prompt = buildParagraphPrompt(paragraphs);
    const modelText = await callGemini(prompt);
    const bullets = parseBulletsWithRefs(modelText);
    const resultObj = {
      sourceUrl: url,
      paragraphsCount: paragraphs.length,
      summaryText: modelText,
      bullets,
      paragraphs: paragraphs.slice(0,80).map(p=>({index:p.index, text:p.text.slice(0,300)}))
    };
    await renderAndPersistResult(resultObj);
    setStatus("");
    return await summarizeUrl(url);
  } catch (err) {
    console.error("PDF summarization failed", err);
    setStatus("❌ PDF extraction failed (CORS, paywall, or not fetchable). Try opening the PDF in tab and use 'Summarize current page'.");
  }
}

// Replace your existing findOnPage with this:
async function findOnPage(question) {
  setStatus("Extracting page text...");
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || !tabs[0]) return alert("No active tab found");
  const tab = tabs[0];
  const tabUrl = tab.url || "";

  // If user previously uploaded a PDF (or we have paragraphs in memory), use it first.
  // This keeps the AI flow intact but allows findOnPage to work for uploads.
  if (Array.isArray(currentParagraphs) && currentParagraphs.length) {
    setStatus("Using uploaded PDF content...");
    const userInstruction = `Answer the question: "${question}". Provide a concise answer and append which paragraph(s) support it like (¶3) or (¶5-6). If you quote, include the quoted sentence and the paragraph index.`;
    const prompt = buildParagraphPrompt(currentParagraphs, userInstruction);
    try {
      const modelText = await callGemini(prompt);
      const bullets = parseBulletsWithRefs(modelText);
      const resultObj = {
        sourceUrl: "uploaded-file",
        summaryText: modelText,
        bullets,
        paragraphs: currentParagraphs.map(p => ({ index: p.index, text: p.text }))
      };
      await showParagraphResult(resultObj);
      setStatus("");
      return;
    } catch (err) {
      console.error("AI search on uploaded PDF failed", err);
      setStatus("❌ AI search failed: " + (err.message || err));
      return;
    }
  }

  // Helper to show paragraph result (works with either renderResult or renderAndPersistResult)
  async function showParagraphResult(obj) {
    // prefer existing renderResult (paragraph-mode renderer) if present
    if (typeof renderResult === "function") {
      await renderResult(obj);
      return;
    }
    // else adapt to renderAndPersistResult shape (best-effort)
    if (typeof renderAndPersistResult === "function") {
      const links = (obj.paragraphs || []).slice(0, 20).map(p => ({ title: `¶${p.index}`, link: `${obj.sourceUrl}#p${p.index}`, snippet: p.text.slice(0,200) }));
      await renderAndPersistResult({ query: question, sites: [], summaryText: obj.summaryText || "", links });
      return;
    }
    // fallback: simple insertion into result area
    const r = getEl("result");
    if (r) r.innerText = obj.summaryText || "No renderer available";
  }

  // If tab URL looks like PDF -> fetch PDF via background and extract using pdf.js
  if (looksLikePdfUrl(tabUrl)) {
    setStatus("PDF detected — fetching PDF via background...");
    const pdfResp = await bgFetchPdfArrayBuffer(tabUrl);
    if (!pdfResp || !pdfResp.ok) {
      console.error("bgFetchPdfArrayBuffer failed:", pdfResp);
      setStatus("Could not fetch PDF: " + (pdfResp?.status || pdfResp?.error || "unknown"));
      return;
    }

    try {
      const paragraphs = await extractParagraphsFromPdfArrayBuffer(pdfResp.buffer, 60);
      if (!paragraphs || !paragraphs.length) { setStatus("No text extracted from PDF."); return; }

      setStatus("Searching PDF...");
      const userInstruction = `Answer the question: "${question}". Provide a concise answer and append which paragraph(s) support it like (¶3) or (¶5-6). If you quote, include the quoted sentence and the paragraph index.`;
      const prompt = buildParagraphPrompt(paragraphs, userInstruction);
      const modelText = await callGemini(prompt);
      const bullets = parseBulletsWithRefs(modelText);

      const resultObj = {
        sourceUrl: tabUrl,
        summaryText: modelText,
        bullets,
        paragraphs: paragraphs.map(p => ({ index: p.index, text: p.text }))
      };

      await showParagraphResult(resultObj);
      setStatus("");
    } catch (err) {
      console.error("PDF parse/find failed", err);
      setStatus("❌ PDF parse failed: " + (err.message || err));
    }
    return;
  }

  // Non-PDF: try content-script extraction first
  chrome.tabs.sendMessage(tab.id, { action: "extractParagraphs" }, async (resp) => {
    try {
      if (resp && resp.ok && Array.isArray(resp.paragraphs) && resp.paragraphs.length) {
        const paragraphs = resp.paragraphs;
        setStatus("Searching page...");
        const userInstruction = `Answer the question: "${question}". Provide a concise answer and append which paragraph(s) support it like (¶3).`;
        const prompt = buildParagraphPrompt(paragraphs, userInstruction);
        const modelText = await callGemini(prompt);
        const bullets = parseBulletsWithRefs(modelText);
        const resultObj = {
          sourceUrl: tabUrl,
          summaryText: modelText,
          bullets,
          paragraphs: paragraphs.map(p => ({ index: p.index, text: p.text }))
        };
        await showParagraphResult(resultObj);
        setStatus("");
        return;
      }

      // If content script extraction didn't work, try background fetch of page HTML (handles CORS via background)
      setStatus("Trying background fetch of page HTML...");
      const pageResp = await bgFetchText(tabUrl);
      if (!pageResp || !pageResp.ok) {
        console.error("bgFetchText failed:", pageResp);
        setStatus("Could not read page content (CORS or blocked). Try opening the page and use 'Summarize current page'.");
        return;
      }
      const parser = new DOMParser();
      const doc = parser.parseFromString(pageResp.text || "", "text/html");
      const root = doc.querySelector("article") || doc.querySelector("main") || doc.body;
      const ps = Array.from(root.querySelectorAll("p")).filter(p => p.textContent && p.textContent.trim().length > 30);
      const paragraphs = ps.map((p,i) => ({ index: i+1, text: p.textContent.trim().slice(0, 3000) }));
      if (!paragraphs.length) { setStatus("No paragraphs found in fetched HTML."); return; }

      setStatus("Searching...");
      const userInstruction = `Answer the question: "${question}". Provide a concise answer and append which paragraph(s) support it like (¶3).`;
      const prompt = buildParagraphPrompt(paragraphs, userInstruction);
      const modelText = await callGemini(prompt);
      const bullets = parseBulletsWithRefs(modelText);
      const resultObj = {
        sourceUrl: tabUrl,
        summaryText: modelText,
        bullets,
        paragraphs: paragraphs.map(p => ({ index: p.index, text: p.text }))
      };
      await showParagraphResult(resultObj);
      setStatus("");

    } catch (err) {
      console.error("findOnPage inner error", err);
      setStatus("❌ Error: " + (err.message || err));
    }
  });
}

// Expose a couple helpers globally to ease debugging if needed
window._extensionHelpers = { performSearch, summarizeCurrentTab, summarizeUrl, findOnPage, summarizePdfUrl };
