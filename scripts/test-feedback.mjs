/**
 * Node test for the Writing Feedback schema (pure logic — no SillyTavern deps).
 *
 * Run from the extension root:  node scripts/test-feedback.mjs
 *
 * Covers parsing untrusted/malformed model output, validation/normalization,
 * source anchoring (including repeated quotes), severity computation, and
 * apply-safety — the riskiest pieces of the feature.
 */

import {
    parseFeedbackResponse,
    validateFeedbackResult,
    resolveAnchor,
    resolveResultAnchors,
    isIssueSafeToApply,
    computeHighestSeverity,
    hashText,
    hasJapaneseContent,
    FEEDBACK_SCHEMA_VERSION,
} from '../src/feedback-schema.js';

let passed = 0;
let failed = 0;

function check(name, cond) {
    if (cond) {
        passed++;
        // console.log(`  ok  ${name}`);
    } else {
        failed++;
        console.error(`FAIL  ${name}`);
    }
}

function eq(name, actual, expected) {
    check(`${name} (got ${JSON.stringify(actual)})`, actual === expected);
}

// ── 1. Valid positive message: no issues, strengths, no revised text ──
{
    const raw = JSON.stringify({
        version: 1,
        summary: 'Natural and correct.',
        revisedText: null,
        strengths: [{ quote: 'まだ', explanation: 'Matches "not yet" naturally.' }],
        issues: [],
    });
    const out = parseFeedbackResponse(raw);
    check('positive: parses ok', out.ok);
    eq('positive: no issues', out.result.issues.length, 0);
    eq('positive: one strength', out.result.strengths.length, 1);
    eq('positive: revisedText null', out.result.revisedText, null);
    eq('positive: highestSeverity null', out.result.highestSeverity, null);
}

// ── 2. Grammar problem: category/severity render, quote+replacement, revised ──
{
    const raw = JSON.stringify({
        version: 1,
        summary: 'One tense issue.',
        revisedText: 'まだそれを試したことがない。',
        strengths: [],
        issues: [{
            category: 'grammar', severity: 'major', confidence: 'high',
            quote: '試しなかった', occurrence: 1, sentence: 'まだそれを試しなかった。',
            explanation: 'Describes a past action, not lack of experience.',
            replacement: '試したことがない', alternatives: ['まだ試してない'],
        }],
    });
    const out = parseFeedbackResponse(raw);
    check('grammar: parses ok', out.ok);
    eq('grammar: category', out.result.issues[0].category, 'grammar');
    eq('grammar: severity', out.result.issues[0].severity, 'major');
    eq('grammar: highestSeverity', out.result.highestSeverity, 'major');
    eq('grammar: has replacement', out.result.issues[0].replacement, '試したことがない');
    eq('grammar: revisedText kept', out.result.revisedText, 'まだそれを試したことがない。');
    eq('grammar: alternatives', out.result.issues[0].alternatives.length, 1);
}

// ── 3. Repeated-quote anchor resolution ──
{
    const source = 'これはペンです。これはペンです。';
    const first = resolveAnchor(source, 'これは', 1);
    const second = resolveAnchor(source, 'これは', 2);
    eq('anchor: count', first.count, 2);
    eq('anchor: first start', first.start, 0);
    check('anchor: second start later', second.found && second.start > first.start);
    const oob = resolveAnchor(source, 'これは', 3);
    check('anchor: out-of-range not found', !oob.found && oob.count === 2);
    const missing = resolveAnchor(source, 'XYZ', 1);
    check('anchor: missing not found', !missing.found && missing.count === 0);
}

// ── 4. Malformed response ──
{
    const out = parseFeedbackResponse('totally not json at all');
    check('malformed: not ok', !out.ok);
    check('malformed: has error', typeof out.error === 'string' && out.error.length > 0);
    check('malformed: keeps raw', out.raw === 'totally not json at all');
}

// ── 5. Fenced JSON + leading prose ──
{
    const raw = 'Here you go:\n```json\n{"version":1,"summary":"ok","issues":[]}\n```\nDone.';
    const out = parseFeedbackResponse(raw);
    check('fenced: parses ok', out.ok);
    eq('fenced: summary', out.result.summary, 'ok');
}

