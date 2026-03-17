import { App, setIcon, SuggestModal } from 'obsidian';
import {
    generateHotKeyText,
    OrderedSet, PaletteMatch, renderPrevItems, SuggestModalAdapter,
} from 'src/utils';
import { Match, UnsafeSuggestModalInterface } from 'src/types/types';
import {
    BetterCommandPaletteCommandAdapter,
    BetterCommandPaletteFileAdapter,
    BetterCommandPaletteTagAdapter,
    BetterCommandPaletteOmnisearchAdapter,
} from 'src/palette-modal-adapters';
import BetterCommandPalettePlugin from 'src/main';
import { ActionType } from './utils/constants';

class BetterCommandPaletteModal extends SuggestModal<Match> implements UnsafeSuggestModalInterface {
    // Unsafe interface
    chooser: UnsafeSuggestModalInterface['chooser'];

    updateSuggestions: UnsafeSuggestModalInterface['updateSuggestions'];

    plugin: BetterCommandPalettePlugin;

    actionType: ActionType;

    suggestionsWorker: Worker;

    currentSuggestions: Match[];

    lastQuery: string;

    modalTitleEl: HTMLElement;

    hiddenItemsHeaderEl: HTMLElement;

    showHiddenItems: boolean;

    initialInputValue: string;

    commandAdapter: BetterCommandPaletteCommandAdapter;

    fileAdapter: BetterCommandPaletteFileAdapter;

    tagAdapter: BetterCommandPaletteTagAdapter;

    omnisearchAdapter: BetterCommandPaletteOmnisearchAdapter;

    currentAdapter: SuggestModalAdapter;

    suggestionLimit: number;

    constructor (
        app: App,
        prevCommands: OrderedSet<Match>,
        prevTags: OrderedSet<Match>,
        plugin: BetterCommandPalettePlugin,
        suggestionsWorker: Worker,
        initialInputValue = '',
    ) {
        super(app);

        this.suggestionLimit = plugin.settings.suggestionLimit;
        this.initialInputValue = initialInputValue;

        this.plugin = plugin;

        this.modalEl.addClass('better-command-palette');

        this.setPlaceholder('Search commands, files, and tags...');

        // Set up sub-adapters
        this.commandAdapter = new BetterCommandPaletteCommandAdapter(
            app,
            prevCommands,
            plugin,
            this,
        );
        this.fileAdapter = new BetterCommandPaletteFileAdapter(
            app,
            new OrderedSet<Match>(),
            plugin,
            this,
        );
        this.tagAdapter = new BetterCommandPaletteTagAdapter(
            app,
            prevTags,
            plugin,
            this,
        );

        // Set up the omnisearch adapter
        this.omnisearchAdapter = new BetterCommandPaletteOmnisearchAdapter(
            app,
            new OrderedSet<Match>(),
            plugin,
            this,
        );
        this.omnisearchAdapter.setSubAdapters(
            this.commandAdapter,
            this.fileAdapter,
            this.tagAdapter,
        );

        this.currentAdapter = this.omnisearchAdapter;
        this.actionType = ActionType.Omnisearch;

        // Lets us do the suggestion fuzzy search in a different thread
        this.suggestionsWorker = suggestionsWorker;
        this.suggestionsWorker.onmessage = (msg: MessageEvent) => this.receivedSuggestions(msg);

        // Add our custom title element
        this.modalTitleEl = createEl('p', {
            cls: 'better-command-palette-title',
        });

        // Initialize and mount the omnisearch adapter
        this.updateActionType();
        this.currentAdapter.mount();

        // Add in the title element
        this.modalEl.insertBefore(this.modalTitleEl, this.modalEl.firstChild);

        this.hiddenItemsHeaderEl = createEl('p', 'hidden-items-header');
        this.showHiddenItems = false;

        this.hiddenItemsHeaderEl.onClickEvent(this.toggleHiddenItems);

        this.modalEl.insertBefore(this.hiddenItemsHeaderEl, this.resultContainerEl);

        // Set our scopes for the modal
        this.setScopes(plugin);
    }

    close (evt?: KeyboardEvent) {
        super.close();

        if (evt) {
            evt.preventDefault();
        }
    }

