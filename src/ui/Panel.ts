import {
  ATTACHMENT_TRAITS,
  BODY_TRAITS,
  MOTION_TRAITS,
  PALETTE_TRAITS,
  cloneGenome,
  type Attachment,
  type Genome,
  type TraitTable,
} from '../genome/Genome';
import { allParts, countOfKind, getPart } from '../build/PartRegistry';
import { Rng, randomSeed } from '../core/Rng';

export interface PanelHandlers {
  onRandomise(): void;
  onMutate(amount: number, structural: boolean): void;
  onReseed(): void;
  /** A structural edit: rebuild. */
  onGenomeEdited(genome: Genome): void;
  /** Colour only: retint without regrowing. */
  onPaletteEdited(genome: Genome): void;
  onToggleWalk(on: boolean): void;
  onSave(): void;
  onSelectGallery(index: number): void;
  onDeleteGallery(index: number): void;
  onChooseBreedPartner(index: number): void;
  onBreed(): void;
  onCopy(): string;
  onPaste(text: string): void;
  onSeedCode(code: string): boolean;
}

/**
 * The control panel.
 *
 * Every slider in here is generated from a trait table rather than written out,
 * which is the visible payoff of describing genes declaratively: registering a
 * part with three new traits puts three new sliders in the panel, correctly
 * ranged and labelled, without this file being touched. Hand-authoring the UI
 * would make the registry a lie — a part would be extensible everywhere except
 * where you actually reach it.
 */
export class Panel {
  private readonly root: HTMLElement;
  private readonly handlers: PanelHandlers;
  private genome: Genome | null = null;
  private readonly bodyHost: HTMLElement;
  private readonly paletteHost: HTMLElement;
  private readonly motionHost: HTMLElement;
  private readonly partsHost: HTMLElement;
  private readonly galleryHost: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly seedInput: HTMLInputElement;
  private readonly breedButton: HTMLButtonElement;
  private readonly toast: HTMLElement;
  private toastTimer = 0;
  private mutateAmount = 0.6;
  private structural = true;

