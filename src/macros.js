import { getKnownChars, getLearningChars } from './kanji-state.js';

/**
 * Registers SillyTavern macros for NihongoHelper.
 *
 * Available macros:
 *   {{knownKanji}}            — Comma-separated list of known kanji characters
 *   {{knownKanjiCount}}       — Number of known kanji
 *   {{learningKanji}}         — Comma-separated list of kanji marked "learning"
 *   {{learningKanjiCount}}    — Number of learning kanji
 */
export function registerMacros() {
    const { macros } = SillyTavern.getContext();
    if (!macros || !macros.register) {
        console.warn('[NihongoHelper] Macro system not available, skipping macro registration');
        return;
    }

    macros.register('knownKanji', {
        description: 'Comma-separated list of all kanji the user has marked as known in Nihongo Helper',
        handler: () => getKnownChars().join(','),
    });

    macros.register('knownKanjiCount', {
        description: 'Number of kanji the user has marked as known in Nihongo Helper',
        handler: () => String(getKnownChars().length),
    });

    macros.register('learningKanji', {
        description: 'Comma-separated list of kanji the user is actively studying (learning state) in Nihongo Helper',
        handler: () => getLearningChars().join(','),
    });

    macros.register('learningKanjiCount', {
        description: 'Number of kanji the user is actively studying (learning state) in Nihongo Helper',
        handler: () => String(getLearningChars().length),
    });
}