    setScopes (plugin: BetterCommandPalettePlugin) {
        const closeModal = (event: KeyboardEvent) => {
            const el = event.target as HTMLInputElement;

            if (plugin.settings.closeWithBackspace && el.value === '') {
                this.close(event);
            }
        };

        const { openInNewTabMod, createNewFileMod } = plugin.settings;

        this.scope.register([], 'Backspace', (event: KeyboardEvent) => {
            closeModal(event);
        });

        this.scope.register(['Mod'], 'Backspace', (event: KeyboardEvent) => {
            closeModal(event);
        });

        this.scope.register([createNewFileMod], 'Enter', (event: KeyboardEvent) => {
            if (this.omnisearchAdapter.activeFilter === 'file') {
                this.fileAdapter.onChooseSuggestion(null, event);
                this.close(event);
            }
        });

        this.scope.register([createNewFileMod, openInNewTabMod], 'Enter', (event: KeyboardEvent) => {
            if (this.omnisearchAdapter.activeFilter === 'file') {
                this.fileAdapter.onChooseSuggestion(null, event);
                this.close(event);
            }
        });

        this.scope.register([openInNewTabMod], 'Enter', (event: KeyboardEvent) => {
            if (this.currentSuggestions.length) {
                const promptResults = document.querySelector(".better-command-palette .prompt-results");
                const selected = document.querySelector(".better-command-palette .is-selected");
                const selectedIndex = Array.from(promptResults.children).indexOf(selected);
                const match = this.currentSuggestions[selectedIndex];
                if (match?.category === 'file') {
                    this.fileAdapter.onChooseSuggestion(match, event);
                    this.close(event);
                }
            }
        });

        this.scope.register(['Mod'], 'I', this.toggleHiddenItems);
    }

    toggleHiddenItems = () => {
        this.showHiddenItems = !this.showHiddenItems;
        this.updateSuggestions();
    };

    onOpen () {
        super.onOpen();

        if (this.initialInputValue) {
            this.setQuery(this.initialInputValue);
        }
    }

    changeActionType (actionType: ActionType) {
        let prefix = '';
        if (actionType === ActionType.Files) {
            prefix = this.plugin.settings.fileSearchPrefix;
        } else if (actionType === ActionType.Tags) {
            prefix = this.plugin.settings.tagSearchPrefix;
        } else if (actionType === ActionType.Commands) {
            prefix = this.plugin.settings.commandSearchPrefix;
        }
        const currentQuery: string = this.inputEl.value;
        const cleanQuery = this.currentAdapter.cleanQuery(currentQuery);

        this.inputEl.value = prefix + cleanQuery;
        this.updateSuggestions();
    }

    setQuery (
        newQuery: string,
        cursorPosition: number = -1,
    ) {
        this.inputEl.value = newQuery;

        if (cursorPosition > -1) {
            this.inputEl.setSelectionRange(cursorPosition, cursorPosition);
        }

        this.updateSuggestions();
    }

    updateActionType (): boolean {
        // The omnisearch adapter handles its own filter detection
        const query = this.inputEl.value;
        const filterChanged = this.omnisearchAdapter.updateFilter(query);

        const filter = this.omnisearchAdapter.activeFilter;
        this.modalEl.setAttribute("palette-mode", filter || "omnisearch");

        if (!this.currentAdapter) {
            this.currentAdapter = this.omnisearchAdapter;
        }

        if (!this.currentAdapter.initialized) {
            this.currentAdapter.initialize();
        }

        if (filterChanged) {
            this.updateEmptyStateText();
            this.updateTitleText();
            this.updateInstructions();
            this.currentSuggestions = this.currentAdapter
                .getSortedItems()
                .slice(0, this.suggestionLimit);
        }

        return filterChanged;
    }

    updateTitleText () {
        if (this.plugin.settings.showPluginName) {
            this.modalTitleEl.setText(this.currentAdapter.getTitleText());
        } else {
            this.modalTitleEl.setText('');
        }
    }

    updateEmptyStateText () {
        this.emptyStateText = this.currentAdapter.getEmptyStateText();
    }

