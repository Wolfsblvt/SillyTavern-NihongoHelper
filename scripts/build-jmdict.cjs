#!/usr/bin/env node
/**
 * Downloads and processes jmdict-simplified into a compact lookup format
 * for the NihongoHelper word tooltip.
 *
 * Source: https://github.com/scriptin/jmdict-simplified (CC BY-SA 4.0)
 *
 * Raw file:  data/jmdict-raw.json (gitignored)
 * Output:    data/jmdict.json     (tracked)
 *
 * Usage:
 *   node scripts/build-jmdict.cjs                 # Process existing raw file
 *   node scripts/build-jmdict.cjs --download       # Download latest + process
 *   node scripts/build-jmdict.cjs --download --full # Download full (not just common)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const DATA_DIR = path.join(__dirname, '..', 'data');
const RAW_FILE = path.join(DATA_DIR, 'jmdict-raw.json');
const OUTPUT = path.join(DATA_DIR, 'jmdict.json');

const MAX_SENSES = 5;
const MAX_GLOSSES = 5;

const GITHUB_API_URL = 'https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest';
const ASSET_RE_COMMON = /^jmdict-eng-common-.*\.json\.tgz$/;
const ASSET_RE_FULL = /^jmdict-eng-\d.*\.json\.tgz$/;

// ── HTTP helpers ────────────────────────────────────────────────────────────

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'NihongoHelper-BuildScript/1.0' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                resolve(httpsGet(res.headers.location));
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                return;
            }
            resolve(res);
        }).on('error', reject);
    });
}

async function fetchJson(url) {
    const res = await httpsGet(url);
    return new Promise((resolve, reject) => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        res.on('error', reject);
    });
}

async function downloadBuffer(url) {
    const res = await httpsGet(url);
    return new Promise((resolve, reject) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
    });
}

// ── Tar extraction ──────────────────────────────────────────────────────────

function extractJsonFromTgz(tgzBuffer) {
    const tar = zlib.gunzipSync(tgzBuffer);
    let offset = 0;
    while (offset + 512 <= tar.length) {
        const header = tar.slice(offset, offset + 512);
        if (header[0] === 0) break;

        const name = header.slice(0, 100).toString('utf8').replace(/\0/g, '');
        const sizeOctal = header.slice(124, 136).toString('utf8').replace(/\0/g, '').trim();
        const size = parseInt(sizeOctal, 8) || 0;
        const typeFlag = header[156]; // 48='0' or 0 = regular file

        offset += 512;

        if ((typeFlag === 48 || typeFlag === 0) && name.endsWith('.json') && size > 0) {
            return tar.slice(offset, offset + size).toString('utf8');
        }

        offset += Math.ceil(size / 512) * 512;
    }
    throw new Error('No JSON file found in tar archive');
}

// ── Download ────────────────────────────────────────────────────────────────

async function downloadLatest(useFull) {
    console.log('Fetching latest release info from GitHub...');
    const release = await fetchJson(GITHUB_API_URL);
    console.log(`  Release: ${release.tag_name}`);

    const pattern = useFull ? ASSET_RE_FULL : ASSET_RE_COMMON;
    const asset = release.assets.find(a => pattern.test(a.name));
    if (!asset) {
        throw new Error(`No matching asset found for pattern ${pattern}`);
    }

    const sizeMB = (asset.size / 1024 / 1024).toFixed(1);
    console.log(`  Downloading ${asset.name} (${sizeMB} MB)...`);
    const tgzBuffer = await downloadBuffer(asset.browser_download_url);

    console.log('  Extracting JSON from archive...');
    const jsonStr = extractJsonFromTgz(tgzBuffer);

    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(RAW_FILE, jsonStr, 'utf8');
    const rawMB = (Buffer.byteLength(jsonStr, 'utf8') / 1024 / 1024).toFixed(1);
    console.log(`  Saved raw file: ${path.relative(process.cwd(), RAW_FILE)} (${rawMB} MB)`);
}

// ── Processing ──────────────────────────────────────────────────────────────

function processJMdict(raw) {
    const tags = raw.tags || {};
    const words = raw.words || [];

    const entries = [];
    let skipped = 0;

    for (const word of words) {
        const kanjiTexts = (word.kanji || []).map(k => k.text);
        const kanaTexts = (word.kana || []).map(k => k.text);

        if (!kanaTexts.length) { skipped++; continue; }

        const senses = [];
        for (const sense of (word.sense || []).slice(0, MAX_SENSES)) {
            const glosses = (sense.gloss || [])
                .filter(g => g.lang === 'eng')
                .slice(0, MAX_GLOSSES)
                .map(g => g.text);

            if (!glosses.length) continue;

            const s = { p: sense.partOfSpeech || [], g: glosses };
            if (sense.misc && sense.misc.length) s.m = sense.misc;
            if (sense.info && sense.info.length) s.i = sense.info;
            if (sense.field && sense.field.length) s.f = sense.field;
            senses.push(s);
        }

        if (!senses.length) { skipped++; continue; }

        const entry = { r: kanaTexts, s: senses };
        if (kanjiTexts.length) entry.k = kanjiTexts;
        entries.push(entry);
    }

    console.log(`  Processed ${entries.length} entries (skipped ${skipped})`);
    return {
        v: 1,
        date: raw.dictDate || null,
        src: `jmdict-simplified ${raw.version || '?'}`,
        tags,
        words: entries,
    };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    const doDownload = args.includes('--download');
    const useFull = args.includes('--full');

    if (doDownload) {
        await downloadLatest(useFull);
    }

    if (!fs.existsSync(RAW_FILE)) {
        console.error(`Raw file not found: ${RAW_FILE}`);
        console.error('Run with --download to fetch the latest JMdict data from GitHub.');
        console.error('  node scripts/build-jmdict.cjs --download');
        process.exit(1);
    }

    console.log('Reading raw JMdict data...');
    const raw = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
    console.log(`  Source: jmdict-simplified ${raw.version || '?'}, date: ${raw.dictDate || '?'}`);
    console.log(`  ${(raw.words || []).length} raw entries, commonOnly: ${raw.commonOnly ?? '?'}`);

    console.log('Processing...');
    const result = processJMdict(raw);

    const json = JSON.stringify(result);
    fs.writeFileSync(OUTPUT, json, 'utf8');

    const sizeMB = (Buffer.byteLength(json, 'utf8') / 1024 / 1024).toFixed(2);
    console.log(`\nDone! Written to ${path.relative(process.cwd(), OUTPUT)}`);
    console.log(`  Entries: ${result.words.length}`);
    console.log(`  Size:    ${sizeMB} MB`);
    console.log(`  Tags:    ${Object.keys(result.tags).length}`);
    console.log(`  Source:  ${result.src}`);
    console.log(`  Date:    ${result.date}`);
}

main().catch(err => {
    console.error('Error:', err.message || err);
    process.exit(1);
});
