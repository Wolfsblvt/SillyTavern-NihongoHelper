#!/usr/bin/env node
/**
 * Processes Yomitan-format frequency dictionaries into a compact lookup format.
 *
 * Yomitan frequency dicts are ZIP files containing:
 *   - index.json (metadata)
 *   - term_meta_bank_N.json (arrays of [term, "freq", value])
 *     where value is either a number (rank) or { reading?, frequency }
 *
 * This script reads one or more source directories/ZIPs and merges them into
 * a single data/frequency.json with N-list support.
 *
 * Usage:
 *   node scripts/build-frequency.cjs --add <name> <path-to-extracted-dir-or-zip>
 *   node scripts/build-frequency.cjs --list
 *   node scripts/build-frequency.cjs --remove <name>
 *
 * The output format supports multiple frequency lists. Each list is identified
 * by a short key (e.g., "jpdb", "netflix", "innocent").
 *
 * Output: data/frequency.json
 */

const fs = require('fs');
const path = require('path');
const { createUnzip } = require('zlib');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT = path.join(DATA_DIR, 'frequency.json');
const SOURCES_DIR = path.join(DATA_DIR, 'frequency-sources');

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

if (command === '--add' || command === '-a') {
    const name = args[1];
    const sourcePath = args[2];
    if (!name || !sourcePath) {
        console.error('Usage: --add <name> <path-to-extracted-dir-or-zip>');
        process.exit(1);
    }
    addFrequencyList(name, sourcePath);
} else if (command === '--list' || command === '-l') {
    listFrequencyLists();
} else if (command === '--remove' || command === '-r') {
    const name = args[1];
    if (!name) {
        console.error('Usage: --remove <name>');
        process.exit(1);
    }
    removeFrequencyList(name);
} else if (command === '--rebuild') {
    rebuildFromSources();
} else {
    console.log(`
Frequency Data Pipeline

Commands:
  --add <name> <path>   Add/update a frequency list from Yomitan dict directory
  --remove <name>       Remove a frequency list
  --list                Show current frequency lists
  --rebuild             Rebuild output from saved sources

Examples:
  node scripts/build-frequency.cjs --add jpdb ./downloads/jpdb-freq/
  node scripts/build-frequency.cjs --add netflix ./downloads/netflix-freq/
  node scripts/build-frequency.cjs --list
`);
}

// ── Commands ─────────────────────────────────────────────────────────────────

function addFrequencyList(name, sourcePath) {
    const absPath = path.resolve(sourcePath);
    if (!fs.existsSync(absPath)) {
        console.error(`Source not found: ${absPath}`);
        process.exit(1);
    }

    // Determine if it's a directory (extracted Yomitan dict) or needs extraction
    const stat = fs.statSync(absPath);
    let dir = absPath;
    if (!stat.isDirectory()) {
        console.error('ZIP support not implemented yet. Please extract the ZIP first.');
        console.error('Extract so that term_meta_bank_*.json files are in the directory root.');
        process.exit(1);
    }

    // Read index.json for metadata
    const indexPath = path.join(dir, 'index.json');
    let description = name;
    if (fs.existsSync(indexPath)) {
        try {
            const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
            description = idx.title || idx.description || name;
            console.log(`Dictionary: ${idx.title || name} (revision: ${idx.revision || '?'})`);
        } catch (e) { /* ignore */ }
    }

    // Find all term_meta_bank files
    const metaBanks = fs.readdirSync(dir)
        .filter(f => /^term_meta_bank_\d+\.json$/i.test(f))
        .sort();

    if (metaBanks.length === 0) {
        console.error(`No term_meta_bank_*.json files found in ${dir}`);
        process.exit(1);
    }

    console.log(`Found ${metaBanks.length} meta bank file(s)`);

    // Parse all frequency entries
    const freqMap = new Map(); // word → rank (lowest/best rank wins for duplicates)
    let totalEntries = 0;

    for (const bankFile of metaBanks) {
        const bankPath = path.join(dir, bankFile);
        const entries = JSON.parse(fs.readFileSync(bankPath, 'utf8'));

        for (const entry of entries) {
            if (!Array.isArray(entry) || entry.length < 3) continue;
            const [term, type, value] = entry;
            if (type !== 'freq') continue;

            let rank;
            if (typeof value === 'number') {
                rank = value;
            } else if (value && typeof value === 'object') {
                rank = value.frequency || value.value || value.displayValue;
                if (typeof rank === 'string') rank = parseInt(rank, 10);
            }

            if (typeof rank !== 'number' || isNaN(rank) || rank <= 0) continue;

            // Keep lowest (best) rank for each term
            const existing = freqMap.get(term);
            if (!existing || rank < existing) {
                freqMap.set(term, rank);
            }
            totalEntries++;
        }
    }

    console.log(`Parsed ${totalEntries} entries, ${freqMap.size} unique terms`);

    // Save source data for rebuilding
    if (!fs.existsSync(SOURCES_DIR)) fs.mkdirSync(SOURCES_DIR, { recursive: true });
    const sourceFile = path.join(SOURCES_DIR, `${name}.json`);
    const sourceData = {
        name,
        description,
        count: freqMap.size,
        addedAt: new Date().toISOString(),
        words: Object.fromEntries(freqMap),
    };
    fs.writeFileSync(sourceFile, JSON.stringify(sourceData), 'utf8');
    console.log(`Saved source: ${sourceFile}`);

    // Rebuild combined output
    rebuildFromSources();
}

