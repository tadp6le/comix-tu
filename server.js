const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const archiver = require('archiver');
const stream = require('stream');
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);

const app = express();
app.use(express.json());
app.use(express.static('public'));

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';
const BASE_URL = 'https://comix.to';

// ---------- fetch with retries ----------
async function fetchHTML(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: 20000,
      });
      return response.data;
    } catch (err) {
      if (i === retries - 1) throw new Error(`Failed: ${err.message}`);
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

// ---------- resolve slug from URL or search ----------
async function resolveSlug(query) {
  const urlMatch = query.match(/comix\.to\/(?:title|manga)\/([^\/?#]+)/i);
  if (urlMatch) return urlMatch[1];
  if (!query.includes(' ') && !query.includes('http')) return query;
  // search fallback
  try {
    const html = await fetchHTML(`${BASE_URL}/search?q=${encodeURIComponent(query)}`);
    const $ = cheerio.load(html);
    const first = $('.manga-item a, .search-result a, .manga-poster a, .series-item a').first();
    if (first.length) {
      const href = first.attr('href');
      const m = href.match(/\/(?:title|manga)\/([^\/?#]+)/);
      if (m) return m[1];
    }
  } catch (e) {}
  throw new Error('Could not resolve manga. Please provide the full comix.to URL.');
}

// ---------- get manga info & chapters ----------
async function getMangaData(slug) {
  let html, url;
  try {
    url = `${BASE_URL}/title/${slug}`;
    html = await fetchHTML(url);
  } catch {
    url = `${BASE_URL}/manga/${slug}`;
    html = await fetchHTML(url);
  }

  const $ = cheerio.load(html);
  console.log(`📄 Page title: ${$('title').text()}`);

  // ---- JSON-LD ----
  let json = null;
  $('script[type="application/ld+json"]').each((i, el) => {
    try { json = JSON.parse($(el).html()); } catch (e) {}
  });

  // ---- Title ----
  const title = json?.name || $('h1.series-title, h1.manga-title, .series-name, .manga-name, h1').first().text().trim()
    || $('meta[property="og:title"]').attr('content') || slug;

  // ---- Poster ----
  let poster = json?.image || $('.series-cover img, .manga-poster img, .cover img, .manga-cover img, .thumbnail img').first().attr('src');
  if (!poster) poster = $('meta[property="og:image"]').attr('content');
  if (poster && !poster.startsWith('http')) {
    poster = poster.startsWith('//') ? 'https:' + poster : `${BASE_URL}${poster}`;
  }

  // ---- Description ----
  const desc = json?.description || $('.series-description, .manga-description, .description, .summary, .synopsis').first().text().trim()
    || $('meta[property="og:description"]').attr('content') || '';

  // ---- Author, status, genres ----
  let author = json?.author?.name || '', status = '', genres = [];
  $('.series-info, .manga-info, .info, .metadata').each((i, el) => {
    const text = $(el).text();
    text.split('\n').map(s => s.trim()).filter(Boolean).forEach(line => {
      const l = line.toLowerCase();
      if (l.includes('author') || l.includes('creator')) author = line.replace(/author|creator/i, '').trim();
      if (l.includes('status')) status = line.replace(/status/i, '').trim();
      if (l.includes('genre') || l.includes('categories')) {
        genres = line.replace(/genre|categories/i, '').split(',').map(s => s.trim());
      }
    });
  });

  // ---- CHAPTERS – ALL POSSIBLE SELECTORS ----
  const chapters = [];
  const chapterSelectors = [
    '.chapter-list a',
    '.chapters a',
    '.wp-manga-chapter a',
    '.chapter-item a',
    '.series-chapters a',
    '.chapter-link',
    'a[href*="/chapter/"]',
    'a[href*="chapter-"]',
    '.list-chapter a',
    '.chapter-container a',
    '.chapters-list a',
    '.episode-list a',
    '.volume-list a[href*="chapter"]',
    '.manga-chapters a',
    '.chapter a'
  ];

  for (const sel of chapterSelectors) {
    const els = $(sel);
    if (els.length) {
      els.each((i, el) => {
        const link = $(el);
        const href = link.attr('href');
        const text = link.text().trim();
        if (href && !href.includes('#') && !href.includes('javascript')) {
          let num = parseFloat(text.match(/(\d+\.?\d*)/)?.[0]) || i + 1;
          if (isNaN(num)) num = i + 1;
          const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
          chapters.push({ num, title: text || `Chapter ${num}`, url: fullUrl });
        }
      });
      if (chapters.length) break;
    }
  }

  // Fallback: any link containing "chapter" in text
  if (!chapters.length) {
    $('a').each((i, el) => {
      const link = $(el);
      const href = link.attr('href');
      const text = link.text().toLowerCase();
      if (href && text.includes('chapter') && !href.includes('#')) {
        const num = parseFloat(text.match(/(\d+\.?\d*)/)?.[0]) || i + 1;
        const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
        chapters.push({ num, title: link.text().trim() || `Chapter ${num}`, url: fullUrl });
      }
    });
  }

  // Deduplicate by URL
  const seen = new Set();
  const unique = [];
  for (const ch of chapters) {
    if (!seen.has(ch.url)) {
      seen.add(ch.url);
      unique.push(ch);
    }
  }
  chapters.length = 0;
  chapters.push(...unique);
  chapters.sort((a, b) => a.num - b.num);

  console.log(`📚 Found ${chapters.length} chapters`);
  return {
    title,
    poster,
    description: desc,
    author,
    status,
    genres,
    chapters: chapters.map(ch => ({ ...ch, pages: 0, size: 0 }))
  };
}

// ---------- get chapter images – ALL selectors ----------
async function getChapterImages(chapterUrl) {
  const html = await fetchHTML(chapterUrl);
  const $ = cheerio.load(html);
  const images = [];

  const imgSelectors = [
    '.chapter-images img',
    '.reader-area img',
    '.page-img img',
    '.reading-content img',
    '.chapter-content img',
    '.comic-page img',
    '.page-image img',
    '.image-container img',
    '.chapter-body img',
    '.main-content img',
    '.reader img',
    '.viewer img',
    '.comic-reader img',
    '.content-area img',
    '.chapter-content img',
    '.page img',
    '.manga-page img',
    '.comic-page img',
    '.page-container img',
    'img[src*="chapter"]',
    'img[data-src*="chapter"]',
    'img[data-lazy-src*="chapter"]'
  ];

  for (const sel of imgSelectors) {
    $(sel).each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || $(el).attr('data-original');
      if (src) {
        let full = src;
        if (!full.startsWith('http')) {
          full = full.startsWith('//') ? 'https:' + full : `${BASE_URL}${full}`;
        }
        if (!images.includes(full)) images.push(full);
      }
    });
    if (images.length) break;
  }

  // Last resort: any image with width/height > 100
  if (!images.length) {
    $('img').each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src) {
        const w = parseInt($(el).attr('width')) || 0;
        const h = parseInt($(el).attr('height')) || 0;
        if (w > 100 || h > 100 || (w === 0 && h === 0)) {
          let full = src.startsWith('http') ? src : `${BASE_URL}${src}`;
          if (full.startsWith('//')) full = 'https:' + full;
          if (!images.includes(full) && !src.includes('avatar') && !src.includes('logo') && !src.includes('icon')) {
            images.push(full);
          }
        }
      }
    });
  }

  console.log(`🖼️ Found ${images.length} images for ${chapterUrl}`);
  return images;
}

// ---------- create CBZ stream ----------
async function createCBZStream(imageUrls) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const pass = new stream.PassThrough();
  archive.pipe(pass);

  let idx = 1;
  const pad = String(imageUrls.length).length;
  for (const url of imageUrls) {
    try {
      const resp = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': USER_AGENT },
        timeout: 15000,
      });
      const ext = url.split('.').pop().split('?')[0] || 'jpg';
      archive.append(resp.data, { name: `${String(idx).padStart(pad, '0')}.${ext}` });
      idx++;
    } catch (e) { console.warn('Image download failed:', url, e.message); }
  }
  archive.finalize();
  return pass;
}

