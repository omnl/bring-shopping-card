/**
 * Bring! Shopping Card for Home Assistant
 * A beautiful, modern shopping list card
 */

import { LitElement, html, css, nothing, TemplateResult, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { cardStyles } from './styles';
import { localize } from './localize';
import type {
  BringCardConfig,
  BringItem,
  BringList,
  CardSize,
  HomeAssistant,
  SortMode,
  WsItemsResponse,
  WsListsResponse,
} from './types';

// Storage keys
const STORAGE_PREFIX = 'bring-shopping-card';
const getStorageKey = (key: string, cardId?: string) =>
  `${STORAGE_PREFIX}-${key}${cardId ? `-${cardId}` : ''}`;

// Config Editor Element
@customElement('bring-shopping-card-editor')
export class BringShoppingCardEditor extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @state() private _config!: BringCardConfig;

  static styles = css`
    .editor {
      padding: 16px;
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 0;
      border-bottom: 1px solid var(--divider-color, rgba(0,0,0,0.12));
    }
    .row:last-child {
      border-bottom: none;
    }
    .label {
      font-weight: 500;
    }
    .description {
      font-size: 12px;
      color: var(--secondary-text-color);
      margin-top: 4px;
    }
    ha-switch {
      --mdc-theme-secondary: var(--primary-color);
    }
    input[type="number"] {
      width: 60px;
      padding: 8px;
      border: 1px solid var(--divider-color);
      border-radius: 4px;
      background: var(--card-background-color);
      color: var(--primary-text-color);
    }
  `;

  setConfig(config: BringCardConfig): void {
    this._config = config;
  }

  private _valueChanged(key: string, value: unknown): void {
    if (!this._config) return;

    const newConfig = { ...this._config, [key]: value };
    const event = new CustomEvent('config-changed', {
      detail: { config: newConfig },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  private _t(key: Parameters<typeof localize>[1]): string {
    return localize(this.hass?.locale?.language ?? this.hass?.language, key);
  }

  protected render(): TemplateResult {
    if (!this._config) {
      return html``;
    }

    return html`
      <div class="editor">
        <div class="row">
          <div>
            <div class="label">${this._t('show_quick_add')}</div>
            <div class="description">${this._t('show_quick_add_description')}</div>
          </div>
          <ha-switch
            .checked=${this._config.show_recently ?? false}
            @change=${(e: Event) => this._valueChanged('show_recently', (e.target as HTMLInputElement).checked)}
          ></ha-switch>
        </div>

        <div class="row">
          <div>
            <div class="label">${this._t('show_all_items')}</div>
            <div class="description">${this._t('show_all_items_description')}</div>
          </div>
          <ha-switch
            .checked=${this._config.show_available ?? false}
            @change=${(e: Event) => this._valueChanged('show_available', (e.target as HTMLInputElement).checked)}
          ></ha-switch>
        </div>

        <div class="row">
          <div>
            <div class="label">${this._t('max_quick_add_items')}</div>
            <div class="description">${this._t('max_quick_add_items_description')}</div>
          </div>
          <input
            type="number"
            min="4"
            max="24"
            .value=${String(this._config.max_quick_items ?? 12)}
            @change=${(e: Event) => this._valueChanged('max_quick_items', parseInt((e.target as HTMLInputElement).value) || 12)}
          />
        </div>

        <div class="row">
          <div>
            <div class="label">${this._t('card_size')}</div>
            <div class="description">${this._t('card_size_description')}</div>
          </div>
          <select
            @change=${(e: Event) => this._valueChanged('card_size', (e.target as HTMLSelectElement).value)}
            style="padding: 8px; border: 1px solid var(--divider-color); border-radius: 4px; background: var(--card-background-color); color: var(--primary-text-color);"
          >
            <option value="small" ?selected=${(this._config.card_size ?? 'medium') === 'small'}>${this._t('small')}</option>
            <option value="medium" ?selected=${(this._config.card_size ?? 'medium') === 'medium'}>${this._t('medium')}</option>
            <option value="large" ?selected=${(this._config.card_size ?? 'medium') === 'large'}>${this._t('large')}</option>
          </select>
        </div>
      </div>
    `;
  }
}

@customElement('bring-shopping-card')
export class BringShoppingCard extends LitElement {
  static styles = cardStyles;

  @property({ attribute: false }) public hass!: HomeAssistant;
  @property({ attribute: false }) public config!: BringCardConfig;

  @state() private _lists: BringList[] = [];
  @state() private _selectedListUuid: string | null = null;
  @state() private _items: BringItem[] = [];
  @state() private _recentItems: BringItem[] = [];
  @state() private _availableItems: BringItem[] = [];
  @state() private _sortBy: SortMode = 'manual';
  @state() private _customOrder: string[] = [];
  @state() private _searchQuery = '';
  @state() private _selectedSuggestion = -1;
  @state() private _loading = true;
  @state() private _error: string | null = null;
  @state() private _editingItem: BringItem | null = null;
  @state() private _showSortMenu = false;
  @state() private _showListDropdown = false;
  @state() private _showSuggestions = false;
  @state() private _confirmClear = false;

  private _failedImages = new Set<string>();
  private _pendingCompletions = new Set<string>();
  private _pendingCompletionItems = new Map<string, BringItem>();
  private _pendingAdditions = new Map<string, BringItem>();
  private _pendingSpecifications = new Map<string, string>();
  private _refreshInterval?: number;
  private _fetchSequence = 0;
  private _suppressCardClickUntil = 0;
  // Stable per-card key for persisting state (selected list, sort, order).
  // Must NOT be random, or nothing survives a page reload. Set from config so
  // multiple cards on one dashboard can be disambiguated via `card_id`.
  private _cardKey = 'default';
  private _stateLoaded = false;
  private _draggedItem: BringItem | null = null;

  private _t(
    key: Parameters<typeof localize>[1],
    replacements: Record<string, string | number> = {}
  ): string {
    return localize(this.hass?.locale?.language ?? this.hass?.language, key, replacements);
  }

  public setConfig(config: BringCardConfig): void {
    if (!config) {
      throw new Error('Invalid configuration');
    }
    const nextCardKey = config.card_id || 'default';
    const cardKeyChanged = nextCardKey !== this._cardKey;
    this.config = {
      show_recently: false,
      show_available: false,
      max_quick_items: 12,
      sort_default: 'manual',
      card_size: 'medium',
      ...config,
    };
    this._cardKey = nextCardKey;
    if (!this._stateLoaded) {
      this._sortBy = this.config.sort_default || 'manual';
    } else if (cardKeyChanged) {
      this._sortBy = this.config.sort_default || 'manual';
      this._customOrder = [];
      this._loadSavedState();
    }
    // Set data attribute for CSS size variants
    this.dataset.size = this.config.card_size || 'medium';
  }

  protected updated(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has('hass')) {
      this.dataset.theme = this.hass?.themes?.darkMode ? 'dark' : 'light';
    }
  }

  public static getConfigElement(): HTMLElement {
    return document.createElement('bring-shopping-card-editor');
  }

  public static getStubConfig(): BringCardConfig {
    return {
      type: 'custom:bring-shopping-card',
    };
  }

  public getCardSize(): number {
    return 5;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this._loadSavedState();
    this._stateLoaded = true;
    this._fetchLists();
    this._startAutoRefresh();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._stopAutoRefresh();
  }

  private _loadSavedState(): void {
    try {
      const savedList = localStorage.getItem(getStorageKey('list', this._cardKey));
      if (savedList) this._selectedListUuid = savedList;

      const savedSort = localStorage.getItem(getStorageKey('sort', this._cardKey));
      if (savedSort) this._sortBy = savedSort as SortMode;

      const orderKey = this._selectedListUuid ? `order-${this._selectedListUuid}` : 'order';
      const savedOrder = localStorage.getItem(getStorageKey(orderKey, this._cardKey))
        || localStorage.getItem(getStorageKey('order', this._cardKey));
      if (savedOrder) this._customOrder = JSON.parse(savedOrder);

    } catch (e) {
      console.error('Failed to load saved state:', e);
    }
  }

  private _saveState(): void {
    try {
      if (this._selectedListUuid) {
        localStorage.setItem(getStorageKey('list', this._cardKey), this._selectedListUuid);
      }
      localStorage.setItem(getStorageKey('sort', this._cardKey), this._sortBy);
      if (this._selectedListUuid) {
        localStorage.setItem(
          getStorageKey(`order-${this._selectedListUuid}`, this._cardKey),
          JSON.stringify(this._customOrder)
        );
      }
    } catch (e) {
      console.error('Failed to save state:', e);
    }
  }

  private async _fetchLists(): Promise<void> {
    try {
      const response = await this.hass.callWS<WsListsResponse>({
        type: 'bring_shopping/get_lists',
      });
      this._lists = response.lists;

      if (this._lists.length > 0) {
        if (!this._selectedListUuid || !this._lists.find(l => l.uuid === this._selectedListUuid)) {
          this._selectedListUuid = this._lists[0].uuid;
        }
        await this._fetchItems();
        void this._fetchItems(true);
      } else {
        this._loading = false;
        this._error = this._t('no_shopping_lists');
      }
    } catch (err) {
      console.error('Failed to fetch lists:', err);
      this._loading = false;
      this._error = this._t('failed_to_connect');
    }
  }

  private _isItemPending(item: BringItem, listUuid = this._selectedListUuid): boolean {
    if (!listUuid) return false;
    const key = `${listUuid}:${item.originalName}`;
    return this._pendingCompletions.has(key)
      || this._pendingAdditions.has(key)
      || this._pendingSpecifications.has(key);
  }

  private _invalidateFetchesFor(listUuid: string): void {
    if (this._selectedListUuid === listUuid) this._fetchSequence += 1;
  }

  private async _fetchItems(forceCloud = false): Promise<void> {
    if (!this._selectedListUuid) return;
    const listUuid = this._selectedListUuid;
    const sequence = ++this._fetchSequence;

    try {
      const response = await this.hass.callWS<WsItemsResponse>({
        type: forceCloud ? 'bring_shopping/refresh_items' : 'bring_shopping/get_items',
        list_uuid: listUuid,
      });

      if (sequence !== this._fetchSequence || listUuid !== this._selectedListUuid) return;

      let items = response.purchase;
      const visibleItemNames = new Set(items.map(item => item.originalName));

      for (const [key, item] of [...this._pendingAdditions]) {
        if (!key.startsWith(`${listUuid}:`)) continue;
        // A later completion wins over an in-flight addition of the same item.
        // Never let an old add response resurrect a just-completed item.
        if (this._pendingCompletions.has(key)) {
          this._pendingAdditions.delete(key);
          continue;
        }
        if (!visibleItemNames.has(item.originalName)) {
          items = [...items, item];
        }
      }

      items = items.map(item => {
        const key = `${listUuid}:${item.originalName}`;
        const specification = this._pendingSpecifications.get(key);
        if (specification === undefined) return item;
        return { ...item, specification };
      });

      let recently = response.recently.filter(
        item => !this._pendingAdditions.has(`${listUuid}:${item.originalName}`)
      );
      let available = response.available.filter(
        item => !this._pendingAdditions.has(`${listUuid}:${item.originalName}`)
      );
      for (const [key, item] of this._pendingCompletionItems) {
        if (!key.startsWith(`${listUuid}:`)) continue;
        if (!recently.some(current => current.originalName === item.originalName)) recently = [item, ...recently];
        if (!available.some(current => current.originalName === item.originalName)) available = [item, ...available];
      }

      this._items = items;
      this._recentItems = recently;
      this._availableItems = available;
      this._loading = false;
      this._error = null;
    } catch (err) {
      console.error('Failed to fetch items:', err);
      this._loading = false;
      if (forceCloud) {
        this._showToast(this._t('failed_to_load_list'), 'error');
        return;
      }
      if (this._items.length === 0) {
        this._error = this._t('failed_to_load_list');
      } else {
        this._showToast(this._t('failed_to_load_list'), 'error');
      }
    }
  }

  private _startAutoRefresh(): void {
    if (this._refreshInterval) return;
    this._refreshInterval = window.setInterval(() => {
      if (!document.hidden) {
        this._fetchItems();
      }
    }, 60000);
  }

  private _stopAutoRefresh(): void {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = undefined;
    }
  }

  private _getSortedItems(): BringItem[] {
    const items = [...this._items];

    switch (this._sortBy) {
      case 'manual':
        const orderMap: Record<string, number> = {};
        this._customOrder.forEach((name, idx) => (orderMap[name] = idx));
        return items.sort((a, b) => {
          const orderA = orderMap[a.originalName] ?? 999;
          const orderB = orderMap[b.originalName] ?? 999;
          return orderA - orderB;
        });
      case 'alpha':
        return items.sort((a, b) => a.name.localeCompare(b.name));
      case 'category':
        return items.sort((a, b) => {
          const catA = a.category || 'ZZZ';
          const catB = b.category || 'ZZZ';
          if (catA !== catB) return catA.localeCompare(catB);
          return a.name.localeCompare(b.name);
        });
      case 'recent':
      default:
        return items;
    }
  }

  private _getFilteredSuggestions(): BringItem[] {
    if (!this._searchQuery.trim()) return [];

    const q = this._searchQuery.toLowerCase();
    const matches = this._availableItems.filter(
      item =>
        item.name.toLowerCase().includes(q) ||
        item.originalName.toLowerCase().includes(q)
    );

    const recentMatches = this._recentItems.filter(
      item =>
        (item.name.toLowerCase().includes(q) ||
          item.originalName.toLowerCase().includes(q)) &&
        !this._items.some(p => p.originalName === item.originalName)
    );

    const combined = [...matches];
    recentMatches.forEach(r => {
      if (!combined.some(c => c.originalName === r.originalName)) {
        combined.push(r);
      }
    });

    return combined.slice(0, 8);
  }

  private async _addItem(name: string, originalName?: string, specification = ''): Promise<void> {
    if (!name.trim() || !this._selectedListUuid) return;
    const listUuid = this._selectedListUuid;
    const itemName = name.trim();
    const canonicalName = originalName || itemName;
    const pendingKey = `${listUuid}:${canonicalName}`;
    if (
      this._pendingAdditions.has(pendingKey)
      || this._pendingCompletions.has(pendingKey)
      || this._pendingSpecifications.has(pendingKey)
    ) return;
    this._invalidateFetchesFor(listUuid);

    const sourceAvailableItem = this._availableItems.find(item => item.originalName === canonicalName);
    const sourceRecentItem = this._recentItems.find(item => item.originalName === canonicalName);
    const sourceItem = sourceAvailableItem || sourceRecentItem;
    const optimisticItem: BringItem = sourceItem
      ? { ...sourceItem, name: itemName, specification }
      : {
          name: itemName,
          originalName: canonicalName,
          specification,
          icon: '🛒',
          imageUrl: null,
          category: this._t('other'),
        };
    this._pendingAdditions.set(pendingKey, optimisticItem);
    this._items = [...this._items, optimisticItem];
    this._availableItems = this._availableItems.filter(item => item.originalName !== canonicalName);
    this._recentItems = this._recentItems.filter(item => item.originalName !== canonicalName);

    try {
      await this.hass.callWS({
        type: 'bring_shopping/add_item',
        list_uuid: listUuid,
        item_name: itemName,
        original_name: canonicalName,
        specification,
      });

      this._invalidateFetchesFor(listUuid);
      this._pendingAdditions.delete(pendingKey);
      this._items = this._items.map(item =>
        item.originalName === canonicalName ? { ...item, specification } : item
      );
      this._showToast(this._t('added', { name }), 'success');
    } catch (err) {
      console.error('Failed to add item:', err);
      this._invalidateFetchesFor(listUuid);
      this._pendingAdditions.delete(pendingKey);
      if (this._selectedListUuid === listUuid) {
        this._items = this._items.filter(item => item.originalName !== canonicalName);
        if (sourceAvailableItem && !this._availableItems.some(item => item.originalName === canonicalName)) {
          this._availableItems = [...this._availableItems, sourceAvailableItem];
        }
        if (sourceRecentItem && !this._recentItems.some(item => item.originalName === canonicalName)) {
          this._recentItems = [...this._recentItems, sourceRecentItem];
        }
      }
      this._showToast(this._t('failed_to_add'), 'error');
    }
  }

  private async _completeItem(item: BringItem): Promise<void> {
    if (!this._selectedListUuid) return;
    const listUuid = this._selectedListUuid;
    const pendingKey = `${listUuid}:${item.originalName}`;
    if (this._pendingCompletions.has(pendingKey)) return;
    this._invalidateFetchesFor(listUuid);

    const wasRecent = this._recentItems.some(current => current.originalName === item.originalName);
    const wasAvailable = this._availableItems.some(current => current.originalName === item.originalName);
    this._pendingCompletions.add(pendingKey);
    this._pendingCompletionItems.set(pendingKey, item);
    this._items = [...this._items];
    if (!this._recentItems.some(current => current.originalName === item.originalName)) {
      this._recentItems = [item, ...this._recentItems];
    }
    if (!this._availableItems.some(current => current.originalName === item.originalName)) {
      this._availableItems = [item, ...this._availableItems];
    }
    try {
      await this.hass.callWS({
        type: 'bring_shopping/complete_item',
        list_uuid: listUuid,
        original_name: item.originalName,
      });
      this._invalidateFetchesFor(listUuid);
      this._pendingCompletions.delete(pendingKey);
      this._pendingCompletionItems.delete(pendingKey);
      if (this._selectedListUuid === listUuid) {
        this._items = this._items.filter(current => current.originalName !== item.originalName);
      }
      this._showToast(this._t('done', { name: item.name }), 'success');
    } catch (err) {
      console.error('Failed to complete item:', err);
      this._invalidateFetchesFor(listUuid);
      this._pendingCompletions.delete(pendingKey);
      this._pendingCompletionItems.delete(pendingKey);
      if (this._selectedListUuid === listUuid) {
        this._items = [...this._items];
        if (!wasRecent) {
          this._recentItems = this._recentItems.filter(current => current.originalName !== item.originalName);
        }
        if (!wasAvailable) {
          this._availableItems = this._availableItems.filter(current => current.originalName !== item.originalName);
        }
      }
      this._showToast(this._t('failed_to_complete'), 'error');
    }
  }

  private async _clearList(): Promise<void> {
    if (!this._selectedListUuid || !this._items.length) return;
    if (!this._confirmClear) {
      this._confirmClear = true;
      window.setTimeout(() => (this._confirmClear = false), 4000);
      return;
    }
    this._confirmClear = false;
    const listUuid = this._selectedListUuid;
    const itemsToComplete = this._items;
    itemsToComplete.forEach(item => {
      const key = `${listUuid}:${item.originalName}`;
      this._pendingCompletions.add(key);
      this._pendingCompletionItems.set(key, item);
    });
    this._items = [...itemsToComplete];
    this._recentItems = [
      ...itemsToComplete.filter(item => !this._recentItems.some(current => current.originalName === item.originalName)),
      ...this._recentItems,
    ];
    this._availableItems = [
      ...itemsToComplete.filter(item => !this._availableItems.some(current => current.originalName === item.originalName)),
      ...this._availableItems,
    ];

    this._invalidateFetchesFor(listUuid);
    try {
      await this.hass.callWS({
        type: 'bring_shopping/complete_items',
        list_uuid: listUuid,
        items: itemsToComplete.map(item => item.originalName),
      });
      this._invalidateFetchesFor(listUuid);
      itemsToComplete.forEach(item => {
        const key = `${listUuid}:${item.originalName}`;
        this._pendingCompletions.delete(key);
        this._pendingCompletionItems.delete(key);
      });
      if (this._selectedListUuid === listUuid) {
        const completedNames = new Set(itemsToComplete.map(item => item.originalName));
        this._items = this._items.filter(item => !completedNames.has(item.originalName));
      }
    } catch (err) {
      console.error('Failed to clear list:', err);
      this._invalidateFetchesFor(listUuid);
      itemsToComplete.forEach(item => {
        const key = `${listUuid}:${item.originalName}`;
        this._pendingCompletions.delete(key);
        this._pendingCompletionItems.delete(key);
      });
      if (this._selectedListUuid === listUuid) {
        await this._fetchItems(true);
      }
      this._showToast(this._t('failed_to_remove'), 'error');
    }
  }

  private async _updateItemSpec(item: BringItem, newSpec: string): Promise<void> {
    if (!this._selectedListUuid) return;
    const listUuid = this._selectedListUuid;
    const pendingKey = `${listUuid}:${item.originalName}`;
    if (this._isItemPending(item, listUuid)) return;
    this._invalidateFetchesFor(listUuid);
    const previousSpec = item.specification;
    this._pendingSpecifications.set(pendingKey, newSpec);
    this._items = this._items.map(current =>
      current.originalName === item.originalName ? { ...current, specification: newSpec } : current
    );

    try {
      await this.hass.callWS({
        type: 'bring_shopping/update_item',
        list_uuid: listUuid,
        original_name: item.originalName,
        specification: newSpec,
      });

      this._invalidateFetchesFor(listUuid);
      this._pendingSpecifications.delete(pendingKey);
      this._items = [...this._items];
      this._showToast(this._t('updated'), 'success');
    } catch (err) {
      console.error('Failed to update item:', err);
      this._invalidateFetchesFor(listUuid);
      this._pendingSpecifications.delete(pendingKey);
      if (this._selectedListUuid === listUuid) {
        this._items = this._items.map(current =>
          current.originalName === item.originalName ? { ...current, specification: previousSpec } : current
        );
      }
      this._showToast(this._t('failed_to_update'), 'error');
    }
  }

  private _showToast(message: string, type: 'success' | 'error' = 'success'): void {
    const container = this.shadowRoot?.querySelector('.toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'toastOut 0.3s ease forwards';
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  private _handleInputKeydown(e: KeyboardEvent): void {
    const filtered = this._getFilteredSuggestions();
    const input = e.target as HTMLInputElement;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._selectedSuggestion = Math.min(this._selectedSuggestion + 1, filtered.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._selectedSuggestion = Math.max(this._selectedSuggestion - 1, -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this._selectedSuggestion >= 0 && filtered[this._selectedSuggestion]) {
        const item = filtered[this._selectedSuggestion];
        this._addItem(item.name, item.originalName);
        input.value = '';
        this._searchQuery = '';
        this._showSuggestions = false;
      } else if (input.value.trim()) {
        this._addItem(input.value);
        input.value = '';
        this._searchQuery = '';
        this._showSuggestions = false;
      }
    } else if (e.key === 'Escape') {
      this._showSuggestions = false;
    }
  }

  private _handleInputChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    this._searchQuery = input.value;
    this._showSuggestions = input.value.length > 0;
    this._selectedSuggestion = -1;
  }

  private _handleSuggestionClick(item: BringItem): void {
    this._addItem(item.name, item.originalName);
    const input = this.shadowRoot?.querySelector('.add-input') as HTMLInputElement;
    if (input) input.value = '';
    this._searchQuery = '';
    this._showSuggestions = false;
  }

  private _handleDragStart(e: DragEvent, item: BringItem): void {
    this._draggedItem = item;
    (e.target as HTMLElement).classList.add('dragging');
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', item.originalName);
  }

  private _handleDragEnd(e: DragEvent): void {
    (e.target as HTMLElement).classList.remove('dragging');
    this.shadowRoot?.querySelectorAll('.card.drag-over').forEach(el => {
      el.classList.remove('drag-over');
    });
    this._draggedItem = null;
    this._suppressCardClickUntil = Date.now() + 250;
  }

  private _handleDragOver(e: DragEvent): void {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
  }

  private _handleDragEnter(e: DragEvent, element: HTMLElement): void {
    element.classList.add('drag-over');
  }

  private _handleDragLeave(e: DragEvent, element: HTMLElement): void {
    element.classList.remove('drag-over');
  }

  private _handleDrop(e: DragEvent, targetItem: BringItem, element: HTMLElement): void {
    e.preventDefault();
    element.classList.remove('drag-over');

    if (!this._draggedItem || this._draggedItem.originalName === targetItem.originalName) return;

    const order = this._getSortedItems().map(item => item.originalName);
    const draggedName = this._draggedItem.originalName;
    const withoutDragged = order.filter(name => name !== draggedName);
    const targetIndex = withoutDragged.indexOf(targetItem.originalName);
    withoutDragged.splice(Math.max(0, targetIndex), 0, draggedName);
    this._customOrder = withoutDragged;

    if (this._sortBy !== 'manual') {
      this._sortBy = 'manual';
    }

    this._saveState();
  }

  private _selectList(list: BringList): void {
    this._selectedListUuid = list.uuid;
    try {
      const savedOrder = localStorage.getItem(
        getStorageKey(`order-${list.uuid}`, this._cardKey)
      );
      this._customOrder = savedOrder ? JSON.parse(savedOrder) : [];
    } catch {
      this._customOrder = [];
    }
    this._showListDropdown = false;
    this._loading = true;
    this._items = [];
    this._recentItems = [];
    this._availableItems = [];
    this._confirmClear = false;
    this._showSuggestions = false;
    this._searchQuery = '';
    this._saveState();
    void this._fetchItems().then(() => this._fetchItems(true));
  }

  private _renderImage(item: BringItem, size: 'large' | 'small'): TemplateResult {
    const imgClass = size === 'large' ? 'card-img' : 'quick-card-img';
    const initialClass = size === 'large' ? 'card-initial' : 'quick-card-initial';

    if (item.imageUrl && !this._failedImages.has(item.imageUrl)) {
      return html`
        <img
          class="${imgClass}"
          src="${item.imageUrl}"
          alt="${item.name}"
          @error=${(e: Event) => {
            this._failedImages.add(item.imageUrl!);
            this.requestUpdate();
          }}
        />
      `;
    }
    return html`<span class="${initialClass}" aria-hidden="true">${item.name.trim().charAt(0).toUpperCase() || '?'}</span>`;
  }

  private _renderHeader(): TemplateResult {
    const selectedList = this._lists.find(l => l.uuid === this._selectedListUuid);

    return html`
      <header class="header">
        <div class="header-actions">
          ${this._lists.length > 1
            ? html`
                <div class="list-selector-wrapper">
                  <button
                    class="header-btn list-btn ${this._showListDropdown ? 'open' : ''}"
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      e.preventDefault();
                      this._showListDropdown = !this._showListDropdown;
                      this._showSortMenu = false;
                    }}
                    title=${this._t('select_list')}
                  >
                    <span class="list-btn-text">${selectedList?.name || this._t('list')}</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                  </button>
                  ${this._showListDropdown
                    ? html`
                        <div class="list-dropdown open">
                          ${this._lists.map(
                            list => html`
                              <div
                                class="list-option ${list.uuid === this._selectedListUuid ? 'active' : ''}"
                                @mousedown=${(e: Event) => {
                                  e.stopPropagation();
                                  e.preventDefault();
                                  this._selectList(list);
                                }}
                              >
                                ${list.name}
                              </div>
                            `
                          )}
                        </div>
                      `
                    : nothing}
                </div>
              `
            : nothing}
          <div class="sort-dropdown">
            <button
              class="header-btn"
              @click=${(e: Event) => {
                e.stopPropagation();
                e.preventDefault();
                this._showSortMenu = !this._showSortMenu;
                this._showListDropdown = false;
              }}
              title=${this._t('sort')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="4" y1="6" x2="20" y2="6"></line>
                <line x1="4" y1="12" x2="14" y2="12"></line>
                <line x1="4" y1="18" x2="9" y2="18"></line>
              </svg>
            </button>
            ${this._showSortMenu
              ? html`
                  <div class="sort-menu open">
                    ${(['manual', 'alpha', 'category', 'recent'] as SortMode[]).map(
                      mode => html`
                        <div
                          class="sort-option ${this._sortBy === mode ? 'active' : ''}"
                          @mousedown=${(e: Event) => {
                            e.stopPropagation();
                            e.preventDefault();
                            this._sortBy = mode;
                            this._showSortMenu = false;
                            this._saveState();
                          }}
                        >
                          ${{
                            manual: this._t('manual_order'),
                            alpha: 'A-Z',
                            category: this._t('by_category'),
                            recent: this._t('recently_added'),
                          }[mode]}
                        </div>
                      `
                    )}
                  </div>
                `
              : nothing}
          </div>
          <button
            class="header-btn"
            @click=${async (e: Event) => {
              e.stopPropagation();
              const btn = e.currentTarget as HTMLElement;
              btn.classList.add('spinning');
              if (this._lists.length === 0) {
                await this._fetchLists();
              } else {
                await this._fetchItems(true);
              }
              btn.classList.remove('spinning');
            }}
            title=${this._t('refresh')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 12a9 9 0 11-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
              <path d="M21 3v5h-5"/>
            </svg>
          </button>
        </div>
      </header>
    `;
  }

  private _renderAddSection(): TemplateResult {
    const suggestions = this._getFilteredSuggestions();

    return html`
      <div class="add-section">
        <div class="add-input-wrapper">
          <input
            type="text"
            class="add-input"
            placeholder=${this._t('add_item_placeholder')}
            autocomplete="off"
            @input=${this._handleInputChange}
            @keydown=${this._handleInputKeydown}
            @blur=${() => setTimeout(() => (this._showSuggestions = false), 150)}
          />
          <div class="search-suggestions ${this._showSuggestions && suggestions.length ? 'open' : ''}">
            ${suggestions.map(
              (item, i) => html`
                <div
                  class="suggestion-item ${i === this._selectedSuggestion ? 'selected' : ''}"
                  @click=${() => this._handleSuggestionClick(item)}
                >
                  ${item.imageUrl && !this._failedImages.has(item.imageUrl)
                    ? html`
                        <img
                          class="suggestion-img"
                          src="${item.imageUrl}"
                          alt=""
                          @error=${() => {
                            this._failedImages.add(item.imageUrl!);
                            this.requestUpdate();
                          }}
                        />
                      `
                    : html`<span class="suggestion-initial" aria-hidden="true">${item.name.trim().charAt(0).toUpperCase() || '?'}</span>`}
                  <span class="suggestion-text">${item.name}</span>
                  ${item.category ? html`<span class="suggestion-category">${item.category}</span>` : nothing}
                </div>
              `
            )}
          </div>
        </div>
        <button
          class="add-btn"
          ?disabled=${!this._searchQuery.trim()}
          @click=${() => {
            const input = this.shadowRoot?.querySelector('.add-input') as HTMLInputElement;
            if (input?.value.trim()) {
              this._addItem(input.value);
              input.value = '';
              this._searchQuery = '';
            }
          }}
        >
          ${this._t('add')}
        </button>
      </div>
    `;
  }

  private _renderPurchaseItems(): TemplateResult {
    const sortedItems = this._getSortedItems();

    return html`
      <section class="section">
        <div class="section-header">
          <span class="section-title">${this._t('to_buy')}</span>
          <div class="section-actions">
            <span class="section-count">${this._items.length}</span>
            <button class="clear-list-btn ${this._confirmClear ? 'confirm' : ''}" @click=${this._clearList} ?disabled=${!this._items.length || this._items.some(item => this._isItemPending(item))}>
              ${this._confirmClear ? this._t('confirm_clear_list') : this._t('clear_list')}
            </button>
          </div>
        </div>
        ${this._items.length === 0
          ? html`
              <div class="empty-state">
                <div class="empty-icon">✨</div>
                <div class="empty-text">${this._t('list_empty')}</div>
                <div class="empty-sub">${this._t('empty_list_hint')}</div>
              </div>
            `
          : html`
              <div class="cards-grid">
                ${sortedItems.map(item => {
                  const pending = this._isItemPending(item);
                  return html`
                    <div
                      class="card ${pending ? 'pending' : ''}"
                      ?draggable=${!pending}
                      aria-busy=${pending ? 'true' : 'false'}
                      @click=${() => {
                        if (!pending && Date.now() >= this._suppressCardClickUntil) this._completeItem(item);
                      }}
                      @dragstart=${(e: DragEvent) => this._handleDragStart(e, item)}
                      @dragend=${this._handleDragEnd}
                      @dragover=${this._handleDragOver}
                      @dragenter=${(e: DragEvent) => this._handleDragEnter(e, e.currentTarget as HTMLElement)}
                      @dragleave=${(e: DragEvent) => this._handleDragLeave(e, e.currentTarget as HTMLElement)}
                      @drop=${(e: DragEvent) => this._handleDrop(e, item, e.currentTarget as HTMLElement)}
                    >
                      <div class="card-content">
                        <div class="card-row">${this._renderImage(item, 'large')}</div>
                        <span class="card-name">${item.name}</span>
                        <span
                          class="card-spec ${item.specification ? '' : 'empty'}"
                          @click=${(e: Event) => {
                            e.stopPropagation();
                            if (!pending) this._editingItem = item;
                          }}
                        >
                          ${item.specification || this._t('add_note')}
                        </span>
                        ${item.category ? html`<span class="card-category">${item.category}</span>` : nothing}
                      </div>
                      ${pending ? html`<span class="card-pending" aria-label="Wird synchronisiert"></span>` : nothing}
                    </div>
                  `;
                })}
              </div>
            `}
      </section>
    `;
  }

  private _renderQuickAdd(): TemplateResult | typeof nothing {
    if (!this.config.show_recently || this._recentItems.length === 0) return nothing;

    const quickItems = this._recentItems.slice(0, this.config.max_quick_items || 12);

    return html`
      <section class="section">
        <div class="section-header">
          <span class="section-title">${this._t('quick_add')}</span>
        </div>
        <div class="quick-grid">
          ${quickItems.map(
            item => html`
              <div
                class="quick-card ${this._isItemPending(item) ? 'pending' : ''}"
                @click=${(e: Event) => {
                  if (this._isItemPending(item)) return;
                  const el = e.currentTarget as HTMLElement;
                  el.classList.add('adding');
                  setTimeout(() => el.classList.remove('adding'), 300);
                  this._addItem(item.name, item.originalName, item.specification);
                }}
              >
                ${this._renderImage(item, 'small')}
                <span class="quick-card-name">${item.name}</span>
              </div>
            `
          )}
        </div>
      </section>
    `;
  }

  private _renderAvailableItems(): TemplateResult | typeof nothing {
    if (!this.config.show_available || this._availableItems.length === 0) return nothing;

    // Group by category
    const categories: Record<string, BringItem[]> = {};
    this._availableItems.forEach(item => {
      const cat = item.category || this._t('other');
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(item);
    });
    const sortedCategories = Object.keys(categories).sort();

    return html`
      <div class="divider"></div>
      <section class="section">
        <div class="section-header">
          <span class="section-title">${this._t('all_items')}</span>
          <span class="section-count">${this._availableItems.length}</span>
        </div>
        ${sortedCategories.map(
          cat => html`
            <div
              class="collapsible-header"
              @click=${(e: Event) => {
                const header = e.currentTarget as HTMLElement;
                header.classList.toggle('open');
                header.nextElementSibling?.classList.toggle('open');
              }}
            >
              <div class="collapsible-left">
                <span class="section-title" style="margin:0">${cat}</span>
                <span class="section-count">${categories[cat].length}</span>
              </div>
              <svg class="collapsible-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </div>
            <div class="collapsible-content">
              <div class="quick-grid" style="margin-bottom: 12px;">
                ${categories[cat].map(
                  item => html`
                    <div
                      class="quick-card ${this._isItemPending(item) ? 'pending' : ''}"
                      @click=${(e: Event) => {
                        if (this._isItemPending(item)) return;
                        const el = e.currentTarget as HTMLElement;
                        el.classList.add('adding');
                        setTimeout(() => el.classList.remove('adding'), 300);
                        this._addItem(item.name, item.originalName);
                      }}
                    >
                      ${this._renderImage(item, 'small')}
                      <span class="quick-card-name">${item.name}</span>
                    </div>
                  `
                )}
              </div>
            </div>
          `
        )}
      </section>
    `;
  }

  private _renderEditModal(): TemplateResult | typeof nothing {
    if (!this._editingItem) return nothing;

    return html`
      <div
        class="modal-overlay open"
        @click=${(e: Event) => {
          if (e.target === e.currentTarget) this._editingItem = null;
        }}
      >
        <div class="modal">
          <div class="modal-title">${this._t('edit', { name: this._editingItem.name })}</div>
          <input
            type="text"
            class="modal-input"
            placeholder=${this._t('specification_placeholder')}
            .value=${this._editingItem.specification || ''}
            @keypress=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                const input = e.target as HTMLInputElement;
                const editingItem = this._editingItem;
                if (!editingItem) return;
                this._updateItemSpec(editingItem, input.value.trim());
                this._editingItem = null;
              }
            }}
          />
          <div class="modal-actions">
            <button class="modal-btn cancel" @click=${() => (this._editingItem = null)}>${this._t('cancel')}</button>
            <button
              class="modal-btn save"
              @click=${() => {
                const input = this.shadowRoot?.querySelector('.modal-input') as HTMLInputElement;
                const editingItem = this._editingItem;
                if (!editingItem) return;
                this._updateItemSpec(editingItem, input.value.trim());
                this._editingItem = null;
              }}
            >
              ${this._t('save')}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  protected render(): TemplateResult {
    // Close dropdowns when clicking anywhere on card
    const closeDropdowns = (e: Event) => {
      // Don't close if clicking on dropdown elements
      const target = e.target as HTMLElement;
      if (target.closest('.list-selector-wrapper') || target.closest('.sort-dropdown')) {
        return;
      }
      this._showSortMenu = false;
      this._showListDropdown = false;
    };

    if (this._loading) {
      return html`
        <ha-card @click=${closeDropdowns}>
          <div class="container">
            ${this._renderHeader()}
            <div class="loading">
              <div class="loading-spinner"></div>
            </div>
          </div>
        </ha-card>
      `;
    }

    if (this._error) {
      return html`
        <ha-card @click=${closeDropdowns}>
          <div class="container">
            ${this._renderHeader()}
            <div class="error-state">
              <div class="error-icon">⚠️</div>
              <div class="error-text">${this._error}</div>
            </div>
          </div>
        </ha-card>
      `;
    }

    return html`
      <ha-card @click=${closeDropdowns}>
        <div class="container">
          ${this._renderHeader()}
          ${this._renderAddSection()}
          ${this._renderPurchaseItems()}
          ${this._renderQuickAdd()}
          ${this._renderAvailableItems()}
        </div>
        <div class="toast-container"></div>
        ${this._renderEditModal()}
      </ha-card>
    `;
  }
}

// Register with Home Assistant
declare global {
  interface HTMLElementTagNameMap {
    'bring-shopping-card': BringShoppingCard;
    'bring-shopping-card-editor': BringShoppingCardEditor;
  }
  interface Window {
    customCards: Array<{
      type: string;
      name: string;
      description: string;
      preview?: boolean;
    }>;
  }
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'bring-shopping-card',
  name: 'Bring! Shopping Card',
  description: 'A beautiful, modern shopping list card for Bring!',
  preview: true,
});
