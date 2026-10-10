/** Contingency lists and remedial actions: the study case's own contingencies (several elements failing together)
 * and its rules, and the JSON file they are exchanged in.
 *
 * The file is `{ "format": "powerstudio-contingencies", "version": 1, "contingencies": [...], "remedialActions": [...] }`.
 * A contingency is `{ id, name, elements: [element ids] }`. A remedial action is `{ id, name, contingencies: [ids],
 * conditions: [...], actions: [...] }`, with conditions `{ kind: 'loading', element, above }` (%),
 * `{ kind: 'voltageBelow' | 'voltageAbove', node, below | above }` (p.u.) or `{ kind: 'outage', element }`, and actions
 * `{ kind: 'switch', element, inService }`, `{ kind: 'generation', element, p }` (MW), `{ kind: 'tap', element,
 * position }` or `{ kind: 'loadShed', element, percent }`. docs/ENGINE.md describes how the engine applies them. */

export const CONTINGENCY_FORMAT = 'powerstudio-contingencies';

/**
 * @typedef {{ id: string, name: string, elements: string[] }} Contingency
 * @typedef {{ kind: 'loading', element: string, above: number } | { kind: 'voltageBelow', node: string, below: number }
 *   | { kind: 'voltageAbove', node: string, above: number } | { kind: 'outage', element: string }} Condition
 * @typedef {{ kind: 'switch', element: string, inService: boolean } | { kind: 'generation', element: string, p: number }
 *   | { kind: 'tap', element: string, position: number } | { kind: 'loadShed', element: string, percent: number }} Action
 * @typedef {{ id: string, name: string, contingencies: string[], conditions: Condition[], actions: Action[] }} RemedialAction
 */

/** The element classes each part of a contingency or rule can name. */
export const OUTAGE_CLASSES = /** @type {readonly string[]} */ (['line', 'trafo', 'gen']);
export const BRANCH_CLASSES = /** @type {readonly string[]} */ (['line', 'trafo']);
export const ACTION_CLASSES = /** @type {Readonly<Record<Action['kind'], readonly string[]>>} */ ({
  switch: ['line', 'trafo', 'gen', 'load', 'shunt'], generation: ['gen'], tap: ['trafo'], loadShed: ['load'],
});

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
/** @param {unknown} v */
const isText = v => typeof v === 'string' && v.length > 0;
/** @param {unknown} v */
const isNumber = v => typeof v === 'number' && Number.isFinite(v);

/** A valid condition, or null. @param {Record<string, unknown>} c @param {Map<string, string>} cls @returns {Condition | null} */
function readCondition(c, cls) {
  const element = /** @type {string} */ (c.element), node = /** @type {string} */ (c.node);
  const branch = BRANCH_CLASSES.includes(cls.get(element) ?? ''), bus = cls.get(node) === 'bus';
  if (c.kind === 'loading' && branch && isNumber(c.above)) return { kind: 'loading', element, above: /** @type {number} */ (c.above) };
  if (c.kind === 'voltageBelow' && bus && isNumber(c.below)) return { kind: 'voltageBelow', node, below: /** @type {number} */ (c.below) };
  if (c.kind === 'voltageAbove' && bus && isNumber(c.above)) return { kind: 'voltageAbove', node, above: /** @type {number} */ (c.above) };
  if (c.kind === 'outage' && OUTAGE_CLASSES.includes(cls.get(element) ?? '')) return { kind: 'outage', element };
  return null;
}

/** A valid action, or null. @param {Record<string, unknown>} a @param {Map<string, string>} cls @returns {Action | null} */
function readAction(a, cls) {
  const element = /** @type {string} */ (a.element);
  const kind = /** @type {Action['kind']} */ (a.kind);
  if (!Object.hasOwn(ACTION_CLASSES, kind) || !ACTION_CLASSES[kind].includes(cls.get(element) ?? '')) return null;
  if (kind === 'switch' && typeof a.inService === 'boolean') return { kind, element, inService: a.inService };
  if (kind === 'generation' && isNumber(a.p)) return { kind, element, p: /** @type {number} */ (a.p) };
  if (kind === 'tap' && Number.isInteger(a.position)) return { kind, element, position: /** @type {number} */ (a.position) };
  if (kind === 'loadShed' && isNumber(a.percent) && /** @type {number} */ (a.percent) >= 0 && /** @type {number} */ (a.percent) <= 100) return { kind, element, percent: /** @type {number} */ (a.percent) };
  return null;
}

