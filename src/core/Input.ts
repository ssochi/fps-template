/**
 * Keyboard / mouse input with pointer-lock mouse look.
 *
 * Call `endFrame()` once per frame *after* all systems have read input so the
 * "just pressed / just released" edges and the accumulated mouse delta reset.
 */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly released = new Set<string>();

  private readonly mouseDown = new Set<number>();
  private readonly mousePressed = new Set<number>();
  private readonly mouseReleased = new Set<number>();

  mouseDX = 0;
  mouseDY = 0;
  wheelDelta = 0;

  pointerLocked = false;
  enabled = true;

  private readonly element: HTMLElement;
  private readonly onLockChangeCbs = new Set<(locked: boolean) => void>();

  constructor(element: HTMLElement) {
    this.element = element;

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    window.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mouseup', this.handleMouseUp);
    window.addEventListener('mousemove', this.handleMouseMove);
    window.addEventListener('wheel', this.handleWheel, { passive: false });
    window.addEventListener('contextmenu', this.handleContextMenu);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    window.removeEventListener('mousedown', this.handleMouseDown);
    window.removeEventListener('mouseup', this.handleMouseUp);
    window.removeEventListener('mousemove', this.handleMouseMove);
    window.removeEventListener('wheel', this.handleWheel);
    window.removeEventListener('contextmenu', this.handleContextMenu);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
  }

  // ---------------------------------------------------------------- queries

  isDown(code: string): boolean {
    return this.enabled && this.down.has(code);
  }

  /** True on the frame the key transitioned to down. */
  wasPressed(code: string): boolean {
    return this.enabled && this.pressed.has(code);
  }

  wasReleased(code: string): boolean {
    return this.enabled && this.released.has(code);
  }

  isMouseDown(button: number): boolean {
    return this.enabled && this.mouseDown.has(button);
  }

  wasMousePressed(button: number): boolean {
    return this.enabled && this.mousePressed.has(button);
  }

  wasMouseReleased(button: number): boolean {
    return this.enabled && this.mouseReleased.has(button);
  }

  /** Any of the given key codes held. */
  anyDown(...codes: string[]): boolean {
    return codes.some((c) => this.isDown(c));
  }

  // ------------------------------------------------------------ pointerlock

  requestPointerLock(): void {
    if (this.pointerLocked) return;
    const el = this.element as HTMLElement & {
      requestPointerLock?: (opts?: { unadjustedMovement?: boolean }) => Promise<void> | void;
    };
    try {
      // `unadjustedMovement` disables OS pointer acceleration where supported,
      // which makes aiming consistent across platforms.
      const result = el.requestPointerLock?.({ unadjustedMovement: true });
      if (result instanceof Promise) {
        result.catch(() => el.requestPointerLock?.());
      }
    } catch {
      this.element.requestPointerLock();
    }
  }

  exitPointerLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  onPointerLockChange(cb: (locked: boolean) => void): () => void {
    this.onLockChangeCbs.add(cb);
    return () => this.onLockChangeCbs.delete(cb);
  }

  // ------------------------------------------------------------------ frame

  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
    this.mousePressed.clear();
    this.mouseReleased.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
  }

  /** Drop all held state — used when the game loses focus or pauses. */
  clear(): void {
    this.down.clear();
    this.mouseDown.clear();
    this.endFrame();
  }

  // --------------------------------------------------------------- handlers

  private handleKeyDown = (e: KeyboardEvent): void => {
    // Let the browser keep F-keys and reload shortcuts.
    if (e.code === 'F5' || e.code === 'F12' || (e.ctrlKey && e.code === 'KeyR')) return;
    if (this.pointerLocked || e.code === 'Escape' || e.code === 'Tab') e.preventDefault();
    if (e.repeat) return;
    if (!this.down.has(e.code)) this.pressed.add(e.code);
    this.down.add(e.code);
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
    this.released.add(e.code);
  };

  private handleBlur = (): void => {
    this.clear();
  };

  private handleMouseDown = (e: MouseEvent): void => {
    if (!this.mouseDown.has(e.button)) this.mousePressed.add(e.button);
    this.mouseDown.add(e.button);
  };

  private handleMouseUp = (e: MouseEvent): void => {
    this.mouseDown.delete(e.button);
    this.mouseReleased.add(e.button);
  };

  private handleMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked) return;
    // Some browsers report huge spurious deltas right after locking; clamp them.
    const dx = Math.abs(e.movementX) > 300 ? 0 : e.movementX;
    const dy = Math.abs(e.movementY) > 300 ? 0 : e.movementY;
    this.mouseDX += dx;
    this.mouseDY += dy;
  };

  private handleWheel = (e: WheelEvent): void => {
    if (this.pointerLocked) e.preventDefault();
    this.wheelDelta += Math.sign(e.deltaY);
  };

  private handleContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private handlePointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.element;
    if (!this.pointerLocked) this.clear();
    for (const cb of this.onLockChangeCbs) cb(this.pointerLocked);
  };
}

export const MOUSE_LEFT = 0;
export const MOUSE_MIDDLE = 1;
export const MOUSE_RIGHT = 2;
