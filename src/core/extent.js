/** Smallest and largest of many numbers. `Math.min(...values)` passes every value as an argument and overflows the
 * call stack on large networks and long simulations; these loop instead. */

/** @param {ArrayLike<number>} values @returns {number} Infinity when empty */
export function minOf(values) {
  let m = Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] < m) m = values[i];
  return m;
}

/** @param {ArrayLike<number>} values @returns {number} -Infinity when empty */
export function maxOf(values) {
  let m = -Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] > m) m = values[i];
  return m;
}
