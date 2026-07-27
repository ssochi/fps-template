import * as THREE from 'three';
import { Stage } from './Stage';
import { Animator } from '../anim/Animator';
import { buildCreature, type Creature } from '../build/CreatureBuilder';
import { randomGenome, mutate, breed } from '../genome/Mutate';
import { cloneGenome, deserialise, serialise, type Genome } from '../genome/Genome';
import { Rng, codeToSeed, randomSeed, seedToCode } from './Rng';
import { Panel } from '../ui/Panel';

const BOUNDS = 11.5;
const STORAGE_KEY = 'creature-forge.gallery.v1';

const _focus = new THREE.Vector3();
const _delta = new THREE.Vector3();

/**
 * Ties the generator, the renderer and the panel together.
 *
 * The one rule that keeps this honest: **the genome is the single source of
 * truth**, and every control edits the genome and rebuilds. There is no path
 * that pokes a mesh directly, so what you see is always something the genome
 * can reproduce — which is what makes saving, sharing and breeding work rather
 * than merely appear to.
 *
 * The exception is the palette, which is a uniform write. That is not a
 * shortcut around the rule: the colours are derived from the palette gene on
 * every rebuild too, the live path just skips the rebuild because dragging a
 * hue slider through a full regrow is unusable.
 */
export class App {
  private readonly stage: Stage;
  private readonly panel: Panel;
  private animator: Animator;
  private creature: Creature;
  private genome: Genome;

  private walking = true;
  private lastTime = performance.now();
  /** Saved creatures, kept as genomes rather than as built objects. */
  private gallery: Genome[] = [];
  private breedPartner: Genome | null = null;

  constructor(container: HTMLElement) {
    this.stage = new Stage(container);
    this.genome = this.initialGenome();
    this.creature = buildCreature(this.genome);
    this.stage.scene.add(this.creature.root);
    this.animator = new Animator(this.creature, { bounds: BOUNDS });

    this.panel = new Panel(container, {
      onRandomise: () => this.setGenome(randomGenome()),
      onMutate: (amount, structural) =>
        this.setGenome(mutate(this.genome, { amount, structural, reseed: false })),
      onReseed: () => {
        const next = cloneGenome(this.genome);
        next.seed = randomSeed();
        this.setGenome(next);
      },
      onGenomeEdited: (genome) => this.setGenome(genome, false),
      onPaletteEdited: (genome) => {
        this.genome = genome;
        this.creature.materials.setPalette(genome.palette);
        this.persistUrl();
      },
      onToggleWalk: (on) => {
        this.walking = on;
        if (!on) this.animator.freeze();
      },
      onSave: () => this.save(),
      onSelectGallery: (index) => this.setGenome(cloneGenome(this.gallery[index])),
      onDeleteGallery: (index) => {
        this.gallery.splice(index, 1);
        this.persistGallery();
        this.panel.setGallery(this.gallery);
      },
      onChooseBreedPartner: (index) => {
        this.breedPartner = this.gallery[index] ?? null;
        this.panel.setBreedPartner(this.breedPartner);
      },
      onBreed: () => {
        if (!this.breedPartner) return;
        this.setGenome(breed(this.genome, this.breedPartner, new Rng(randomSeed())));
      },
      onCopy: () => serialise(this.genome),
      onPaste: (text) => this.setGenome(deserialise(text, this.genome)),
      onSeedCode: (code) => {
        const seed = codeToSeed(code);
        if (seed === null) return false;
        this.setGenome(randomGenome(seed));
        return true;
      },
    });

    this.stage.frame(this.creature.root, this.creature.body.rideHeight);
    this.loadGallery();
    this.panel.setGenome(this.genome);
    this.panel.setStats(this.stats());
    this.panel.setGallery(this.gallery);
    this.panel.setSeedCode(seedToCode(this.genome.seed));

    // Look where the camera is, so the creature meets your eye as you orbit.
    this.stage.controls.addEventListener('change', () => this.updateInterest());
    this.updateInterest();

    // A handle for the console and for automated checks. Everything reachable
    // through it is already public API of the pieces it exposes.
    (window as unknown as { forge: App }).forge = this;

    this.loop();
  }

