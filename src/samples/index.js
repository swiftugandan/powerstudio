/** The sample documents bundled with the app. */

import { ieee14 } from './ieee14.js';
import { riverside } from './riverside.js';

/** @typedef {{ id: string, title: string, summary: string, create: () => import('../core/document.js').PowerDocument }} Sample */

/** @type {readonly Sample[]} */
export const SAMPLES = [
  { id: 'ieee14', title: 'IEEE 14-bus system', summary: '132/33/11 kV transmission benchmark with five machines.', create: ieee14 },
  { id: 'riverside', title: 'Riverside distribution', summary: '110/20/0.4 kV network with a cable ring and a CHP unit.', create: riverside },
];