function removeFrequencyList(name) {
    const sourceFile = path.join(SOURCES_DIR, `${name}.json`);
    if (!fs.existsSync(sourceFile)) {
        console.error(`List "${name}" not found in sources`);
        process.exit(1);
    }
    fs.unlinkSync(sourceFile);
    console.log(`Removed: ${name}`);
    rebuildFromSources();
}

function listFrequencyLists() {
    if (!fs.existsSync(SOURCES_DIR)) {
        console.log('No frequency lists added yet.');
        return;
    }
    const files = fs.readdirSync(SOURCES_DIR).filter(f => f.endsWith('.json'));
    if (files.length === 0) {
        console.log('No frequency lists added yet.');
        return;
    }
    console.log('Frequency lists:');
    for (const f of files) {
        const data = JSON.parse(fs.readFileSync(path.join(SOURCES_DIR, f), 'utf8'));
        console.log(`  ${data.name} — ${data.description} (${data.count} terms, added ${data.addedAt.slice(0, 10)})`);
    }
}

function rebuildFromSources() {
    if (!fs.existsSync(SOURCES_DIR)) {
        console.log('No sources to rebuild from.');
        return;
    }

    const files = fs.readdirSync(SOURCES_DIR).filter(f => f.endsWith('.json'));
    if (files.length === 0) {
        console.log('No sources to rebuild from.');
        return;
    }

    // Build combined output
    const lists = {};
    const allWords = new Map(); // word → { listName: rank, ... }

    for (const f of files) {
        const source = JSON.parse(fs.readFileSync(path.join(SOURCES_DIR, f), 'utf8'));
        lists[source.name] = {
            name: source.description || source.name,
            count: source.count,
        };

        for (const [word, rank] of Object.entries(source.words)) {
            if (!allWords.has(word)) allWords.set(word, {});
            allWords.get(word)[source.name] = rank;
        }
    }

    // Build output object
    const output = {
        v: 1,
        builtAt: new Date().toISOString(),
        lists,
        words: Object.fromEntries(allWords),
    };

    const json = JSON.stringify(output);
    fs.writeFileSync(OUTPUT, json, 'utf8');

    const sizeKB = (Buffer.byteLength(json, 'utf8') / 1024).toFixed(1);
    const sizeMB = (Buffer.byteLength(json, 'utf8') / 1024 / 1024).toFixed(2);
    console.log(`\nWritten ${allWords.size} words to ${OUTPUT}`);
    console.log(`  Size: ${sizeKB} KB (${sizeMB} MB)`);
    console.log(`  Lists: ${Object.keys(lists).join(', ')}`);
}
