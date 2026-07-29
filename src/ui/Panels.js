/**
 * Inventory and container panels.
 *
 * Two lists side by side — what you are carrying, and what is in front of you —
 * because every looting decision is a comparison between those two things. A
 * single modal inventory would make the player memorise the container's contents
 * and then go somewhere else to decide.
 *
 * The weight readout is the point of the whole screen, so it is the largest
 * thing on it and it turns colour before it turns into a problem.
 */
import { events } from '../core/Events.js';
import { RECIPES, canCraft } from '../items/Recipes.js';
import { t } from './i18n.js';

export class Panels {
  /**
   * @param {import('../items/Container.js').Inventory} inventory
   * @param {HTMLElement} [root]
   */
  constructor(inventory, root = document.getElementById('hud')) {
    this.inventory = inventory;
    /** Set by main, so the crafting list can show what is and is not possible. */
    this.player = null;
    this.construction = null;
    /** @type {import('../items/Container.js').Container | null} */
    this.container = null;
    this.open = false;
    this.selection = 0;

    const el = document.createElement('div');
    el.id = 'panels';
    el.className = 'hidden';
    root.appendChild(el);
    this.el = el;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this._dirty = true;
  }

  /** @param {import('../items/Container.js').Container | null} container */
  toggle(container = null) {
    this.open = !this.open;
    this.container = this.open ? container : null;
    this.el.classList.toggle('hidden', !this.open);
    this._dirty = true;
    events.emit(this.open ? 'ui:opened' : 'ui:closed', {});
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.container = null;
    this.el.classList.add('hidden');
    events.emit('ui:closed', {});
  }

  /** Called when anything moves, so the lists redraw. */
  invalidate() {
    this._dirty = true;
  }

  render() {
    if (!this.open || !this._dirty) return;
    this._dirty = false;

    const inv = this.inventory;
    const load = inv.load;
    const loadColour = load > 1 ? '#c94a4a' : load > 0.8 ? '#c9a052' : '#8fae86';

    this.el.innerHTML = `
      <div class="panel">
        <header>${t('panel.carrying', 'Carried')}
          <b style="color:${loadColour}">${inv.weight.toFixed(1)} / ${inv.capacity} kg</b>
        </header>
        ${this._list(inv, 'inv')}
        ${inv.overloaded ? `<div class="warn">${t('panel.overloaded', 'Overloaded — you are slow')}</div>` : ''}
      </div>
      <div class="panel">
        <header>${this.container
          ? t(`object.${this.container.name}`, this.container.name)
          : t('panel.nothing', 'Nothing here')}
          ${this.container ? `<b>${this.container.weight.toFixed(1)} / ${this.container.capacity} kg</b>` : ''}
        </header>
        ${this.container
          ? this._list(this.container, 'con')
          : `<div class="empty">${t('panel.searchHint', 'Stand at a container and press Tab.')}</div>`}
      </div>
      <div class="panel craft">
        <header>${t('panel.craft', 'Craft')}</header>
        ${this._recipes()}
      </div>
      <div class="hint">${t('panel.hint', 'Click an item to move it or a recipe to make it · F eat · G equip · H treat · L torch · Tab close')}</div>
    `;
  }

  /** The recipe list, greyed where materials are missing. */
  _recipes() {
    if (!this.player) return '<div class="empty">—</div>';
    const held = this.player.weapon?.def ?? {};
    return `<ul>${RECIPES.map((r, i) => {
      const check = canCraft(r, this.inventory, held);
      const cost = Object.entries(r.materials)
        .map(([id, n]) => {
          const label = t(`item.${id}`, id);
          return n === 0 ? `${label} (${t('panel.held', 'held')})` : `${label}×${n}`;
        })
        .join(', ');
      return (
        `<li class="${check.ok ? '' : 'blocked'}" data-recipe="${i}" title="${r.description}">` +
        `<span>${t(`recipe.${r.id}`, r.name)}</span><em>${cost}</em></li>`
      );
    }).join('')}</ul>`;
  }

  _list(container, side) {
    if (container.isEmpty) return `<div class="empty">${t('panel.empty', 'Empty')}</div>`;
    return `<ul>${container
      .sorted()
      .map((item, i) => {
        const spoil = item.def.perishable
          ? `<u style="opacity:${0.25 + item.spoilage * 0.75}">${item.spoiled ? t('item.rotten', 'rotten') : `${Math.round((1 - item.spoilage) * 100)}%`}</u>`
          : '';
        return (
          `<li data-side="${side}" data-index="${i}">` +
          `<span>${item.label()}</span>${spoil}` +
          `<em>${item.weight.toFixed(2)}</em></li>`
        );
      })
      .join('')}</ul>`;
  }

  /**
   * Resolve a click into the item it refers to.
   * @returns {{ item: import('../items/ItemDb.js').Item, from: object, to: object } | null}
   */
  resolveClick(target) {
    const recipeLi = target.closest?.('li[data-recipe]');
    if (recipeLi) return { recipe: RECIPES[Number(recipeLi.dataset.recipe)] };

    const li = target.closest?.('li[data-side]');
    if (!li) return null;
    const side = li.dataset.side;
    const index = Number(li.dataset.index);
    const source = side === 'inv' ? this.inventory : this.container;
    const dest = side === 'inv' ? this.container : this.inventory;
    if (!source || !dest) return null;
    const item = source.sorted()[index];
    return item ? { item, from: source, to: dest } : null;
  }

  /** The item the player would act on with a keyboard shortcut. */
  firstEdible() {
    return this.inventory.find((i) => (i.nutrition > 0 || i.hydration > 0) && !i.spoiled);
  }

  firstWeapon() {
    return this.inventory.find((i) => i.def.weaponId);
  }
}

const CSS = `
#panels {
  position: absolute; inset: 0; display: grid; pointer-events: auto;
  grid-template-columns: 1fr 1fr 1fr; grid-template-rows: 1fr auto;
  gap: 14px; padding: 8vh 12vw 6vh; align-content: center;
  background: rgba(6,8,11,.72); backdrop-filter: blur(2px);
  font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; color: #cfd6dd;
}
#panels.hidden { display: none; }
#panels .panel {
  background: rgba(16,20,26,.9); border: 1px solid rgba(255,255,255,.07);
  border-radius: 4px; padding: 10px 12px; overflow: auto; max-height: 60vh;
}
#panels header {
  display: flex; justify-content: space-between; align-items: baseline;
  border-bottom: 1px solid rgba(255,255,255,.1); padding-bottom: 6px; margin-bottom: 8px;
  text-transform: uppercase; letter-spacing: .1em; font-size: 11px; opacity: .8;
}
#panels header b { font-weight: 400; font-size: 13px; letter-spacing: 0; text-transform: none; }
#panels ul { list-style: none; margin: 0; padding: 0; }
#panels li {
  display: flex; align-items: baseline; gap: 8px; padding: 3px 6px;
  border-radius: 3px; cursor: pointer;
}
#panels li:hover { background: rgba(255,255,255,.07); }
#panels li span { flex: 1; }
#panels li u { text-decoration: none; font-size: 10px; color: #b9b06a; }
#panels li em { font-style: normal; opacity: .45; font-size: 11px; }
#panels .empty { opacity: .35; padding: 6px; }
#panels .warn { color: #c94a4a; margin-top: 8px; font-size: 11px; }
#panels .hint { grid-column: 1 / -1; text-align: center; opacity: .4; font-size: 11px; }
#panels li.blocked { opacity: .32; cursor: default; }
#panels li.blocked:hover { background: none; }
#panels .craft li em { font-size: 10px; }
`;
