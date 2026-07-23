const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files (index.html, etc.) from the "public" folder
app.use(express.static('public'));
app.use(express.json());

// ─── Helper: fetch HTML with timeout and retry ──────────────────
async function fetchHTML(url) {
    const response = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    return response.data;
}

// ─── Scrape manga info (supports both /manga/ and /title/ URLs) ──
async function scrapeManga(query) {
    let mangaUrl = query;

    // If the query is not a full URL, treat it as a search term
    if (!query.startsWith('http')) {
        const searchUrl = `https://comix.to/search?q=${encodeURIComponent(query)}`;
        const html = await fetchHTML(searchUrl);
        const $ = cheerio.load(html);
        // Try to find a manga link (could be /manga/ or /title/)
        const firstResult = $('a[href*="/manga/"], a[href*="/title/"]').first().attr('href');
        if (!firstResult) throw new Error('Manga not found');
        mangaUrl = `https://comix.to${firstResult}`;
    }

    const html = await fetchHTML(mangaUrl);
    const $ = cheerio.load(html);

    // Extract title – many possible selectors
    let title = $('h1.entry-title, .manga-title, h1').first().text().trim();
    if (!title) {
        // Try from <title> tag
        const titleTag = $('title').text().trim();
        if (titleTag) title = titleTag.replace(/ - .*/, '').trim();
    }
    if (!title) title = 'Untitled';

    // Poster
    const poster = $('img.attachment-thumb, .manga-poster img, .cover img, .manga-cover img').first().attr('src') || '';

    // Description
    const desc = $('.description, .summary, .manga-description, .synopsis').first().text().trim() || '';

    // Chapters – comix.to often uses <a> inside .chapter-list, .chapters-list, or .wp-manga-chapter
    const chapters = [];
    $('.chapter-list a, .chapters-list a, .wp-manga-chapter a, .list-chapter a, a[href*="/chapter/"]').each((i, el) => {
        const link = $(el).attr('href');
        const text = $(el).text().trim();
        // Extract chapter number (e.g. "Chapter 69" or "Ch.69")
        const numMatch = text.match(/(\d+(\.\d+)?)/);
        const num = numMatch ? parseFloat(numMatch[0]) : (i + 1);
        if (link && link.includes('/chapter/')) {
            const fullUrl = link.startsWith('http') ? link : `https://comix.to${link}`;
            chapters.push({ num, url: fullUrl, pages: 0 });
        }
    });

    // If still no chapters, try to find them in a different way (some titles use /title/ pattern)
    if (chapters.length === 0) {
        // Look for any link that contains "chapter" and has a number
        $('a[href*="chapter"]').each((i, el) => {
            const link = $(el).attr('href');
            const text = $(el).text().trim();
            const numMatch = text.match(/(\d+(\.\d+)?)/);
            const num = numMatch ? parseFloat(numMatch[0]) : (i + 1);
            if (link && link.includes('/chapter/')) {
                const fullUrl = link.startsWith('http') ? link : `https://comix.to${link}`;
                chapters.push({ num, url: fullUrl, pages: 0 });
            }
        });
    }

    if (chapters.length === 0) throw new Error('No chapters found – the site structure may have changed.');

    // Sort by number ascending
    chapters.sort((a, b) => a.num - b.num);

    // Now fetch page counts for each chapter (to show in UI)
    const chapterPromises = chapters.map(async (ch) => {
        try {
            const html = await fetchHTML(ch.url);
            const $ = cheerio.load(html);
            // Count images that look like manga pages
            const images = $('img').filter((i, el) => {
                const src = $(el).attr('src');
                return src && (src.includes('comix') || src.includes('cdn')) && !src.includes('logo') && !src.includes('avatar');
            });
            const pageCount = images.length;
            ch.pages = pageCount || 0;
            // Estimate size ~180KB per image
            ch.size = pageCount ? parseFloat((pageCount * 180 / 1024).toFixed(1)) : 0;
            return ch;
        } catch (e) {
            ch.pages = 0;
            ch.size = 0;
            return ch;
        }
    });

    await Promise.all(chapterPromises);

    const totalPages = chapters.reduce((sum, c) => sum + c.pages, 0);
    const totalSize = chapters.reduce((sum, c) => sum + c.size, 0);

    return {
        title,
        poster,
        description: desc,
        chapters: chapters.map(c => ({ num: c.num, url: c.url, pages: c.pages, size: c.size })),
        totalPages,
        totalSize: parseFloat(totalSize.toFixed(1))
    };
}

