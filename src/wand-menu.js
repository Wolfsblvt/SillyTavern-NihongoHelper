import { EXTENSION_NAME } from '../index.js';
import { openKanjiManager } from './kanji-manager.js';

/**
 * Injects the Nihongo Helper sub-menu into the wand/extensions menu.
 * Uses a collapsible list-group for future expandability.
 */
export function injectWandMenu() {
    const extensionsMenu = document.getElementById('extensionsMenu');
    if (!extensionsMenu) return;

    // Create our container
    const container = document.createElement('div');
    container.id = 'nihongo_wand_container';
    container.classList.add('extension_container');

    // Main toggle button for the sub-menu
    const menuToggle = document.createElement('div');
    menuToggle.id = 'nihongo_wand_toggle';
    menuToggle.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
    menuToggle.innerHTML = `
        <div class="fa-solid fa-language extensionsMenuExtensionButton"></div>
        <span>Nihongo Helper</span>
        <div class="fa-solid fa-chevron-right" style="margin-left: auto; font-size: 0.7em; transition: transform 0.15s;"></div>
    `;

    // Sub-menu container (hidden by default)
    const subMenu = document.createElement('div');
    subMenu.id = 'nihongo_wand_submenu';
    subMenu.classList.add('list-group');
    subMenu.style.display = 'none';
    subMenu.style.paddingLeft = '20px';

    // Kanji Manager button
    const kanjiManagerBtn = document.createElement('div');
    kanjiManagerBtn.id = 'nihongo_wand_kanji_manager';
    kanjiManagerBtn.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
    kanjiManagerBtn.innerHTML = `
        <div class="fa-solid fa-book-open extensionsMenuExtensionButton"></div>
        <span>Kanji Manager</span>
    `;
    kanjiManagerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openKanjiManager();
    });

    subMenu.appendChild(kanjiManagerBtn);
    container.appendChild(menuToggle);
    container.appendChild(subMenu);
    extensionsMenu.appendChild(container);

    // Toggle sub-menu on click
    let subMenuOpen = false;
    menuToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        subMenuOpen = !subMenuOpen;
        subMenu.style.display = subMenuOpen ? '' : 'none';
        const chevron = menuToggle.querySelector('.fa-chevron-right');
        if (chevron) {
            chevron.style.transform = subMenuOpen ? 'rotate(90deg)' : '';
        }
    });
}
