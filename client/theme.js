// Current island theme and the block colours that follow from it. Pure (no DOM/three).
import { BLOCKS, THEMES } from '../shared/constants.js';

export const theme = { id: 'meadow', def: THEMES.meadow };

export function setTheme(id) {
  theme.id = Object.hasOwn(THEMES, id) ? id : 'meadow';
  theme.def = THEMES[theme.id];
}

// side colour of a block in the current theme
export function blockHex(id) {
  const def = BLOCKS[id];
  if (!def) return 0xff00ff;
  const c = theme.def.colors[def.name];
  return c !== undefined ? c : def.color;
}

// top colour (differs from the side for grass)
export function blockTopHex(id) {
  const def = BLOCKS[id];
  if (!def) return 0xff00ff;
  if (def.top !== undefined) return theme.def.top !== null ? theme.def.top : (theme.def.colors[def.name] !== undefined ? theme.def.colors[def.name] : def.top);
  return blockHex(id);
}