  /** Read-only access for debugging and tests. */
  get debug(): { stage: Stage; animator: Animator; creature: Creature; genome: Genome } {
    return { stage: this.stage, animator: this.animator, creature: this.creature, genome: this.genome };
  }

  /** A creature from the URL if there is one, so a link reproduces exactly. */
  private initialGenome(): Genome {
    const hash = window.location.hash.replace(/^#/, '');
    if (hash) {
      try {
        const decoded = decodeURIComponent(atob(hash));
        return deserialise(decoded, randomGenome());
      } catch {
        // A hash from somewhere else, or a truncated one. Fall through.
      }
    }
    return randomGenome();
  }

  private setGenome(genome: Genome, refreshPanel = true): void {
    this.genome = genome;

    const previous = this.creature;
    this.creature = buildCreature(genome);
    this.stage.scene.add(this.creature.root);
    this.stage.scene.remove(previous.root);
    previous.dispose();

    this.animator.setCreature(this.creature);
    if (!this.walking) this.animator.freeze();
    this.stage.frame(this.creature.root, this.creature.body.rideHeight);
    if (refreshPanel) this.panel.setGenome(genome);
    this.panel.setSeedCode(seedToCode(genome.seed));
    this.panel.setStats(this.stats());
    this.persistUrl();
    this.updateInterest();
  }

  private stats(): { parts: number; triangles: number; draws: number } {
    let triangles = 0;
    let draws = 0;
    this.creature.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      draws++;
      const g = mesh.geometry;
      const index = g.getIndex();
      triangles += (index ? index.count : g.getAttribute('position').count) / 3;
    });
    return { parts: this.genome.attachments.length, triangles: Math.round(triangles), draws };
  }

  private updateInterest(): void {
    // The head tracks the camera, which is the cheapest thing that makes a
    // generated creature feel alive rather than exhibited.
    this.animator.interest.copy(this.stage.camera.position);
  }

  private save(): void {
    this.gallery.unshift(cloneGenome(this.genome));
    if (this.gallery.length > 24) this.gallery.length = 24;
    this.persistGallery();
    this.panel.setGallery(this.gallery);
  }

  private persistGallery(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.gallery.map(serialise)));
    } catch {
      // Private browsing, or a full quota. The gallery is a convenience, so
      // losing it must not take the session down with it.
    }
  }

  private loadGallery(): void {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const list = JSON.parse(raw) as string[];
      const fallback = randomGenome();
      this.gallery = list.map((text) => deserialise(text, fallback)).slice(0, 24);
    } catch {
      this.gallery = [];
    }
  }

  private persistUrl(): void {
    try {
      const encoded = btoa(encodeURIComponent(serialise(this.genome)));
      window.history.replaceState(null, '', `#${encoded}`);
    } catch {
      // Nothing depends on the URL round-tripping.
    }
  }

  /**
   * Keeps the camera on the creature as it wanders.
   *
   * The camera is moved by the same delta as the orbit target rather than
   * being re-aimed, so following does not quietly rotate the view out from
   * under someone who is mid-drag.
   */
  private followCreature(dt: number): void {
    const target = this.stage.controls.target;
    _focus.set(this.animator.position.x, this.creature.body.rideHeight, this.animator.position.z);
    _delta.copy(_focus).sub(target).multiplyScalar(1 - Math.exp(-2.2 * dt));
    target.add(_delta);
    this.stage.camera.position.add(_delta);
  }

  private loop = (): void => {
    requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    this.animator.update(dt, this.walking);
    this.followCreature(dt);
    this.stage.followShadow(this.animator.position);
    this.stage.render();
    this.panel.tick(dt);
  };
}
