#!/usr/bin/env node
/**
 * Processes the raw kanji.json from davidluzgouveia/kanji-data
 * into a lean array format for the Kanji Manager.
 *
 * Output: data/kanji.json — array of objects with only needed fields.
 * Only includes kanji that have a grade (jōyō) OR a JLPT level.
 */

const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, '..', 'data', 'kanji-raw.json');
const OUTPUT = path.join(__dirname, '..', 'data', 'kanji.json');

const raw = JSON.parse(fs.readFileSync(INPUT, 'utf8'));

const result = [];

for (const [char, data] of Object.entries(raw)) {
    // Include if it has a grade (jōyō) or JLPT level
    if (!data.grade && !data.jlpt_new && !data.jlpt_old) continue;

    result.push({
        k: char,
        s: data.strokes || null,
        g: data.grade || null,          // school grade (1-6, 8=junior high, 9/10=jinmeiyō)
        f: data.freq || null,           // newspaper frequency rank (1=most common)
        jlpt: data.jlpt_new || null,    // JLPT level (1-5, 5=easiest)
        m: data.meanings || [],         // English meanings
        on: data.readings_on || [],     // On'yomi readings
        kun: data.readings_kun || [],   // Kun'yomi readings
    });
}

// Sort by frequency (null freq at end), then by grade
result.sort((a, b) => {
    const fa = a.f || 99999;
    const fb = b.f || 99999;
    return fa - fb;
});

// Assign a sequential index for stable reference
result.forEach((entry, i) => { entry.i = i; });

const json = JSON.stringify(result);
fs.writeFileSync(OUTPUT, json, 'utf8');

const sizeKB = (Buffer.byteLength(json, 'utf8') / 1024).toFixed(1);
console.log(`Written ${result.length} kanji to ${OUTPUT} (${sizeKB} KB)`);
console.log(`  Grade 1-6: ${result.filter(k => k.g >= 1 && k.g <= 6).length}`);
console.log(`  Grade 8 (junior high): ${result.filter(k => k.g === 8).length}`);
console.log(`  JLPT N5: ${result.filter(k => k.jlpt === 5).length}`);
console.log(`  JLPT N4: ${result.filter(k => k.jlpt === 4).length}`);
console.log(`  JLPT N3: ${result.filter(k => k.jlpt === 3).length}`);
console.log(`  JLPT N2: ${result.filter(k => k.jlpt === 2).length}`);
console.log(`  JLPT N1: ${result.filter(k => k.jlpt === 1).length}`);