/**
 * Keeps the valid contingencies and remedial actions, reporting what it drops. Every element they name must be in
 * `cls` (the network's elements by identifier, with their class) and of a class that part can name.
 * @param {unknown} contingencies @param {unknown} remedial @param {Map<string, string>} cls
 * @returns {{ contingencies: Contingency[], remedial: RemedialAction[], issues: string[] }}
 */
export function checkContingencies(contingencies, remedial, cls) {
  /** @type {string[]} */
  const issues = [];
  /** @type {Contingency[]} */
  const list = [];
  const seen = new Set();
  for (const raw of Array.isArray(contingencies) ? contingencies : []) {
    // An identifier of the network's own would make a remedial action's scope ambiguous (a single outage uses the
    // element's identifier).
    if (!isObject(raw) || !isText(raw.id) || seen.has(raw.id) || cls.has(/** @type {string} */ (raw.id)) || !Array.isArray(raw.elements)) {
      issues.push('Skipped a contingency without an identifier of its own or a list of elements.');
      continue;
    }
    const elements = raw.elements.filter(e => typeof e === 'string' && OUTAGE_CLASSES.includes(cls.get(e) ?? ''));
    if (elements.length !== raw.elements.length) issues.push(`Contingency ${raw.id}: dropped elements this network does not have, or that cannot fail (a contingency takes out lines, transformers and generators).`);
    if (!elements.length) { issues.push(`Skipped contingency ${raw.id}: none of its elements is in this network.`); continue; }
    seen.add(raw.id);
    list.push({ id: /** @type {string} */ (raw.id), name: typeof raw.name === 'string' ? raw.name : '', elements: /** @type {string[]} */ (elements) });
  }
  /** @type {RemedialAction[]} */
  const rules = [];
  const ruleIds = new Set();
  for (const raw of Array.isArray(remedial) ? remedial : []) {
    if (!isObject(raw) || !isText(raw.id) || ruleIds.has(raw.id)) { issues.push('Skipped a remedial action without an identifier of its own.'); continue; }
    const id = /** @type {string} */ (raw.id);
    /** @type {Condition[]} */
    const conditions = [];
    let valid = true;
    for (const c of Array.isArray(raw.conditions) ? raw.conditions : []) {
      const condition = isObject(c) ? readCondition(c, cls) : null;
      if (condition) conditions.push(condition);
      else valid = false;
    }
    // Without one of its conditions a rule would fire more widely than meant, so it goes whole.
    if (!valid) { issues.push(`Skipped remedial action ${id}: a condition is not valid for this network.`); continue; }
    /** @type {Action[]} */
    const actions = [];
    for (const a of Array.isArray(raw.actions) ? raw.actions : []) {
      const action = isObject(a) ? readAction(a, cls) : null;
      if (action) actions.push(action);
      else issues.push(`Remedial action ${id}: dropped an action that is not valid for this network.`);
    }
    if (!actions.length) { issues.push(`Skipped remedial action ${id}: it has no valid action.`); continue; }
    // The contingencies it is for: the study case's own, or the outage of a single element. Dropping one narrows the
    // rule; dropping all would widen it to every contingency, so the rule then goes.
    const asked = Array.isArray(raw.contingencies) ? raw.contingencies : [];
    const names = asked.filter(c => isText(c) && (seen.has(c) || OUTAGE_CLASSES.includes(cls.get(c) ?? '')));
    if (names.length !== asked.length) {
      if (!names.length) { issues.push(`Skipped remedial action ${id}: none of the contingencies it is for exists.`); continue; }
      issues.push(`Remedial action ${id}: dropped contingencies that do not exist.`);
    }
    ruleIds.add(id);
    rules.push({ id, name: typeof raw.name === 'string' ? raw.name : '', contingencies: /** @type {string[]} */ (names), conditions, actions });
  }
  return { contingencies: list, remedial: rules, issues };
}

/** Reads a contingency file. Throws with a plain message when it is not one.
 * @param {string} text @param {Map<string, string>} cls */
export function readContingencyFile(text, cls) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('The file is not valid JSON.'); }
  if (!isObject(raw) || raw.format !== CONTINGENCY_FORMAT) throw new Error(`The file is not a contingency file (its format field is not "${CONTINGENCY_FORMAT}").`);
  return checkContingencies(raw.contingencies, raw.remedialActions, cls);
}

/** The contingency file for a study case's lists. @param {Contingency[]} contingencies @param {RemedialAction[]} remedial */
export function contingencyFile(contingencies, remedial) {
  return `${JSON.stringify({ format: CONTINGENCY_FORMAT, version: 1, contingencies, remedialActions: remedial }, null, 2)}\n`;
}
