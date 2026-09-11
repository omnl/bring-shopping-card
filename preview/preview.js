import '../dist/bring-shopping-card.js';

const lists = [
  { uuid: 'weekly-shop', name: 'Wocheneinkauf' },
  { uuid: 'dinner-party', name: 'Abendessen mit Freunden' },
];

const item = (name, icon, category, specification = '') => ({
  name,
  originalName: name,
  specification,
  icon,
  imageUrl: null,
  category,
});

const data = {
  'weekly-shop': {
    purchase: [
      item('Milch', '🥛', 'Milchprodukte', '2 Liter'),
      item('Bananen', '🍌', 'Obst & Gemüse'),
      item('Vollkornbrot', '🍞', 'Bäckerei'),
      item('Pasta', '🍝', 'Vorräte'),
    ],
    recently: [item('Kaffee', '☕', 'Getränke'), item('Eier', '🥚', 'Milchprodukte')],
    available: [
      item('Avocado', '🥑', 'Obst & Gemüse'), item('Tomaten', '🍅', 'Obst & Gemüse'),
      item('Mozzarella', '🧀', 'Milchprodukte'), item('Mineralwasser', '💧', 'Getränke'),
    ],
  },
  'dinner-party': {
    purchase: [item('Baguette', '🥖', 'Bäckerei'), item('Rotwein', '🍷', 'Getränke'), item('Oliven', '🫒', 'Vorräte')],
    recently: [item('Zitronen', '🍋', 'Obst & Gemüse')],
    available: [item('Hummus', '🫓', 'Vorräte'), item('Trauben', '🍇', 'Obst & Gemüse')],
  },
};

const clone = value => structuredClone(value);

const hass = {
  language: 'de',
  locale: { language: 'de' },
  themes: { darkMode: false },
  connection: { subscribeMessage: async () => () => {} },
  async callWS(message) {
    if (message.type === 'bring_shopping/get_lists') return { lists: clone(lists) };

    const list = data[message.list_uuid];
    if (!list) throw new Error('Unbekannte Demo-Liste');
    if (message.type === 'bring_shopping/get_items') {
      return { listUuid: message.list_uuid, name: lists.find(({ uuid }) => uuid === message.list_uuid).name, ...clone(list) };
    }
    if (message.type === 'bring_shopping/add_item') {
      const newItem = item(message.item_name, '🛒', 'Sonstiges', message.specification || '');
      newItem.originalName = message.original_name || message.item_name;
      list.purchase.push(newItem);
      return { success: true };
    }
    if (message.type === 'bring_shopping/complete_item') {
      const index = list.purchase.findIndex(({ originalName }) => originalName === message.original_name);
      if (index >= 0) list.recently.unshift(list.purchase.splice(index, 1)[0]);
      return { success: true };
    }
    if (message.type === 'bring_shopping/remove_item') {
      const index = list.purchase.findIndex(({ originalName }) => originalName === message.original_name);
      if (index >= 0) list.purchase.splice(index, 1);
      return { success: true };
    }
    if (message.type === 'bring_shopping/update_item') {
      const current = list.purchase.find(({ originalName }) => originalName === message.original_name);
      if (current) current.specification = message.specification;
      return { success: true };
    }
    throw new Error(`Nicht unterstützte Demo-Anfrage: ${message.type}`);
  },
};

const card = document.createElement('bring-shopping-card');
card.hass = hass;
card.setConfig({
  type: 'custom:bring-shopping-card',
  show_recently: true,
  show_available: true,
  max_quick_items: 8,
  card_size: 'medium',
  sort_default: 'manual',
  card_id: 'browser-preview',
});
document.querySelector('#card').append(card);

document.querySelector('.theme-toggle').addEventListener('click', event => {
  const dark = document.body.classList.toggle('dark');
  hass.themes.darkMode = dark;
  card.hass = { ...hass };
  event.currentTarget.textContent = dark ? 'Helles Theme' : 'Dunkles Theme';
});

document.querySelectorAll('.size-switch button').forEach(button => {
  button.addEventListener('click', () => {
    const cardSize = button.dataset.size;
    card.setConfig({ ...card.config, card_size: cardSize });
    document.querySelectorAll('.size-switch button').forEach(control => {
      control.classList.toggle('active', control === button);
    });
  });
});
