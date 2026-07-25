const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const archiver = require('archiver');
const stream = require('stream');
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);

const app = express();
app.use(express.json());

// ---------- Serve frontend HTML directly (no public folder needed) ----------
const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>MangaScraper — comix.to</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" />
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:'Inter',sans-serif; background:#0b0e14; color:#e8edf5; min-height:100vh; display:flex; justify-content:center; padding:2rem 1rem; }
.app { max-width:1100px; width:100%; background:rgba(18,24,34,0.75); backdrop-filter:blur(10px); border-radius:2rem; padding:2rem; box-shadow:0 20px 60px rgba(0,0,0,0.7); border:1px solid rgba(255,255,255,0.03); }
h1 { font-weight:600; font-size:1.9rem; display:flex; align-items:center; gap:0.6rem; margin-bottom:0.25rem; }
h1 i { color:#5b7cfa; }
.sub { color:#8896b0; font-size:0.9rem; margin-bottom:2rem; border-left:3px solid #2a3a5a; padding-left:1rem; }
.search-section { display:flex; gap:0.75rem; flex-wrap:wrap; margin-bottom:2.2rem; }
.search-section input { flex:1; min-width:200px; padding:0.85rem 1.2rem; border-radius:60px; border:1px solid #28303f; background:#131b26; color:#e8edf5; font-size:1rem; outline:none; }
.search-section input:focus { border-color:#5b7cfa; box-shadow:0 0 0 3px rgba(91,124,250,0.25); }
.btn { padding:0.85rem 1.8rem; border:none; border-radius:60px; font-weight:600; font-size:0.95rem; cursor:pointer; display:inline-flex; align-items:center; gap:0.6rem; transition:background 0.2s,transform 0.1s,box-shadow 0.25s; background:#2a3a5a; color:#d6e0f0; border:1px solid transparent; }
.btn-primary { background:#5b7cfa; color:#fff; border-color:#5b7cfa; }
.btn-primary:hover { background:#4a6ae6; box-shadow:0 8px 24px rgba(91,124,250,0.35); transform:scale(1.02); }
.btn-secondary { background:#1f293d; color:#bcc9e0; border-color:#2d3a52; }
.btn-secondary:hover { background:#2a3a5a; border-color:#3f5270; transform:scale(1.02); }
.btn-success { background:#2b8f6c; color:#fff; border-color:#2b8f6c; }
.btn-success:hover { background:#237a5b; box-shadow:0 8px 24px rgba(43,143,108,0.35); transform:scale(1.02); }
.btn-danger { background:#b13e4b; color:#fff; }
.btn-danger:hover { background:#9a3440; transform:scale(1.02); }
.btn:disabled { opacity:0.5; cursor:not-allowed; transform:none !important; }
.manga-header { display:flex; gap:1.8rem; align-items:flex-start; margin-bottom:2.5rem; background:rgba(10,14,22,0.5); border-radius:1.5rem; padding:1.5rem; flex-wrap:wrap; }
.manga-poster { flex-shrink:0; width:140px; height:200px; border-radius:12px; object-fit:cover; background:#141c28; border:1px solid #28303f; }
.manga-details { flex:1; min-width:180px; }
.manga-details h2 { font-size:1.8rem; font-weight:600; margin-bottom:0.3rem; }
.manga-details .meta { color:#8896b0; font-size:0.9rem; display:flex; flex-wrap:wrap; gap:0.5rem 1.2rem; margin-top:0.4rem; }
.manga-details .meta span { background:#141c28; padding:0.2rem 0.8rem; border-radius:40px; border:1px solid #1f293d; font-size:0.8rem; }
.manga-details .desc { margin-top:0.8rem; color:#b0bed6; font-size:0.95rem; line-height:1.5; max-height:4.2em; overflow:hidden; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; }
.chapter-controls { display:flex; flex-wrap:wrap; gap:0.75rem; align-items:center; justify-content:space-between; margin-bottom:1.2rem; padding-bottom:0.8rem; border-bottom:1px solid #1a2330; }
.chapter-controls .left { display:flex; flex-wrap:wrap; gap:0.75rem; align-items:center; }
.chapter-controls .right { display:flex; gap:0.75rem; align-items:center; }
.chapter-count { font-size:0.9rem; color:#8896b0; }
.chapter-count strong { color:#d6e0f0; }
.chapter-list { display:flex; flex-direction:column; gap:0.4rem; max-height:520px; overflow-y:auto; padding-right:0.25rem; }
.chapter-list::-webkit-scrollbar { width:5px; }
.chapter-list::-webkit-scrollbar-track { background:#0e141c; border-radius:10px; }
.chapter-list::-webkit-scrollbar-thumb { background:#2a3a5a; border-radius:10px; }
.chapter-row { display:flex; align-items:center; gap:0.8rem; padding:0.6rem 1rem 0.6rem 0.8rem; background:rgba(20,28,40,0.5); border-radius:12px; border:1px solid transparent; transition:background 0.2s; }
.chapter-row:hover { background:rgba(30,42,60,0.6); border-color:#2a3a5a; }
.chapter-row .ch-check { flex-shrink:0; width:18px; height:18px; accent-color:#5b7cfa; cursor:pointer; transform:scale(1.1); }
.chapter-row .ch-num { font-weight:600; min-width:70px; color:#d6e0f0; font-size:0.95rem; }
.chapter-row .ch-title { flex:1; color:#b0bed6; font-size:0.92rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.chapter-row .ch-pages { flex-shrink:0; color:#5a6a82; font-size:0.8rem; margin-right:0.2rem; background:#0e141c; padding:0.15rem 0.7rem; border-radius:30px; border:1px solid #1a2330; }
.chapter-row .ch-size { flex-shrink:0; color:#6a7a92; font-size:0.8rem; min-width:60px; text-align:right; }
.chapter-row .ch-dl-btn { flex-shrink:0; padding:0.35rem 1rem; border-radius:40px; border:none; font-size:0.8rem; font-weight:600; background:#1f293d; color:#bcc9e0; cursor:pointer; transition:background 0.2s,transform 0.1s; border:1px solid transparent; display:inline-flex; align-items:center; gap:0.4rem; }
.chapter-row .ch-dl-btn:hover { background:#2b3f5f; border-color:#3f5270; transform:scale(1.04); color:#fff; }
.chapter-row .ch-dl-btn:active { transform:scale(0.95); }
.chapter-row .ch-dl-btn.downloading { opacity:0.6; pointer-events:none; }
.status { text-align:center; padding:3rem 1rem; color:#5a6a82; }
.status i { font-size:2.8rem; margin-bottom:0.8rem; display:block; color:#2a3a5a; }
.toast { position:fixed; bottom:2rem; left:50%; transform:translateX(-50%); background:#1a2330; color:#d6e0f0; padding:0.8rem 2rem; border-radius:60px; border:1px solid #2a3a5a; box-shadow:0 8px 32px rgba(0,0,0,0.6); font-size:0.9rem; z-index:999; opacity:0; transition:opacity 0.3s; pointer-events:none; backdrop-filter:blur(8px); }
.toast.show { opacity:1; }
.toast.success { border-color:#2b8f6c; color:#8fdfc0; }
.toast.error { border-color:#b13e4b; color:#f0a0aa; }
.spinner { display:inline-block; width:18px; height:18px; border:2px solid rgba(255,255,255,0.15); border-top-color:#5b7cfa; border-radius:50%; animation:spin 0.7s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
@media (max-width:700px) { .app { padding:1.2rem; } .manga-header { flex-direction:column; align-items:center; text-align:center; } .manga-poster { width:120px; height:170px; } .chapter-row { flex-wrap:wrap; } .chapter-row .ch-title { flex-basis:100%; order:3; } .chapter-controls { flex-direction:column; } }
</style>
</head>
<body>
<div class="app">
  <h1><i class="fas fa-book-open"></i> MangaScraper</h1>
  <div class="sub"><i class="fas fa-chevron-right" style="font-size:0.6rem;margin-right:0.5rem;color:#5b7cfa;"></i> comix.to · download chapters as CBZ</div>
  <div class="search-section">
    <input type="text" id="searchInput" placeholder="Manga name or comix.to URL …" />
    <button class="btn btn-primary" id="searchBtn"><i class="fas fa-search"></i> Fetch</button>
    <button class="btn btn-secondary" id="clearBtn"><i class="fas fa-undo-alt"></i> Clear</button>
  </div>
  <div id="mangaHeader" style="display:none;">
    <div class="manga-header">
      <img id="mangaPoster" class="manga-poster" src="" alt="poster" />
      <div class="manga-details">
        <h2 id="mangaTitle">—</h2>
        <div class="meta" id="mangaMeta"></div>
        <div class="desc" id="mangaDesc"></div>
      </div>
    </div>
  </div>
  <div id="chapterControls" style="display:none;">
    <div class="chapter-controls">
      <div class="left">
        <button class="btn btn-secondary" id="selectAllBtn"><i class="fas fa-check-double"></i> All</button>
        <button class="btn btn-secondary" id="deselectAllBtn"><i class="fas fa-times"></i> None</button>
        <span class="chapter-count" id="chapterCount">0 chapters</span>
      </div>
      <div class="right">
        <button class="btn btn-success" id="downloadSelectedBtn"><i class="fas fa-download"></i> Download Selected</button>
      </div>
    </div>
  </div>
  <div id="chapterListContainer">
    <div class="status" id="emptyState"><i class="fas fa-search"></i><p>Enter a manga name or URL to get started.</p></div>
    <div class="chapter-list" id="chapterList" style="display:none;"></div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const API_BASE = '';
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const clearBtn = document.getElementById('clearBtn');
const mangaHeader = document.getElementById('mangaHeader');
const mangaPoster = document.getElementById('mangaPoster');
const mangaTitle = document.getElementById('mangaTitle');
const mangaMeta = document.getElementById('mangaMeta');
const mangaDesc = document.getElementById('mangaDesc');
const chapterControls = document.getElementById('chapterControls');
const chapterList = document.getElementById('chapterList');
const emptyState = document.getElementById('emptyState');
const chapterCount = document.getElementById('chapterCount');
const selectAllBtn = document.getElementById('selectAllBtn');
const deselectAllBtn = document.getElementById('deselectAllBtn');
const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
const toast = document.getElementById('toast');

let currentChapters = [];
let currentManga = null;
let toastTimer = null;

function showToast(msg, type='info') {
  if (toastTimer) clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.className = 'toast show ' + type;
  toastTimer = setTimeout(() => toast.classList.remove('show'), 4000);
}

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}

function renderChapters(chapters, mangaTitle) {
  currentChapters = chapters;
  if (!chapters || !chapters.length) {
    chapterList.style.display = 'none';
    emptyState.style.display = 'block';
    emptyState.innerHTML = '<i class="fas fa-exclamation-circle"></i><p>No chapters found.</p>';
    chapterControls.style.display = 'none';
    return;
  }
  emptyState.style.display = 'none';
  chapterList.style.display = 'flex';
  chapterControls.style.display = 'block';
  chapterCount.innerHTML = '<strong>'+chapters.length+'</strong> chapters';

  let html = '';
  chapters.forEach((ch, idx) => {
    const checked = ch.selected ? 'checked' : '';
    const sizeStr = ch.size ? formatSize(ch.size) : '—';
    const pagesStr = ch.pages ? ch.pages+'p' : '—';
    html += \`
      <div class="chapter-row" data-index="\${idx}">
        <input type="checkbox" class="ch-check" data-idx="\${idx}" \${checked} />
        <span class="ch-num">ch.\${ch.num}</span>
        <span class="ch-title" title="\${ch.title}">\${ch.title}</span>
        <span class="ch-pages">\${pagesStr}</span>
        <span class="ch-size">\${sizeStr}</span>
        <button class="ch-dl-btn" data-idx="\${idx}"><i class="fas fa-download"></i> DL</button>
      </div>
    \`;
  });
  chapterList.innerHTML = html;

  chapterList.querySelectorAll('.ch-check').forEach(el => {
    el.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      if (!isNaN(idx) && currentChapters[idx]) currentChapters[idx].selected = e.target.checked;
    });
  });
  chapterList.querySelectorAll('.ch-dl-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      const idx = parseInt(el.dataset.idx);
      if (!isNaN(idx) && currentChapters[idx]) downloadSingle(idx);
    });
  });
}

async function fetchManga(query) {
  const btn = searchBtn;
  const orig = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> Loading…';
  btn.disabled = true;
  try {
    const resp = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query.trim() })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || 'Server error ('+resp.status+')');
    }
    const data = await resp.json();
    if (!data.success) throw new Error(data.error || 'Unknown error');

    currentManga = data.manga;
    mangaTitle.textContent = data.manga.title || 'Unknown';
    if (data.manga.poster) {
      mangaPoster.src = data.manga.poster;
      mangaPoster.style.display = 'block';
    } else {
      mangaPoster.style.display = 'none';
    }
    const metaParts = [];
    if (data.manga.author) metaParts.push('✍️ '+data.manga.author);
    if (data.manga.status) metaParts.push('📌 '+data.manga.status);
    if (data.manga.genres && data.manga.genres.length) {
      metaParts.push('🏷️ '+data.manga.genres.slice(0,4).join(', '));
    }
    mangaMeta.innerHTML = metaParts.length ? metaParts.join(' · ') : '';
    mangaDesc.textContent = data.manga.description || '';
    mangaHeader.style.display = 'block';

    const chapters = data.chapters.map((ch, i) => ({ ...ch, selected: false, size: ch.size || 0, pages: ch.pages || 0 }));
    renderChapters(chapters, data.manga.title);
    showToast('✅ Loaded '+chapters.length+' chapters for "'+data.manga.title+'"', 'success');
  } catch (err) {
    showToast('❌ '+err.message, 'error');
    console.error(err);
  } finally {
    btn.innerHTML = orig;
    btn.disabled = false;
  }
}

async function downloadSingle(idx) {
  const ch = currentChapters[idx];
  if (!ch) return;
  const btn = chapterList.querySelector('.ch-dl-btn[data-idx="'+idx+'"]');
  if (!btn) return;
  const orig = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span>';
  btn.disabled = true;
  btn.classList.add('downloading');
  try {
    const params = new URLSearchParams();
    params.set('manga', currentManga?.title || 'Unknown');
    params.set('chapter', ch.num);
    params.set('url', ch.url);
    params.set('title', ch.title);
    const a = document.createElement('a');
    a.href = '/api/download?'+params.toString();
    a.download = (currentManga?.title || 'manga')+' - ch.'+ch.num+'.cbz';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('⬇️ Downloading ch.'+ch.num+' …', 'info');
  } catch (err) {
    showToast('❌ Download failed: '+err.message, 'error');
  } finally {
    btn.innerHTML = orig;
    btn.disabled = false;
    btn.classList.remove('downloading');
  }
}

async function downloadSelected() {
  const selected = currentChapters.filter(ch => ch.selected);
  if (!selected.length) { showToast('⚠️ No chapters selected.', 'error'); return; }
  const btn = downloadSelectedBtn;
  const orig = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> Preparing…';
  btn.disabled = true;
  try {
    const resp = await fetch('/api/download-multiple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manga: currentManga?.title || 'Unknown',
        chapters: selected.map(ch => ({ num: ch.num, url: ch.url, title: ch.title || 'Chapter '+ch.num }))
      })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || 'Server error ('+resp.status+')');
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const range = selected.length === 1 ? 'ch.'+selected[0].num : 'ch.'+selected[0].num+'-'+selected[selected.length-1].num;
    a.download = (currentManga?.title || 'manga')+' - '+range+'.cbz';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('⬇️ Downloading '+selected.length+' chapters …', 'success');
    currentChapters.forEach(ch => ch.selected = false);
    renderChapters(currentChapters, currentManga?.title);
  } catch (err) {
    showToast('❌ '+err.message, 'error');
  } finally {
    btn.innerHTML = orig;
    btn.disabled = false;
  }
}

function selectAll(checked) {
  currentChapters.forEach(ch => ch.selected = checked);
  renderChapters(currentChapters, currentManga?.title);
}

function clearAll() {
  currentChapters = [];
  currentManga = null;
  mangaHeader.style.display = 'none';
  chapterControls.style.display = 'none';
  chapterList.style.display = 'none';
  emptyState.style.display = 'block';
  emptyState.innerHTML = '<i class="fas fa-search"></i><p>Enter a manga name or URL to get started.</p>';
  searchInput.value = '';
  showToast('🧹 Cleared', 'info');
}

searchBtn.addEventListener('click', () => {
  const val = searchInput.value.trim();
  if (!val) { showToast('⚠️ Please enter a manga name or URL.', 'error'); return; }
  fetchManga(val);
});
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchBtn.click(); });
clearBtn.addEventListener('click', clearAll);
selectAllBtn.addEventListener('click', () => selectAll(true));
deselectAllBtn.addEventListener('click', () => selectAll(false));
downloadSelectedBtn.addEventListener('click', downloadSelected);
clearAll();
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(FRONTEND_HTML));

// ---------- LOGGING middleware ----------
app.use((req, res, next) => {
  console.log(`📨 ${req.method} ${req.url}`);
  next();
});

// ---------- TEST endpoint ----------
app.get('/api/test', (req, res) => {
  console.log('✅ Test endpoint hit');
  res.json({ status: 'ok', message: 'Backend is alive!' });
});

// ---------- DEBUG endpoint (fetch raw HTML) ----------
app.get('/api/debug', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url param' });
  try {
    const html = await fetchHTML(url);
    res.send(html);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Core scraping functions ----------
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';
const BASE_URL = 'https://comix.to';

async function fetchHTML(url, retries = 3) {
  console.log(`🌐 Fetching: ${url}`);
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: 20000,
      });
      console.log(`✅ Fetched ${url} (${response.data.length} bytes)`);
      return response.data;
    } catch (err) {
      console.warn(`⚠️ Attempt ${i+1} failed: ${err.message}`);
      if (i === retries - 1) throw new Error(`Failed to fetch ${url}: ${err.message}`);
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

async function fetchJSON(url) {
  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15000,
    });
    return response.data;
  } catch (e) {
    console.warn(`⚠️ JSON fetch failed: ${url}`, e.message);
    return null;
  }
}

async function resolveSlug(query) {
  const urlMatch = query.match(/comix\.to\/(?:title|manga)\/([^\/?#]+)/i);
  if (urlMatch) {
    console.log(`🔗 Extracted slug from URL: ${urlMatch[1]}`);
    return urlMatch[1];
  }
  if (!query.includes(' ') && !query.includes('http')) {
    console.log(`🔗 Using direct slug: ${query}`);
    return query;
  }
  // search fallback
  try {
    const html = await fetchHTML(`${BASE_URL}/search?q=${encodeURIComponent(query)}
