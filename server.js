const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const archiver = require('archiver');
const stream = require('stream');
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);

const app = express();
app.use(express.json());
app.use(express.static('public')); // serve frontend

// ----- configuration -----
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';
const BASE_URL = 'https://comix.to';

// ----- helper: fetch HTML with retry -----
async function fetchHTML(url, retries = 2) {
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

// ----- extract manga slug from URL or search -----
async function resolveMangaSlug(query) {
  // if it's a comix.to URL, extract slug
  const urlMatch = query.match(/comix\.to\/manga\/([^\/?#]+)/i);
  if (urlMatch) return urlMatch[1];

  // otherwise, treat as name → search
  const searchUrl = `${BASE_URL}/search?q=${encodeURIComponent(query)}`;
  const html = await fetchHTML(searchUrl);
  const $ = cheerio.load(html);
  // typical search result: first .manga-item a or .search-result a
  const firstResult = $('.manga-item a, .search-result a, .manga-poster a').first();
  if (firstResult.length) {
    const href = firstResult.attr('href');
    const slugMatch = href.match(/\/manga\/([^\/?#]+)/);
    if (slugMatch) return slugMatch[1];
  }
  throw new Error('Manga not found');
}

// ----- get manga info and chapter list -----
async function getMangaData(slug) {
  const url = `${BASE_URL}/manga/${slug}`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);

  // title
  const title = $('h1.manga-title, .manga-name, h1').first().text().trim() || slug;

  // poster
  let poster = $('.manga-poster img, .cover img, .manga-cover img').first().attr('src');
  if (poster && !poster.startsWith('http')) poster = `${BASE_URL}${poster}`;

  // description
  const desc = $('.manga-description, .description, .summary').first().text().trim();

  // author, status, genres (often in .manga-info)
  const infoText = $('.manga-info, .info').text();
  let author = '';
  let status = '';
  let genres = [];
  // crude extraction – adjust selectors as needed
  const lines = infoText.split('\n').map(s => s.trim()).filter(Boolean);
  lines.forEach(line => {
    if (line.toLowerCase().includes('author')) author = line.replace(/author/i, '').trim();
    if (line.toLowerCase().includes('status')) status = line.replace(/status/i, '').trim();
    if (line.toLowerCase().includes('genre')) genres = line.replace(/genre/i, '').split(',').map(s => s.trim());
  });

  // chapters list
  const chapters = [];
  // common selectors: .chapter-list a, .chapters a, .wp-manga-chapter a
  $('.chapter-list a, .chapters a, .wp-manga-chapter a, .chapter-item a').each((i, el) => {
    const link = $(el);
    const href = link.attr('href');
    const text = link.text().trim();
    // extract chapter number: "Chapter 123" or "Ch.123" or "123"
    let num = parseFloat(text.match(/(\d+\.?\d*)/)?.[0]) || i + 1;
    if (isNaN(num)) num = i + 1;
    const title = text || `Chapter ${num}`;
    if (href) {
      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      chapters.push({ num, title, url: fullUrl });
    }
  });

  // if no chapters found, try alternative: .wp-manga-chapter a
  if (chapters.length === 0) {
    $('.wp-manga-chapter a').each((i, el) => {
      const link = $(el);
      const href = link.attr('href');
      const text = link.text().trim();
      let num = parseFloat(text.match(/(\d+\.?\d*)/)?.[0]) || i + 1;
      if (isNaN(num)) num = i + 1;
      const title = text || `Chapter ${num}`;
      if (href) {
        const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
        chapters.push({ num, title, url: fullUrl });
      }
    });
  }

  // order by chapter number ascending
  chapters.sort((a, b) => a.num - b.num);

  // estimate page count and size (we can't know without fetching each chapter, but we can leave as placeholder)
  // we'll calculate size on download later.

  return {
    title,
    poster,
    description: desc,
    author,
    status,
    genres,
    chapters: chapters.map(ch => ({ ...ch, pages: 0, size: 0 })) // placeholder
  };
}

// ----- get image URLs for a chapter -----
async function getChapterImages(chapterUrl) {
  const html = await fetchHTML(chapterUrl);
  const $ = cheerio.load(html);
  const images = [];
  // typical selectors: .chapter-images img, .reader-area img, .page-img img
  $('.chapter-images img, .reader-area img, .page-img img, .reading-content img').each((i, el) => {
    const src = $(el).attr('src');
    if (src) {
      let full = src.startsWith('http') ? src : `${BASE_URL}${src}`;
      // sometimes data-src is used
      if (!full) full = $(el).attr('data-src');
      if (full) images.push(full);
    }
  });
  if (images.length === 0) {
    // fallback: look for any image inside .chapter-content
    $('.chapter-content img').each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src) images.push(src.startsWith('http') ? src : `${BASE_URL}${src}`);
    });
  }
  return images;
}

// ----- create a CBZ (ZIP) stream from image URLs -----
async function createCBZStream(imageUrls, chapterName) {
  const { Readable } = require('stream');
  const archiver = require('archiver');

  const archive = archiver('zip', { zlib: { level: 9 } });
  const stream = new stream.PassThrough();
  archive.pipe(stream);

  // download each image and add to archive
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
      console.warn(`Failed to download image ${url}: ${err.message}`);
    }
  }

  archive.finalize();
  return stream;
}

// ----- API endpoints -----

// Search / fetch manga
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  try {
    const slug = await resolveMangaSlug(query);
    const data = await getMangaData(slug);
    res.json({ success: true, manga: data, chapters: data.chapters });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to fetch manga' });
  }
});

// Download single chapter
app.get('/api/download', async (req, res) => {
  const { manga, chapter, url, title } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing chapter URL' });

  try {
    const imageUrls = await getChapterImages(url);
    if (imageUrls.length === 0) {
      return res.status(404).json({ error: 'No images found for this chapter' });
    }

    const chapterName = title || `Chapter ${chapter}`;
    const zipStream = await createCBZStream(imageUrls, chapterName);

    const fileName = `${manga || 'manga'} - ch.${chapter}.cbz`;
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Content-Type', 'application/zip');

    await pipeline(zipStream, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Download multiple chapters combined
app.post('/api/download-multiple', async (req, res) => {
  const { manga, chapters } = req.body;
  if (!chapters || !Array.isArray(chapters) || chapters.length === 0) {
    return res.status(400).json({ error: 'No chapters provided' });
  }

  try {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const stream = new stream.PassThrough();
    archive.pipe(stream);

    let totalImages = 0;
    for (const ch of chapters) {
      const imageUrls = await getChapterImages(ch.url);
      if (imageUrls.length === 0) continue;
      const prefix = `ch.${ch.num}/`;
      let idx = 1;
      const pad = String(imageUrls.length).length;
      for (const imgUrl of imageUrls) {
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
          console.warn(`Failed to download ${imgUrl}: ${err.message}`);
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

    await pipeline(stream, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
