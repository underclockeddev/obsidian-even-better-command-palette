import { Instruction, setIcon } from 'obsidian';
import {
    generateHotKeyText,
    OrderedSet,
    SuggestModalAdapter,
} from 'src/utils';
import { Match, MatchCategory, UnsafeAppInterface } from 'src/types/types';
import { ActionType } from 'src/utils/constants';
import BetterCommandPaletteCommandAdapter from './command-adapter';
import BetterCommandPaletteFileAdapter from './file-adapter';
import BetterCommandPaletteTagAdapter from './tag-adapter';

const CATEGORY_ICONS: Record<MatchCategory, string> = {
    command: 'terminal',
    file: 'document',
    tag: 'hashtag',
};

export default class BetterCommandPaletteOmnisearchAdapter extends SuggestModalAdapter {
    titleText: string;

    emptyStateText: string;

    app: UnsafeAppInterface;

    allItems: Match[];

    commandAdapter: BetterCommandPaletteCommandAdapter;

    fileAdapter: BetterCommandPaletteFileAdapter;

    tagAdapter: BetterCommandPaletteTagAdapter;

    activeFilter: MatchCategory | null;

    constructor(
        ...args: ConstructorParameters<typeof SuggestModalAdapter>
    ) {
        super(...args);
        this.activeFilter = null;
    }

    setSubAdapters(
        commandAdapter: BetterCommandPaletteCommandAdapter,
        fileAdapter: BetterCommandPaletteFileAdapter,
        tagAdapter: BetterCommandPaletteTagAdapter,
    ) {
        this.commandAdapter = commandAdapter;
        this.fileAdapter = fileAdapter;
        this.tagAdapter = tagAdapter;
    }

    initialize() {
        super.initialize();

        this.titleText = 'Better Command Palette';
        this.emptyStateText = 'No matching results.';

        // Merge hidden IDs from all categories
        this.hiddenIds = [
            ...this.plugin.settings.hiddenCommands,
            ...this.plugin.settings.hiddenFiles,
            ...this.plugin.settings.hiddenTags,
        ];
        this.hiddenIdsSettingsKey = 'hiddenCommands';

        // Initialize sub-adapters if needed
        if (!this.commandAdapter.initialized) this.commandAdapter.initialize();
        if (!this.fileAdapter.initialized) this.fileAdapter.initialize();
        if (!this.tagAdapter.initialized) this.tagAdapter.initialize();

        this.rebuildAllItems();
    }

    rebuildAllItems() {
        this.allItems = [
            ...this.commandAdapter.getItems(),
            ...this.fileAdapter.getItems(),
            ...this.tagAdapter.getItems(),
        ];
    }

    mount(): void {
        const { settings } = this.plugin;
        this.keymapHandlers = [
            this.palette.scope.register(['Mod'], settings.commandSearchHotkey, () => this.palette.changeActionType(ActionType.Commands)),
            this.palette.scope.register(['Mod'], settings.fileSearchHotkey, () => this.palette.changeActionType(ActionType.Files)),
            this.palette.scope.register(['Mod'], settings.tagSearchHotkey, () => this.palette.changeActionType(ActionType.Tags)),
        ];
    }

    getInstructions(): Instruction[] {
        const { settings } = this.plugin;
        const instructions: Instruction[] = [
            { command: generateHotKeyText({ modifiers: [], key: 'ENTER' }, settings), purpose: 'Select item' },
        ];

        if (this.activeFilter === 'file' || this.activeFilter === null) {
            instructions.push(
                { command: generateHotKeyText({ modifiers: [settings.openInNewTabMod], key: 'ENTER' }, settings), purpose: 'Open file in new pane' },
                { command: generateHotKeyText({ modifiers: [settings.createNewFileMod], key: 'ENTER' }, settings), purpose: 'Create file' },
            );
        }

        instructions.push(
            { command: generateHotKeyText({ modifiers: ['Mod'], key: settings.commandSearchHotkey }, settings), purpose: 'Filter Commands' },
            { command: generateHotKeyText({ modifiers: ['Mod'], key: settings.fileSearchHotkey }, settings), purpose: 'Filter Files' },
            { command: generateHotKeyText({ modifiers: ['Mod'], key: settings.tagSearchHotkey }, settings), purpose: 'Filter Tags' },
        );

        return instructions;
    }

    detectFilter(query: string): MatchCategory | null {
        const { fileSearchPrefix, tagSearchPrefix, commandSearchPrefix } = this.plugin.settings;

        if (query.startsWith(fileSearchPrefix)) return 'file';
        if (query.startsWith(tagSearchPrefix)) return 'tag';
        if (query.startsWith(commandSearchPrefix)) return 'command';
        return null;
    }

