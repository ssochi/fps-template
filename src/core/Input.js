/**
 * Raw browser events → intent, in one place.
 *
 * Systems ask "does the player want to move north-east?", never "is KeyW down?".
 * That indirection is what lets the camera rotate without silently rebinding the
 * movement keys, and what will let a gamepad or remapping drop in later without
 * touching the player controller.
 */
import { Vector2 } from 'three';

/** Named actions the game understands. Bindings map keys onto these. */
export const ACTION = {
  MOVE_UP: 'moveUp',
  MOVE_DOWN: 'moveDown',
  MOVE_LEFT: 'moveLeft',
  MOVE_RIGHT: 'moveRight',
  RUN: 'run',
  SNEAK: 'sneak',
  ROTATE_CW: 'rotateCw',
  ROTATE_CCW: 'rotateCcw',
  ZOOM_IN: 'zoomIn',
  ZOOM_OUT: 'zoomOut',
  LEVEL_UP: 'levelUp',
  LEVEL_DOWN: 'levelDown',
  INTERACT: 'interact',
  PAUSE: 'pause',
  ATTACK: 'attack',
  SHOVE: 'shove',
  INVENTORY: 'inventory',
  CONSUME: 'consume',
  EQUIP: 'equip',
};

const DEFAULT_BINDINGS = {
  KeyW: ACTION.MOVE_UP,
  ArrowUp: ACTION.MOVE_UP,
  KeyS: ACTION.MOVE_DOWN,
  ArrowDown: ACTION.MOVE_DOWN,
  KeyA: ACTION.MOVE_LEFT,
  ArrowLeft: ACTION.MOVE_LEFT,
  KeyD: ACTION.MOVE_RIGHT,
  ArrowRight: ACTION.MOVE_RIGHT,
  ShiftLeft: ACTION.RUN,
  ShiftRight: ACTION.RUN,
  ControlLeft: ACTION.SNEAK,
  KeyE: ACTION.INTERACT,
  KeyQ: ACTION.ROTATE_CCW,
  Comma: ACTION.ROTATE_CCW,
  Period: ACTION.ROTATE_CW,
  BracketLeft: ACTION.LEVEL_DOWN,
  BracketRight: ACTION.LEVEL_UP,
  Space: ACTION.PAUSE,
  Tab: ACTION.INVENTORY,
  KeyI: ACTION.INVENTORY,
  Escape: ACTION.INVENTORY,
  KeyF: ACTION.CONSUME,
  KeyG: ACTION.EQUIP,
};

export class Input {
  /** @param {HTMLElement|Window} [target] */
  constructor(target = window) {
    this.bindings = { ...DEFAULT_BINDINGS };
    /** Actions currently held. */
    this.held = new Set();
    /** Actions pressed since the last `endFrame()`. Edge-triggered. */
    this.pressed = new Set();
    /** Accumulated wheel steps since the last `endFrame()`. */
    this.wheelSteps = 0;
    /** Pointer position in normalised device coordinates. */
    this.pointer = new Vector2();
    this.pointerDown = false;

    this._onKeyDown = (e) => {
      const action = this.bindings[e.code];
      if (!action) return;
      // Repeat events are held-state noise, not new presses.
      if (!e.repeat) this.pressed.add(action);
      this.held.add(action);
      if (action !== ACTION.PAUSE) e.preventDefault();
    };
    this._onKeyUp = (e) => {
      const action = this.bindings[e.code];
      if (action) this.held.delete(action);
    };
    // A tab switch with a key held leaves it stuck down forever otherwise.
    this._onBlur = () => this.held.clear();
    this._onWheel = (e) => {
      e.preventDefault();
      this.wheelSteps += Math.sign(e.deltaY);
    };
    this._onPointerMove = (e) => {
      this.pointer.set(
        (e.clientX / window.innerWidth) * 2 - 1,
        -(e.clientY / window.innerHeight) * 2 + 1,
      );
    };
    this._onPointerDown = (e) => {
      this.pointerDown = true;
      // Mouse buttons are actions like any other: left swings, right shoves.
      const action = e.button === 2 ? ACTION.SHOVE : ACTION.ATTACK;
      this.pressed.add(action);
      this.held.add(action);
    };
    this._onPointerUp = (e) => {
      this.pointerDown = false;
      this.held.delete(e.button === 2 ? ACTION.SHOVE : ACTION.ATTACK);
    };
    // Without this a right-click shove also opens the browser context menu.
    this._onContextMenu = (e) => e.preventDefault();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('contextmenu', this._onContextMenu);
    target.addEventListener('wheel', this._onWheel, { passive: false });
    this._wheelTarget = target;
  }

  isHeld(action) {
    return this.held.has(action);
  }

  wasPressed(action) {
    return this.pressed.has(action);
  }

  /**
   * Movement intent in *screen* space: x is right, y is up the screen, both in
   * [-1, 1]. The caller rotates this into world space with the camera basis, so
   * "up" always means up the screen no matter how the camera is turned.
   */
  moveAxis(out = new Vector2()) {
    let x = 0;
    let y = 0;
    if (this.isHeld(ACTION.MOVE_LEFT)) x -= 1;
    if (this.isHeld(ACTION.MOVE_RIGHT)) x += 1;
    if (this.isHeld(ACTION.MOVE_DOWN)) y -= 1;
    if (this.isHeld(ACTION.MOVE_UP)) y += 1;
    out.set(x, y);
    // Diagonals must not be faster than cardinals.
    if (out.lengthSq() > 1) out.normalize();
    return out;
  }

  /** Clear edge-triggered state. Call once at the end of every frame. */
  endFrame() {
    this.pressed.clear();
    this.wheelSteps = 0;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('contextmenu', this._onContextMenu);
    this._wheelTarget.removeEventListener('wheel', this._onWheel);
  }
}