// ─── API: fetch manga info ─────────────────────────────────────────
app.post('/api/manga', async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: 'Missing query' });

        const data = await scrapeManga(query);
        res.json(data);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message || 'Failed to fetch manga' });
    }
});

// ─── API: download chapter(s) as CBZ ──────────────────────────────
app.get('/api/download', async (req, res) => {
    try {
        const { manga, chapter, chapters, url, pages } = req.query;

        let chapterList = [];
        if (chapters) {
            chapterList = JSON.parse(chapters);
        } else if (url && chapter) {
            chapterList = [{ num: parseFloat(chapter), url, pages: parseInt(pages) || 0 }];
        } else {
            return res.status(400).send('Missing chapter info');
        }

        const mangaName = manga || 'manga';

        // Create a temporary directory
        const tempDir = path.join(__dirname, 'tmp', uuidv4());
        fs.mkdirSync(tempDir, { recursive: true });

        // Download images for each chapter
        for (let ch of chapterList) {
            const chapterNum = ch.num;
            const chapterUrl = ch.url;
            const chapterFolder = path.join(tempDir, `Ch.${chapterNum}`);
            fs.mkdirSync(chapterFolder, { recursive: true });

            // Fetch chapter page to get image URLs
            const html = await fetchHTML(chapterUrl);
            const $ = cheerio.load(html);

            // Try multiple selectors for images
            let imageUrls = [];
            $('img').each((i, el) => {
                const src = $(el).attr('src');
                if (src && (src.includes('comix') || src.includes('cdn')) && !src.includes('logo') && !src.includes('avatar')) {
                    imageUrls.push(src);
                }
            });

            // If none found, try .wp-manga-chapter img
            if (imageUrls.length === 0) {
                $('.wp-manga-chapter img, .reading-content img, .chapter-content img').each((i, el) => {
                    const src = $(el).attr('src');
                    if (src) imageUrls.push(src);
                });
            }

            if (imageUrls.length === 0) {
                throw new Error(`No images found for chapter ${chapterNum}`);
            }

            // Download each image
            const downloadPromises = imageUrls.map(async (imgUrl, idx) => {
                try {
                    const response = await axios.get(imgUrl, {
                        responseType: 'stream',
                        timeout: 30000,
                        headers: { 'User-Agent': 'Mozilla/5.0' }
                    });
                    const ext = path.extname(imgUrl) || '.jpg';
                    const filename = `${String(idx + 1).padStart(3, '0')}${ext}`;
                    const filePath = path.join(chapterFolder, filename);
                    const writer = fs.createWriteStream(filePath);
                    response.data.pipe(writer);
                    return new Promise((resolve, reject) => {
                        writer.on('finish', resolve);
                        writer.on('error', reject);
                    });
                } catch (e) {
                    console.warn(`Failed to download ${imgUrl}`, e.message);
                }
            });

            await Promise.all(downloadPromises);
        }

        // Create ZIP (CBZ) stream
        const archive = archiver('zip', { zlib: { level: 9 } });
        const zipName = `${sanitize(mangaName)}.cbz`;
        res.attachment(zipName);
        archive.pipe(res);

        // Add each chapter folder to the archive
        const chapterDirs = fs.readdirSync(tempDir).filter(f => f.startsWith('Ch.'));
        for (let dir of chapterDirs) {
            const dirPath = path.join(tempDir, dir);
            archive.directory(dirPath, dir);
        }

        await archive.finalize();

        // Clean up after streaming
        archive.on('end', () => {
            fs.rm(tempDir, { recursive: true, force: true }, (err) => {
                if (err) console.error('Cleanup error', err);
            });
        });

    } catch (error) {
        console.error(error);
        res.status(500).send('Download failed: ' + error.message);
    }
});

function sanitize(name) {
    return name.replace(/[^a-zA-Z0-9\-_. ]/g, '').trim() || 'manga';
}

// ─── Serve the frontend ────────────────────────────────────────────
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