    cleanQuery(query: string): string {
        const { fileSearchPrefix, tagSearchPrefix, commandSearchPrefix } = this.plugin.settings;

        const filter = this.detectFilter(query);
        if (filter === 'file') return query.replace(fileSearchPrefix, '');
        if (filter === 'tag') return query.replace(tagSearchPrefix, '');
        if (filter === 'command') return query.replace(commandSearchPrefix, '');
        return query;
    }

    updateFilter(query: string): boolean {
        const newFilter = this.detectFilter(query);
        const changed = newFilter !== this.activeFilter;
        this.activeFilter = newFilter;
        return changed;
    }

    getItems(): Match[] {
        this.checkInitialized();

        if (!this.activeFilter) return this.allItems;

        return this.allItems.filter((item) => item.category === this.activeFilter);
    }

    getSortedItems(): Match[] {
        const filtered = this.getItems();
        const allItems = new OrderedSet(filtered);

        // Merge prev items from all sub-adapters
        const allPrevItems = [
            ...this.commandAdapter.getPrevItems().values(),
            ...this.fileAdapter.getPrevItems().values(),
            ...this.tagAdapter.getPrevItems().values(),
        ];

        const pinnedItems = this.getPinnedItems();

        const firstItems = this.recentAbovePinned ? allPrevItems : pinnedItems;
        const secondItems = !this.recentAbovePinned ? allPrevItems : pinnedItems;

        [secondItems, firstItems].forEach((toAdd) => {
            toAdd.forEach((item) => {
                if (allItems.has(item)) {
                    allItems.add(item);
                }
            });
        });

        return allItems.valuesByLastAdd();
    }

    getPinnedItems(): Match[] {
        return this.commandAdapter.getPinnedItems();
    }

    getPrevItems(): OrderedSet<Match> {
        // Return a merged ordered set for the receivedSuggestions sort
        const merged = new OrderedSet<Match>();
        this.commandAdapter.getPrevItems().values().forEach((m) => merged.add(m));
        this.fileAdapter.getPrevItems().values().forEach((m) => merged.add(m));
        this.tagAdapter.getPrevItems().values().forEach((m) => merged.add(m));
        return merged;
    }

    private getAdapterForMatch(match: Match): SuggestModalAdapter | null {
        switch (match.category) {
            case 'command': return this.commandAdapter;
            case 'file': return this.fileAdapter;
            case 'tag': return this.tagAdapter;
            default: return null;
        }
    }

    renderSuggestion(match: Match, content: HTMLElement, aux: HTMLElement): void {
        // Add category icon on the left edge
        if (match.category) {
            const iconEl = content.createEl('span', {
                cls: `suggestion-category-icon category-${match.category}`,
            });
            setIcon(iconEl, CATEGORY_ICONS[match.category], 13);
        }

        // Delegate to the appropriate sub-adapter for type-specific rendering
        const adapter = this.getAdapterForMatch(match);
        if (adapter) {
            adapter.renderSuggestion(match, content, aux);
        } else {
            content.createEl('span', {
                cls: 'suggestion-title',
                text: match.text,
            });
        }
    }

    async onChooseSuggestion(match: Match, event: MouseEvent | KeyboardEvent) {
        const adapter = this.getAdapterForMatch(match);
        if (adapter) {
            adapter.onChooseSuggestion(match, event);
        }
    }

    async toggleHideId(id: string) {
        // Find which sub-adapter owns this ID and delegate
        const commandMatch = this.commandAdapter.getItems().find((m) => m.id === id);
        if (commandMatch) {
            await this.commandAdapter.toggleHideId(id);
            this.hiddenIds = [
                ...this.plugin.settings.hiddenCommands,
                ...this.plugin.settings.hiddenFiles,
                ...this.plugin.settings.hiddenTags,
            ];
            return;
        }

        const fileMatch = this.fileAdapter.getItems().find((m) => m.id === id);
        if (fileMatch) {
            await this.fileAdapter.toggleHideId(id);
            this.hiddenIds = [
                ...this.plugin.settings.hiddenCommands,
                ...this.plugin.settings.hiddenFiles,
                ...this.plugin.settings.hiddenTags,
            ];
            return;
        }

        await this.tagAdapter.toggleHideId(id);
        this.hiddenIds = [
            ...this.plugin.settings.hiddenCommands,
            ...this.plugin.settings.hiddenFiles,
            ...this.plugin.settings.hiddenTags,
        ];
    }
}
