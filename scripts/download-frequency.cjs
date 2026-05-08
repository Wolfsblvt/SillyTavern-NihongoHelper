#!/usr/bin/env node
/**
 * Downloads and builds frequency data for NihongoHelper.
 *
 * Fetches JPDB frequency data (Yomitan-format) from GitHub, extracts it,
 * and runs build-frequency.cjs to produce data/frequency.json.
 *
 * Usage:
 *   node scripts/download-frequency.cjs
 *   node scripts/download-frequency.cjs --force   (re-download even if cached)
 *
 * Sources:
 *   - JPDB v2.2 frequency list (Yomitan format)
 *     https://github.com/MarvNC/jpdb-freq-list/releases
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const DOWNLOAD_DIR = path.join(__dirname, '..', 'data', 'downloads');
const EXTRACT_DIR = path.join(DOWNLOAD_DIR, 'jpdb-freq');
const BUILD_SCRIPT = path.join(__dirname, 'build-frequency.cjs');

const JPDB_API = 'https://api.github.com/repos/MarvNC/jpdb-freq-list/releases/latest';
const JPDB_ZIP = path.join(DOWNLOAD_DIR, 'jpdb-freq.zip');

const force = process.argv.includes('--force');

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('=== NihongoHelper Frequency Data Download ===\n');

    // 1. Download
    if (!force && fs.existsSync(JPDB_ZIP)) {
        console.log(`Using cached download: ${JPDB_ZIP}`);
    } else {
        if (!fs.existsSync(DOWNLOAD_DIR)) {
            fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
        }

        // Discover latest release asset URL via GitHub API
        console.log(`Fetching latest release info from GitHub...`);
        const releaseJson = await fetchJSON(JPDB_API);
        const asset = releaseJson.assets && releaseJson.assets[0];
        if (!asset || !asset.browser_download_url) {
            throw new Error('Could not find download asset in GitHub release');
        }
        const downloadUrl = asset.browser_download_url;
        console.log(`  Release: ${releaseJson.name}`);
        console.log(`  Asset: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);
        console.log(`  URL: ${downloadUrl}`);
        await downloadFile(downloadUrl, JPDB_ZIP);
        console.log(`  Saved to: ${JPDB_ZIP}`);
    }

    // 2. Extract ZIP
    console.log(`\nExtracting to ${EXTRACT_DIR}...`);
    if (fs.existsSync(EXTRACT_DIR)) {
        fs.rmSync(EXTRACT_DIR, { recursive: true });
    }
    fs.mkdirSync(EXTRACT_DIR, { recursive: true });

    try {
        // Try PowerShell extraction (Windows)
        execSync(
            `powershell -NoProfile -Command "Expand-Archive -Path '${JPDB_ZIP}' -DestinationPath '${EXTRACT_DIR}' -Force"`,
            { stdio: 'pipe' }
        );
    } catch {
        // Fallback: try unzip command
        try {
            execSync(`unzip -o "${JPDB_ZIP}" -d "${EXTRACT_DIR}"`, { stdio: 'pipe' });
        } catch {
            console.error('ERROR: Could not extract ZIP. Install unzip or use PowerShell on Windows.');
            process.exit(1);
        }
    }

    // Check if files are in a subdirectory
    const extractedFiles = fs.readdirSync(EXTRACT_DIR);
    let metaDir = EXTRACT_DIR;
    if (extractedFiles.length === 1 && fs.statSync(path.join(EXTRACT_DIR, extractedFiles[0])).isDirectory()) {
        metaDir = path.join(EXTRACT_DIR, extractedFiles[0]);
    }

    // Verify we have term_meta_bank files
    const metaBanks = fs.readdirSync(metaDir).filter(f => /^term_meta_bank/i.test(f));
    if (metaBanks.length === 0) {
        console.error(`ERROR: No term_meta_bank files found in ${metaDir}`);
        console.error('Contents:', fs.readdirSync(metaDir).join(', '));
        process.exit(1);
    }
    console.log(`  Found ${metaBanks.length} meta bank file(s)`);

    // 3. Run build script
    console.log(`\nBuilding frequency.json...`);
    execSync(`node "${BUILD_SCRIPT}" --add jpdb "${metaDir}"`, { stdio: 'inherit' });

    console.log('\n✓ Frequency data ready!');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'NihongoHelper-Downloader' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                fetchJSON(res.headers.location).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} from ${url}`));
                return;
            }
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('Invalid JSON response')); }
            });
        }).on('error', reject);
    });
}

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const doRequest = (requestUrl) => {
            https.get(requestUrl, (res) => {
                // Follow redirects
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    doRequest(res.headers.location);
                    return;
                }

                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode} downloading ${requestUrl}`));
                    return;
                }

                const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
                let downloadedBytes = 0;
                const file = fs.createWriteStream(dest);

                res.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                    if (totalBytes > 0) {
                        const pct = ((downloadedBytes / totalBytes) * 100).toFixed(0);
                        process.stdout.write(`\r  Progress: ${pct}% (${(downloadedBytes / 1024 / 1024).toFixed(1)} MB)`);
                    }
                });

                res.pipe(file);
                file.on('finish', () => {
                    file.close();
                    if (totalBytes > 0) process.stdout.write('\n');
                    resolve();
                });
                file.on('error', (err) => {
                    fs.unlinkSync(dest);
                    reject(err);
                });
            }).on('error', reject);
        };
        doRequest(url);
    });
}

main().catch(err => {
    console.error('\nFATAL:', err.message || err);
    process.exit(1);
});
