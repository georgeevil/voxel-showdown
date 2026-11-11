// Builds a World and wipes it so tests can lay out exact block arrangements.
import { World } from '../../shared/world.js';
import { WORLD, B } from '../../shared/constants.js';

let cached = null;
export function emptyWorld() {
  if (!cached) cached = new World(1);
  const w = cached;
  w.data.fill(B.AIR);
  w.chests = [];
  return w;
}

// Solid stone slab filling y = 0..top-1 everywhere (standing surface at y = top).
export function flatWorld(top = 10) {
  const w = emptyWorld();
  w.data.fill(B.STONE, 0, WORLD.SX * WORLD.SZ * top);
  return w;
}