  constructor(container: HTMLElement, handlers: PanelHandlers) {
    this.handlers = handlers;
    this.root = document.createElement('div');
    this.root.className = 'panel';
    this.root.innerHTML = `
      <header class="panel__head">
        <div>
          <h1>Creature Forge</h1>
          <p class="sub" id="stats">—</p>
        </div>
        <button class="icon" id="collapse" title="Collapse panel">–</button>
      </header>

      <div class="panel__body">
        <div class="row">
          <button class="primary" id="randomise">Randomise</button>
          <button id="reseed" title="Same genes, new stochastic detail">Re-seed</button>
        </div>

        <div class="field">
          <label>Mutation strength <output id="amount-out">0.60</output></label>
          <input type="range" id="amount" min="0.05" max="1.6" step="0.05" value="0.6" />
        </div>
        <div class="row">
          <button class="primary" id="mutate">Mutate</button>
          <label class="check"><input type="checkbox" id="structural" checked /> gain / lose parts</label>
        </div>

        <div class="row">
          <button id="save">Save to gallery</button>
          <button id="breed" disabled>Breed</button>
        </div>

        <label class="check walk"><input type="checkbox" id="walk" checked /> Walking</label>

        <div class="field">
          <label>Seed code</label>
          <div class="row">
            <input type="text" id="seed" spellcheck="false" />
            <button id="seed-go">Grow</button>
          </div>
        </div>

        <details open><summary>Body</summary><div id="body"></div></details>
        <details><summary>Colour</summary><div id="palette"></div></details>
        <details><summary>Movement</summary><div id="motion"></div></details>
        <details open><summary>Parts</summary><div id="parts"></div></details>
        <details><summary>Gallery</summary><div id="gallery" class="gallery"></div></details>

        <div class="row">
          <button id="copy">Copy genome</button>
          <button id="paste">Paste genome</button>
        </div>
      </div>
      <div class="toast" id="toast"></div>
    `;
    container.appendChild(this.root);

    this.bodyHost = this.q('#body');
    this.paletteHost = this.q('#palette');
    this.motionHost = this.q('#motion');
    this.partsHost = this.q('#parts');
    this.galleryHost = this.q('#gallery');
    this.statsEl = this.q('#stats');
    this.seedInput = this.q('#seed') as HTMLInputElement;
    this.breedButton = this.q('#breed') as HTMLButtonElement;
    this.toast = this.q('#toast');

    this.q('#randomise').addEventListener('click', () => handlers.onRandomise());
    this.q('#reseed').addEventListener('click', () => handlers.onReseed());
    this.q('#mutate').addEventListener('click', () =>
      handlers.onMutate(this.mutateAmount, this.structural),
    );
    this.q('#save').addEventListener('click', () => {
      handlers.onSave();
      this.showToast('Saved');
    });
    this.breedButton.addEventListener('click', () => handlers.onBreed());

    const amount = this.q('#amount') as HTMLInputElement;
    const amountOut = this.q('#amount-out');
    amount.addEventListener('input', () => {
      this.mutateAmount = Number(amount.value);
      amountOut.textContent = this.mutateAmount.toFixed(2);
    });
    (this.q('#structural') as HTMLInputElement).addEventListener('change', (e) => {
      this.structural = (e.target as HTMLInputElement).checked;
    });
    (this.q('#walk') as HTMLInputElement).addEventListener('change', (e) => {
      handlers.onToggleWalk((e.target as HTMLInputElement).checked);
    });
    this.q('#seed-go').addEventListener('click', () => {
      if (!handlers.onSeedCode(this.seedInput.value)) this.showToast('Not a valid code');
    });
    this.seedInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') this.q('#seed-go').dispatchEvent(new Event('click'));
    });

    this.q('#copy').addEventListener('click', async () => {
      const text = handlers.onCopy();
      try {
        await navigator.clipboard.writeText(text);
        this.showToast('Genome copied');
      } catch {
        // Clipboard access needs a secure context and a user gesture, and is
        // blocked outright in some browsers. Falling back to a prompt keeps
        // the feature usable rather than silently doing nothing.
        window.prompt('Copy this genome', text);
      }
    });
    this.q('#paste').addEventListener('click', async () => {
      let text: string | null = null;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        text = window.prompt('Paste a genome');
      }
      if (text) handlers.onPaste(text);
    });

    this.q('#collapse').addEventListener('click', () => {
      this.root.classList.toggle('panel--collapsed');
    });
  }

  private q(selector: string): HTMLElement {
    return this.root.querySelector(selector) as HTMLElement;
  }

  // ------------------------------------------------------------------ sliders

  /**
   * One slider per trait, built from the schema.
   *
   * `live` decides whether dragging rebuilds the creature on every frame or
   * only on release. Geometry has to wait for release — regrowing a body forty
   * times a second is unusable — but colour is a uniform write and looks wrong
   * if it lags the handle.
   */
  private buildSliders(
    host: HTMLElement,
    table: TraitTable,
    values: Record<string, number>,
    live: boolean,
    onChange: () => void,
  ): void {
    host.textContent = '';
    for (const [key, spec] of Object.entries(table)) {
      const field = document.createElement('div');
      field.className = 'field';
      const step = spec.integer ? 1 : (spec.max - spec.min) / 200;
      const value = values[key] ?? (spec.min + spec.max) / 2;
      field.innerHTML = `
        <label>${spec.label} <output>${format(value, spec.integer)}</output></label>
        <input type="range" min="${spec.min}" max="${spec.max}" step="${step}" value="${value}" />
      `;
      const input = field.querySelector('input') as HTMLInputElement;
      const output = field.querySelector('output') as HTMLOutputElement;
      const commit = (): void => {
        values[key] = Number(input.value);
        output.textContent = format(values[key], spec.integer);
        onChange();
      };
      input.addEventListener('input', live ? commit : () => {
        output.textContent = format(Number(input.value), spec.integer);
      });
      if (!live) input.addEventListener('change', commit);
      host.appendChild(field);
    }
  }

  setGenome(genome: Genome): void {
    this.genome = genome;
    const rebuild = (): void => this.handlers.onGenomeEdited(cloneGenome(this.genome!));
    const retint = (): void => this.handlers.onPaletteEdited(cloneGenome(this.genome!));

    this.buildSliders(this.bodyHost, BODY_TRAITS, genome.body as unknown as Record<string, number>, false, rebuild);
    this.buildSliders(this.paletteHost, PALETTE_TRAITS, genome.palette as unknown as Record<string, number>, true, retint);
    this.buildSliders(this.motionHost, MOTION_TRAITS, genome.motion as unknown as Record<string, number>, true, () => {
      // Motion genes are read every frame by the animator, so editing them in
      // place is enough — no rebuild, and no lag on the handle.
      this.handlers.onPaletteEdited(cloneGenome(this.genome!));
    });
    this.buildParts(genome);
  }

  // -------------------------------------------------------------------- parts

  private buildParts(genome: Genome): void {
    this.partsHost.textContent = '';

    for (let index = 0; index < genome.attachments.length; index++) {
      const attachment = genome.attachments[index];
      const def = getPart(attachment.kind);
      const card = document.createElement('div');
      card.className = 'part';
      card.innerHTML = `
        <div class="part__head">
          <strong>${def?.label ?? attachment.kind}</strong>
          <div class="part__tools">
            <button class="mini" data-act="mirror" title="Toggle mirrored pair">${
              attachment.symmetry === 'pair' ? 'pair' : 'single'
            }</button>
            <button class="mini danger" data-act="remove" title="Remove">×</button>
          </div>
        </div>
        <div class="part__body"></div>
      `;
      const body = card.querySelector('.part__body') as HTMLElement;

      this.buildSliders(body, ATTACHMENT_TRAITS, attachment as unknown as Record<string, number>, false, () =>
        this.handlers.onGenomeEdited(cloneGenome(genome)),
      );
      if (def) {
        this.buildSliders(body, def.traits, attachment.traits, false, () =>
          this.handlers.onGenomeEdited(cloneGenome(genome)),
        );
      }

      card.querySelector('[data-act="remove"]')!.addEventListener('click', () => {
        const next = cloneGenome(genome);
        next.attachments.splice(index, 1);
        this.handlers.onGenomeEdited(next);
      });
      card.querySelector('[data-act="mirror"]')!.addEventListener('click', () => {
        const next = cloneGenome(genome);
        next.attachments[index].symmetry = attachment.symmetry === 'pair' ? 'single' : 'pair';
        this.handlers.onGenomeEdited(next);
      });
      this.partsHost.appendChild(card);
    }

    // Add-a-part. Kinds already at their limit are offered but disabled, so it
    // is clear the limit exists rather than the option having vanished.
    const adder = document.createElement('div');
    adder.className = 'row adder';
    const select = document.createElement('select');
    for (const def of allParts()) {
      const option = document.createElement('option');
      option.value = def.kind;
      const full = countOfKind(genome, def.kind) >= def.maxCount;
      option.textContent = full ? `${def.label} (max)` : def.label;
      option.disabled = full;
      select.appendChild(option);
    }
    const add = document.createElement('button');
    add.textContent = 'Add part';
    add.addEventListener('click', () => {
      const def = getPart(select.value);
      if (!def) return;
      const rng = new Rng(randomSeed());
      const placement = def.defaultPlacement(rng);
      const traits: Record<string, number> = {};
      for (const [key, spec] of Object.entries(def.traits)) {
        const v = rng.range(spec.min, spec.max);
        traits[key] = spec.integer ? Math.round(v) : v;
      }
      const next = cloneGenome(genome);
      next.attachments.push({ kind: def.kind, ...placement, traits } as Attachment);
      this.handlers.onGenomeEdited(next);
    });
    adder.appendChild(select);
    adder.appendChild(add);
    this.partsHost.appendChild(adder);
  }

  // ------------------------------------------------------------------ gallery

  setGallery(gallery: Genome[]): void {
    this.galleryHost.textContent = '';
    if (gallery.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'sub';
      empty.textContent = 'Nothing saved yet. Save a creature to breed from it.';
      this.galleryHost.appendChild(empty);
      return;
    }
    for (let i = 0; i < gallery.length; i++) {
      const genome = gallery[i];
      const chip = document.createElement('div');
      chip.className = 'chip';
      const swatch = swatchFor(genome);
      chip.innerHTML = `
        <span class="chip__dot" style="background:${swatch}"></span>
        <span class="chip__name">${describe(genome)}</span>
        <button class="mini" data-act="load">load</button>
        <button class="mini" data-act="mate">mate</button>
        <button class="mini danger" data-act="del">×</button>
      `;
      chip.querySelector('[data-act="load"]')!.addEventListener('click', () =>
        this.handlers.onSelectGallery(i),
      );
      chip.querySelector('[data-act="mate"]')!.addEventListener('click', () =>
        this.handlers.onChooseBreedPartner(i),
      );
      chip.querySelector('[data-act="del"]')!.addEventListener('click', () =>
        this.handlers.onDeleteGallery(i),
      );
      this.galleryHost.appendChild(chip);
    }
  }

  setBreedPartner(partner: Genome | null): void {
    this.breedButton.disabled = !partner;
    this.breedButton.textContent = partner ? `Breed with ${describe(partner)}` : 'Breed';
  }

  setStats(stats: { parts: number; triangles: number; draws: number }): void {
    this.statsEl.textContent = `${stats.parts} parts · ${stats.draws} draws · ${stats.triangles.toLocaleString()} tris`;
  }

  setSeedCode(code: string): void {
    this.seedInput.value = code;
  }

  private showToast(message: string): void {
    this.toast.textContent = message;
    this.toast.classList.add('toast--on');
    this.toastTimer = 1.6;
  }

  tick(dt: number): void {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.classList.remove('toast--on');
    }
  }
}

function format(value: number, integer?: boolean): string {
  return integer ? String(Math.round(value)) : value.toFixed(2);
}

function swatchFor(genome: Genome): string {
  const p = genome.palette;
  return `hsl(${Math.round(((p.hue % 1) + 1) % 1 * 360)} ${Math.round(p.saturation * 100)}% ${Math.round(
    p.lightness * 100,
  )}%)`;
}

/** A short readable name, so a gallery chip is identifiable at a glance. */
function describe(genome: Genome): string {
  const legs = countOfKind(genome, 'leg');
  const bits: string[] = [`${legs}-leg`];
  for (const kind of ['wing', 'horn', 'fin', 'eyestalk', 'antenna']) {
    if (countOfKind(genome, kind) > 0) bits.push(kind);
  }
  return bits.slice(0, 3).join(' · ');
}
