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

// ---- fetch with retries ----
async function fetchHTML(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: 15000,
      });
      return response.data;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// ---- resolve slug from URL or search ----
async function resolveMangaSlug(query) {
  // Direct URL: /title/ID-slug or /manga/...
  const urlMatch = query.match(/comix\.to\/(?:title|manga)\/([^\/?#]+)/i);
  if (urlMatch) return urlMatch[1];

  // If it looks like a slug already (no spaces, no http)
  if (!query.includes(' ') && !query.includes('http')) return query;

  // Otherwise, try search (but comix.to search might be tricky)
  // We'll fallback to treating as title and try to find via search page
  const searchUrl = `${BASE_URL}/search?q=${encodeURIComponent(query)}`;
  const html = await fetchHTML(searchUrl);
  const $ = cheerio.load(html);
  // Common search result selectors
  const firstResult = $('.manga-item a, .search-result a, .manga-poster a, .series-item a').first();
  if (firstResult.length) {
    const href = firstResult.attr('href');
    const slugMatch = href.match(/\/(?:title|manga)\/([^\/?#]+)/);
    if (slugMatch) return slugMatch[1];
  }
  throw new Error('Manga not found. Please provide a full comix.to URL or a valid manga slug.');
}

// ---- get manga info and chapters ----
async function getMangaData(slug) {
  // Try both /title/ and /manga/ patterns
  let html;
  let url;
  try {
    url = `${BASE_URL}/title/${slug}`;
    html = await fetchHTML(url);
  } catch (e) {
    // fallback to /manga/
    url = `${BASE_URL}/manga/${slug}`;
    html = await fetchHTML(url);
  }

  const $ = cheerio.load(html);

  // ---- Title ----
  let title = $('h1.series-title, h1.manga-title, .series-name, .manga-name, h1').first().text().trim();
  if (!title) title = slug;

  // ---- Poster ----
  let poster = $('.series-cover img, .manga-poster img, .cover img, .manga-cover img, .thumbnail img').first().attr('src');
  if (poster && !poster.startsWith('http')) poster = `${BASE_URL}${poster}`;

  // ---- Description ----
  const desc = $('.series-description, .manga-description, .description, .summary, .synopsis').first().text().trim();

  // ---- Metadata (author, status, genres) ----
  let author = '', status = '', genres = [];
  const metaText = $('.series-info, .manga-info, .info, .metadata').text();
  const lines = metaText.split('\n').map(s => s.trim()).filter(Boolean);
  lines.forEach(line => {
    const l = line.toLowerCase();
    if (l.includes('author') || l.includes('creator')) author = line.replace(/author|creator/i, '').trim();
    if (l.includes('status')) status = line.replace(/status/i, '').trim();
    if (l.includes('genre') || l.includes('categories')) {
      genres = line.replace(/genre|categories/i, '').split(',').map(s => s.trim());
    }
  });

  // ---- Chapters ----
  const chapters = [];
  // Try common chapter list selectors
  const chapterSelectors = [
    '.chapter-list a',
    '.chapters a',
    '.wp-manga-chapter a',
    '.chapter-item a',
    '.series-chapters a',
    '.chapter-link'
  ];
  let found = false;
  for (const selector of chapterSelectors) {
    const els = $(selector);
    if (els.length) {
      els.each((i, el) => {
        const link = $(el);
        const href = link.attr('href');
        const text = link.text().trim();
        let num = parseFloat(text.match(/(\d+\.?\d*)/)?.[0]) || i + 1;
        if (isNaN(num)) num = i + 1;
        const titleText = text || `Chapter ${num}`;
        if (href) {
          const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
          chapters.push({ num, title: titleText, url: fullUrl });
        }
      });
      if (chapters.length) { found = true; break; }
    }
  }

  // If still empty, try any link containing "chapter"
  if (!found) {
    $('a[href*="chapter"]').each((i, el) => {
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
  }

  // Remove duplicates (by URL)
  const unique = [];
  const seen = new Set();
  for (const ch of chapters) {
    if (!seen.has(ch.url)) {
      seen.add(ch.url);
      unique.push(ch);
    }
  }
  chapters.length = 0;
  chapters.push(...unique);

  // Sort by number
  chapters.sort((a, b) => a.num - b.num);

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

// ---- get images from a chapter page ----
async function getChapterImages(chapterUrl) {
  const html = await fetchHTML(chapterUrl);
  const $ = cheerio.load(html);
  const images = [];

  // Common image container selectors
  const selectors = [
    '.chapter-images img',
    '.reader-area img',
    '.page-img img',
    '.reading-content img',
    '.chapter-content img',
    '.comic-page img',
    '.page-image img',
    '.image-container img'
  ];

  for (const selector of selectors) {
    $(selector).each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
      if (src) {
        let full = src.startsWith('http') ? src : `${BASE_URL}${src}`;
        // Sometimes images have relative paths starting with //
        if (full.startsWith('//')) full = 'https:' + full;
        if (!images.includes(full)) images.push(full);
      }
    });
    if (images.length) break;
  }

  // Fallback: any img with src containing "chapter" or "page"
  if (!images.length) {
    $('img[src*="chapter"], img[src*="page"], img[data-src*="chapter"], img[data-src*="page"]').each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
      if (src) {
        let full = src.startsWith('http') ? src : `${BASE_URL}${src}`;
        if (full.startsWith('//')) full = 'https:' + full;
        if (!images.includes(full)) images.push(full);
      }
    });
  }

  // If still empty, try getting all images inside the main content area
  if (!images.length) {
    $('.content-area img, .main img, .reader img').each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src) {
        let full = src.startsWith('http') ? src : `${BASE_URL}${src}`;
        if (full.startsWith('//')) full = 'https:' + full;
        if (!images.includes(full)) images.push(full);
      }
    });
  }

  // Filter out tiny icons, ads, etc. (simple heuristic: width/height > 100)
  // We'll just trust the selectors for now.

  return images;
}

// ---- create CBZ stream ----
async function createCBZStream(imageUrls, chapterName) {
  const archiver = require('archiver');
  const archive = archiver('zip', { zlib: { level: 9 } });
  const pass = new stream.PassThrough();
  archive.pipe(pass);

  let index = 1;
  const pad = String(imageUrls.length).length;
  for (const url of imageUrls) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': USER_AGENT },
        timeout: 10000,
      });
      const ext = url.split('.').pop().split('?')[0] || 'jpg';
      const filename = `${String(index).padStart(pad, '0')}.${ext}`;
      archive.append(response.data, { name: filename });
      index++;
    } catch (err) {
      console.warn(`Failed to download image: ${url}`, err.message);
    }
  }

  archive.finalize();
  return pass;
}

