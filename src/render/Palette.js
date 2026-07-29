/**
 * The palette, in one place.
 *
 * The reference game's look is desaturated, high-contrast dusk: the world sits
 * in muted greens, greys and browns so that the few saturated things — items,
 * blood, fire, your own torch — read instantly as *meaningful*. Any colour added
 * here should pass that test: if it is bright, it must matter.
 *
 * Colours are linear-space triples because they are baked into vertex colours,
 * which bypass three.js's sRGB conversion for material colours.
 */
import { Color } from 'three';
import { FLOOR, WALL } from '../world/TileGrid.js';

/** @param {number} hex @returns {[number, number, number]} linear rgb */
function linear(hex) {
  const c = new Color(hex); // Color() converts sRGB hex → linear working space
  return [c.r, c.g, c.b];
}

export const FLOOR_COLOR = {
  [FLOOR.VOID]: linear(0x000000),
  [FLOOR.GRASS]: linear(0x56663f),
  [FLOOR.DIRT]: linear(0x4b4436),
  [FLOOR.ASPHALT]: linear(0x35363c),
  [FLOOR.PAVEMENT]: linear(0x5a5c62),
  [FLOOR.WOOD]: linear(0x6f5539),
  [FLOOR.CARPET]: linear(0x5c4a52),
  [FLOOR.TILE]: linear(0x7c7f82),
  [FLOOR.CONCRETE]: linear(0x62645f),
  [FLOOR.ROOF]: linear(0x4a4348),
};

export const WALL_COLOR = {
  [WALL.NONE]: linear(0x000000),
  [WALL.WOOD]: linear(0x7d6446),
  [WALL.PLASTER]: linear(0x8e8c82),
  [WALL.BRICK]: linear(0x764a3d),
  [WALL.CONCRETE]: linear(0x70726f),
  [WALL.DOORWAY]: linear(0x8e8c82),
  [WALL.WINDOW]: linear(0x8e8c82),
  [WALL.FENCE]: linear(0x6a6357),
};

/** Sky and light colours for the default dusk mood. */
export const MOOD = {
  sky: 0x2c3340,
  /**
   * Fill comes from a hemisphere, not a flat ambient. A constant ambient term
   * lights every shaded facade identically, so a wall in shadow and a floor in
   * shadow become the same value and the geometry goes flat exactly where the
   * key light has stopped helping. Sky-above / bounce-below keeps them apart.
   */
  fillSky: 0x8195b2,
  fillGround: 0x4a4336,
  fillIntensity: 2.3,
  key: 0xffe0b4,
  /** Low sun: warmer and weaker. */
  keyDusk: 0xffb582,
  keyIntensity: 2.3,
  /** Night: the fill goes cold, and the sky with it. */
  fillNight: 0x2c3c58,
  skyNight: 0x0d1219,
};
