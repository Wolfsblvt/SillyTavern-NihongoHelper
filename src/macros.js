import { getKnownKanji } from './kanji-manager.js';

/**
 * Registers SillyTavern macros for NihongoHelper.
 *
 * Available macros:
 *   {{knownKanji}}         — Comma-separated list of known kanji characters
 *   {{knownKanjiCount}}    — Number of known kanji
 */
export function registerMacros() {
    const { macros } = SillyTavern.getContext();
    if (!macros || !macros.register) {
        console.warn('[NihongoHelper] Macro system not available, skipping macro registration');
        return;
    }

    macros.register('knownKanji', {
        description: 'Comma-separated list of all kanji the user has marked as known in Nihongo Helper',
        handler: () => {
            const known = getKnownKanji();
            return [...known.keys()].join(',');
        },
    });

    macros.register('knownKanjiCount', {
        description: 'Number of kanji the user has marked as known in Nihongo Helper',
        handler: () => {
            const known = getKnownKanji();
            return String(known.size);
        },
    });
}