// ---- API ----
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  try {
    const slug = await resolveMangaSlug(query);
    const data = await getMangaData(slug);
    res.json({ success: true, manga: data, chapters: data.chapters });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch manga' });
  }
});

app.get('/api/download', async (req, res) => {
  const { manga, chapter, url, title } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing chapter URL' });

  try {
    const images = await getChapterImages(url);
    if (!images.length) {
      return res.status(404).json({ error: 'No images found for this chapter' });
    }

    const zipStream = await createCBZStream(images, title || `Chapter ${chapter}`);
    const fileName = `${manga || 'manga'} - ch.${chapter}.cbz`;
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Content-Type', 'application/zip');

    await pipeline(zipStream, res);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/download-multiple', async (req, res) => {
  const { manga, chapters } = req.body;
  if (!chapters || !chapters.length) {
    return res.status(400).json({ error: 'No chapters provided' });
  }

  try {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const pass = new stream.PassThrough();
    archive.pipe(pass);

    let totalImages = 0;
    for (const ch of chapters) {
      const images = await getChapterImages(ch.url);
      if (!images.length) continue;
      const prefix = `ch.${ch.num}/`;
      let idx = 1;
      const pad = String(images.length).length;
      for (const imgUrl of images) {
        try {
          const response = await axios.get(imgUrl, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': USER_AGENT },
            timeout: 10000,
          });
          const ext = imgUrl.split('.').pop().split('?')[0] || 'jpg';
          const filename = `${prefix}${String(idx).padStart(pad, '0')}.${ext}`;
          archive.append(response.data, { name: filename });
          idx++;
          totalImages++;
        } catch (err) {
          console.warn(`Failed to download ${imgUrl}:`, err.message);
        }
      }
    }

    if (totalImages === 0) {
      return res.status(404).json({ error: 'No images could be fetched from any chapter' });
    }

    archive.finalize();

    const range = chapters.length === 1 ? `ch.${chapters[0].num}` :
      `ch.${chapters[0].num}-${chapters[chapters.length-1].num}`;
    const fileName = `${manga || 'manga'} - ${range}.cbz`;
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Content-Type', 'application/zip');

    await pipeline(pass, res);
  } catch (err) {
    console.error('Multi-download error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