    updateInstructions () {
        Array.from(this.modalEl.getElementsByClassName('prompt-instructions'))
            .forEach((instruction) => {
                this.modalEl.removeChild(instruction);
            });

        this.setInstructions([
            ...this.currentAdapter.getInstructions(),
            { command: generateHotKeyText({ modifiers: [], key: 'ESC' }, this.plugin.settings), purpose: 'Close palette' },
            { command: generateHotKeyText({ modifiers: ['Mod'], key: 'I' }, this.plugin.settings), purpose: 'Toggle Hidden Items' },
        ]);
    }

    getItems (): Match[] {
        return this.currentAdapter.getSortedItems();
    }

    receivedSuggestions (msg: MessageEvent) {
        const results = [];
        let hiddenCount = 0;

        for (
            let i = 0;
            i < msg.data.length && results.length < this.suggestionLimit + hiddenCount;
            i += 1
        ) {
            results.push(msg.data[i]);

            if (this.currentAdapter.hiddenIds.includes(msg.data[i].id)) {
                hiddenCount += 1;
            }
        }

        const matches = results.map((r: Match) => new PaletteMatch(r.id, r.text, r.tags, r.category));

        // Sort the suggestions so that previously searched items are first
        const prevItems = this.currentAdapter.getPrevItems();
        matches.sort((a, b) => (+prevItems.has(b)) - (+prevItems.has(a)));

        this.currentSuggestions = matches;
        this.limit = this.currentSuggestions.length;
        this.updateSuggestions();
    }

    getSuggestionsAsync (query: string) {
        const items = this.getItems();
        this.suggestionsWorker.postMessage({
            query,
            items,
        });
    }

    getSuggestions (query: string): Match[] {
        this.updateActionType();

        const getNewSuggestions = query !== this.lastQuery;
        this.lastQuery = query;
        const fixedQuery = this.currentAdapter.cleanQuery(query.trim());

        if (getNewSuggestions) {
            this.getSuggestionsAsync(fixedQuery);
        }

        const visibleItems = this.currentSuggestions.filter(
            (match) => !this.currentAdapter.hiddenIds.includes(match.id),
        );

        const hiddenItemCount = this.currentSuggestions.length - visibleItems.length;

        this.updateHiddenItemCountHeader(hiddenItemCount);

        return this.showHiddenItems ? this.currentSuggestions : visibleItems;
    }

    updateHiddenItemCountHeader (hiddenItemCount: number) {
        this.hiddenItemsHeaderEl.empty();

        if (hiddenItemCount !== 0) {
            const text = `${this.showHiddenItems ? 'Hide' : 'Show'} hidden items (${hiddenItemCount})`;
            this.hiddenItemsHeaderEl.setText(text);
        }
    }

    renderSuggestion (match: Match, el: HTMLElement) {
        el.addClass('mod-complex');

        const isHidden = this.currentAdapter.hiddenIds.includes(match.id);

        if (isHidden) {
            el.addClass('hidden');
        }

        const icon = 'cross';

        // Add category icon directly on the item element, before suggestion-content
        if (match.category) {
            const iconEl = el.createEl('span', {
                cls: `suggestion-category-icon category-${match.category}`,
            });
            setIcon(iconEl, match.category === 'command' ? 'terminal'
                : match.category === 'file' ? 'document' : 'hashtag', 16);
        }

        const suggestionContent = el.createEl('span', 'suggestion-content');
        const suggestionAux = el.createEl('span', 'suggestion-aux');

        const flairContainer = suggestionAux.createEl('span', 'suggestion-flair');
        renderPrevItems(this.plugin.settings, match, suggestionContent, this.currentAdapter.getPrevItems());

        setIcon(flairContainer, icon, 13);
        flairContainer.ariaLabel = isHidden ? 'Click to Unhide' : 'Click to Hide';
        flairContainer.setAttr('data-id', match.id);

        flairContainer.onClickEvent((event) => {
            event.preventDefault();
            event.stopPropagation();

            const hideEl = event.target as HTMLElement;

            this.currentAdapter.toggleHideId(hideEl.getAttr('data-id'));
        });

        this.currentAdapter.renderSuggestion(match, suggestionContent, suggestionAux);
    }

    async onChooseSuggestion (item: Match, event: MouseEvent | KeyboardEvent) {
        this.currentAdapter.onChooseSuggestion(item, event);
    }
}

export default BetterCommandPaletteModal;
