import { fuzzyFilter, getKeybindings, Input, SelectList, type Component, type Focusable, type SelectItem, type SelectListTheme } from "@mariozechner/pi-tui";

export interface SearchableSelectOptions {
  searchLabel?: string;
  emptyLabel?: string;
}

/** A visible fuzzy-search field composed with pi-tui's keyboard SelectList. */
export class SearchableSelect implements Component, Focusable {
  readonly #input = new Input();
  #list: SelectList;
  #filtered: SelectItem[];
  #focused = false;
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;

  constructor(readonly items: SelectItem[], readonly maxVisible: number, readonly theme: SelectListTheme, readonly options: SearchableSelectOptions = {}) {
    this.#filtered = items;
    this.#list = this.#createList(items);
  }

  get focused(): boolean { return this.#focused; }
  set focused(value: boolean) { this.#focused = value; this.#input.focused = value; }
  get query(): string { return this.#input.getValue(); }
  get resultCount(): number { return this.#filtered.length; }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down") || keys.matches(data, "tui.select.confirm")) { this.#list.handleInput(data); return; }
    if (keys.matches(data, "tui.select.cancel")) {
      if (this.query) { this.#input.setValue(""); this.#refresh(); }
      else this.onCancel?.();
      return;
    }
    this.#input.handleInput(data);
    this.#refresh();
  }

  render(width: number): string[] {
    const label = this.options.searchLabel ?? "Search";
    const status = this.query ? `${this.resultCount}/${this.items.length} matches · Esc clears` : `${this.items.length} options · type to search`;
    return [`  ${label}  ${this.theme.scrollInfo(status)}`, ...this.#input.render(width), "", ...this.#list.render(width)];
  }

  invalidate(): void { this.#input.invalidate(); this.#list.invalidate(); }

  #refresh(): void {
    this.#filtered = fuzzyFilter(this.items, this.query, (item) => `${item.label} ${item.value} ${item.description ?? ""}`);
    this.#list = this.#createList(this.#filtered);
  }

  #createList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, this.maxVisible, { ...this.theme, noMatch: () => this.theme.noMatch(`  ${this.options.emptyLabel ?? "No matches"}${this.query ? ` for “${this.query}”` : ""} · Esc clears`) });
    list.onSelect = (item) => this.onSelect?.(item);
    list.onCancel = () => this.onCancel?.();
    return list;
  }
}