// ---------- API routes ----------
app.get('/api/test', (req, res) => res.json({ status: 'ok' }));

app.get('/api/debug', async (req, res) => {
  try {
    const html = await fetchHTML(req.query.url);
    res.send(html);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });
  try {
    const slug = await resolveSlug(query);
    const data = await getMangaData(slug);
    res.json({ success: true, manga: data, chapters: data.chapters });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/download', async (req, res) => {
  const { manga, chapter, url, title } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing URL' });
  try {
    const images = await getChapterImages(url);
    if (!images.length) return res.status(404).json({ error: 'No images' });
    const zip = await createCBZStream(images);
    const name = `${manga || 'manga'} - ch.${chapter}.cbz`;
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    res.setHeader('Content-Type', 'application/zip');
    await pipeline(zip, res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/download-multiple', async (req, res) => {
  const { manga, chapters } = req.body;
  if (!chapters?.length) return res.status(400).json({ error: 'No chapters' });
  try {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const pass = new stream.PassThrough();
    archive.pipe(pass);
    let total = 0;
    for (const ch of chapters) {
      const imgs = await getChapterImages(ch.url);
      if (!imgs.length) continue;
      const prefix = `ch.${ch.num}/`;
      let idx = 1;
      const pad = String(imgs.length).length;
      for (const url of imgs) {
        try {
          const resp = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': USER_AGENT },
            timeout: 15000,
          });
          const ext = url.split('.').pop().split('?')[0] || 'jpg';
          archive.append(resp.data, { name: `${prefix}${String(idx).padStart(pad, '0')}.${ext}` });
          idx++;
          total++;
        } catch (e) {}
      }
    }
    if (!total) return res.status(404).json({ error: 'No images' });
    archive.finalize();
    const range = chapters.length === 1 ? `ch.${chapters[0].num}` : `ch.${chapters[0].num}-${chapters[chapters.length-1].num}`;
    const name = `${manga || 'manga'} - ${range}.cbz`;
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    res.setHeader('Content-Type', 'application/zip');
    await pipeline(pass, res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