// ── 6. Unknown category → fallback 'other' ──
{
    const result = validateFeedbackResult({
        summary: 's',
        issues: [{ category: 'made_up_thing', severity: 'minor', confidence: 'low', quote: 'x', explanation: 'e' }],
    });
    eq('unknown category: → other', result.issues[0].category, 'other');
}

// ── 7. Trailing-comma repair ──
{
    const raw = '{"version":1,"summary":"ok","strengths":[],"issues":[],}';
    const out = parseFeedbackResponse(raw);
    check('trailing comma: parses ok', out.ok);
}

// ── 8. hashText: stable + whitespace-insensitive ──
{
    const a = hashText('これは ペン です');
    const b = hashText('これは  ペン  です');
    const c = hashText('ちがう');
    eq('hash: whitespace-insensitive', a, b);
    check('hash: differs for different text', a !== c);
}

// ── 9. Apply-safety ──
{
    const source = 'ねこ ねこ';
    const ambiguous = validateFeedbackResult({
        summary: 's',
        issues: [{ category: 'word_choice', severity: 'minor', confidence: 'low', quote: 'ねこ', explanation: 'e', replacement: '猫' }],
    });
    resolveResultAnchors(ambiguous, source);
    // occurrence not provided + appears twice → not safe to apply
    check('apply: ambiguous repeated quote unsafe', !isIssueSafeToApply(ambiguous.issues[0]));

    const disambiguated = validateFeedbackResult({
        summary: 's',
        issues: [{ category: 'word_choice', severity: 'minor', confidence: 'low', quote: 'ねこ', occurrence: 2, explanation: 'e', replacement: '猫' }],
    });
    resolveResultAnchors(disambiguated, source);
    check('apply: disambiguated occurrence safe', isIssueSafeToApply(disambiguated.issues[0]));

    const unique = validateFeedbackResult({
        summary: 's',
        issues: [{ category: 'word_choice', severity: 'minor', confidence: 'low', quote: 'いぬ', explanation: 'e', replacement: '犬' }],
    });
    resolveResultAnchors(unique, 'いぬ が いる');
    check('apply: unique quote safe', isIssueSafeToApply(unique.issues[0]));

    const noReplacement = validateFeedbackResult({
        summary: 's',
        issues: [{ category: 'context', severity: 'info', confidence: 'low', quote: 'いぬ', explanation: 'explanatory only' }],
    });
    resolveResultAnchors(noReplacement, 'いぬ が いる');
    check('apply: explanatory issue not applyable', !isIssueSafeToApply(noReplacement.issues[0]));
}

// ── 10. computeHighestSeverity ordering ──
{
    const sev = computeHighestSeverity([
        { severity: 'info' }, { severity: 'critical' }, { severity: 'minor' },
    ]);
    eq('severity: highest is critical', sev, 'critical');
    eq('severity: empty → null', computeHighestSeverity([]), null);
}

// ── 11. Length clamping + drops empty issues ──
{
    const huge = 'あ'.repeat(5000);
    const result = validateFeedbackResult({
        summary: huge,
        issues: [
            { category: 'grammar', severity: 'major', confidence: 'high', quote: 'q', explanation: 'e' },
            { /* empty: no quote, no explanation */ category: 'grammar' },
        ],
    });
    check('clamp: summary truncated', result.summary.length < 5000 && result.summary.length > 0);
    eq('clamp: empty issue dropped', result.issues.length, 1);
}

// ── 12. hasJapaneseContent heuristic ──
{
    check('jp: detects kana', hasJapaneseContent('これは', 2));
    check('jp: rejects english', !hasJapaneseContent('hello world', 2));
    check('jp: respects minChars', !hasJapaneseContent('あ', 2));
    check('jp: mixed counts JA chars', hasJapaneseContent('I said 元気です to her', 2));
}

// ── 13. Schema version surfaced ──
{
    const out = parseFeedbackResponse('{"summary":"ok","issues":[]}');
    check('version: defaults when missing', out.ok && out.result.version === FEEDBACK_SCHEMA_VERSION);
}

console.log(`\nWriting Feedback schema tests: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
