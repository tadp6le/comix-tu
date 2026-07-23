const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const stream = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files (your index.html and assets)
app.use(express.static('public'));  // put index.html inside /public or adjust

app.use(express.json());

// Helper: fetch HTML with retry
async function fetchHTML(url) {
    const response = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    return response.data;
}

// Helper: extract manga info and chapter list from comix.to
async function scrapeManga(query) {
    // If query is a URL, use it; otherwise assume it's a title and search
    let mangaUrl = query;
    if (!query.startsWith('http')) {
        // Search for the manga on comix.to (example: search endpoint)
        const searchUrl = `https://comix.to/search?q=${encodeURIComponent(query)}`;
        const html = await fetchHTML(searchUrl);
        const $ = cheerio.load(html);
        const firstResult = $('a[href*="/manga/"]').first().attr('href');
        if (!firstResult) throw new Error('Manga not found');
        mangaUrl = `https://comix.to${firstResult}`;
    }

    const html = await fetchHTML(mangaUrl);
    const $ = cheerio.load(html);

    // Title
    const title = $('h1.entry-title, .manga-title, h1').first().text().trim() || 'Untitled';

    // Poster
    const poster = $('img.attachment-thumb, .manga-poster img, .cover img').first().attr('src') || '';

    // Description
    const desc = $('.description, .summary, .manga-description').first().text().trim() || '';

    // Chapters – comix.to structure: often a list of <a> with chapter links
    const chapters = [];
    $('.chapter-list a, .chapters-list a, .wp-manga-chapter a').each((i, el) => {
        const link = $(el).attr('href');
        const text = $(el).text().trim();
        // Extract chapter number (e.g. "Chapter 69")
        const numMatch = text.match(/(\d+(\.\d+)?)/);
        const num = numMatch ? parseFloat(numMatch[0]) : (i + 1);
        if (link) {
            chapters.push({ num, url: link.startsWith('http') ? link : `https://comix.to${link}`, pages: 0 });
        }
    });

    // If no chapters found, try alternative selector
    if (chapters.length === 0) {
        $('a[href*="/chapter/"]').each((i, el) => {
            const link = $(el).attr('href');
            const text = $(el).text().trim();
            const numMatch = text.match(/(\d+(\.\d+)?)/);
            const num = numMatch ? parseFloat(numMatch[0]) : (i + 1);
            if (link) {
                chapters.push({ num, url: link.startsWith('http') ? link : `https://comix.to${link}`, pages: 0 });
            }
        });
    }

    if (chapters.length === 0) throw new Error('No chapters found');

    // Sort by number ascending
    chapters.sort((a, b) => a.num - b.num);

    // Estimate pages and size for each chapter (we'll fetch exact when downloading)
    // For now, we can scrape each chapter to get page count, but that's heavy.
    // Instead, we'll show placeholder '?' and compute during download.
    // We'll fetch page count on demand when downloading.

    return { title, poster, description: desc, chapters };
}

// ─── Endpoint: fetch manga info ──────────────────────────────────
app.post('/api/manga', async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: 'Missing query' });

        const data = await scrapeManga(query);

        // Estimate chapter sizes (we'll fetch page count for each chapter quickly)
        // To be efficient, we can fetch page counts in parallel but limit concurrency.
        // We'll do it on the fly for each chapter, but for metadata we need pages count.
        // So we fetch each chapter's page count.
        const chapterPromises = data.chapters.map(async (ch) => {
            try {
                const html = await fetchHTML(ch.url);
                const $ = cheerio.load(html);
                // Count images on the chapter page (common class: .page-break, .wp-manga-chapter img)
                const images = $('img').filter((i, el) => {
                    const src = $(el).attr('src');
                    return src && src.includes('comix') && !src.includes('logo');
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

        const totalPages = data.chapters.reduce((sum, c) => sum + c.pages, 0);
        const totalSize = data.chapters.reduce((sum, c) => sum + c.size, 0);

        res.json({
            title: data.title,
            poster: data.poster,
            description: data.description,
            chapters: data.chapters.map(c => ({ num: c.num, url: c.url, pages: c.pages, size: c.size })),
            totalPages,
            totalSize: parseFloat(totalSize.toFixed(1))
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message || 'Failed to fetch manga' });
    }
});

// ─── Download endpoint ────────────────────────────────────────────
app.get('/api/download', async (req, res) => {
    try {
        const { manga, chapter, chapters, url, pages } = req.query;

        // If 'chapters' is present, it's a JSON array for multiple chapters
        let chapterList = [];
        if (chapters) {
            chapterList = JSON.parse(chapters);
        } else if (url && chapter) {
            // Single chapter
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
            const imgElements = $('img').filter((i, el) => {
                const src = $(el).attr('src');
                return src && src.includes('comix') && !src.includes('logo');
            });

            const imageUrls = imgElements.map((i, el) => $(el).attr('src')).get();

            if (imageUrls.length === 0) {
                // Fallback: look for any images in the chapter container
                $('.wp-manga-chapter img, .reading-content img').each((i, el) => {
                    const src = $(el).attr('src');
                    if (src) imageUrls.push(src);
                });
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

// Serve index.html for root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
