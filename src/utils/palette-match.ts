import { Match, MatchCategory } from 'src/types/types';

export default class PaletteMatch implements Match {
    id: string;

    text: string;

    tags: string[];

    category?: MatchCategory;

    constructor(id: string, text: string, tags: string[] = [], category?: MatchCategory) {
        this.id = id;
        this.text = text;
        this.tags = tags;
        this.category = category;
    }

    value(): string {
        return this.id;
    }
}
