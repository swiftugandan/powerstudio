# The calculation engine

This document states what every PowerStudio calculation computes, with which model, and how each result is checked.
The engine is written in Rust (`engine/`). It compiles to WebAssembly for the browser and to a native program, `ps`,
for tests and benchmarks; both run the same code. `docs/research/sources.md` lists where every reference value comes
from, and `docs/design/NATIONAL-GRADE.md` sets out where the engine is going.

## From document to result

Every calculation follows the same path, one crate per step:

1. **Import** (`ps-io`). A PowerStudio document (`powerstudio.rs`), a MATPOWER case (`matpower.rs`,
   `matpower_model.rs`), a CGMES model (`cgmes.rs` over `rdf.rs` and `zip.rs`) or a PSS/E RAW file (`psse.rs`,
   `psse_model.rs`) becomes the canonical model. Every importer returns a report (`report.rs`): the files read, what
   each class of objects became or why it was left out, and the values it filled in.
2. **Model** (`ps-model`). Equipment in engineering units: nodes, switches, lines, two- and three-winding
   transformers with tap changers, generators, loads, shunts, static var compensators, external grids and areas.
   Edits are operations with exact inverses; models save as binary snapshots with a SHA-256 content hash.
3. **Topology** (`ps-topology`). Closed switches merge nodes into calculation buses, branches in service join them
   into islands, and islands without a source are de-energised.
4. **Per unit** (`ps-net`). The calculation buses and every branch as a per-unit two-port.
5. **Solvers** (`ps-lf`, `ps-sc`, `ps-dyn`; contingency analysis in `ps-study`), on sparse matrices (`ps-sparse`).
6. **Reports** (`ps-study`). Results by element identifier, in engineering units, as JSON.

## The model

The model stores what an operator exchanges: kV, MW, Mvar, MVA, Ω, S and A. Series impedances and shunt admittances
are totals for the element. Transformer impedances are referred to winding 1. Each element has a stable string
identifier; elements refer to nodes by index. The model holds bus-branch networks (one node per bus, as in drawn
networks, MATPOWER and PSS/E) and node-breaker networks (busbar sections joined by breakers and disconnectors, as in
CGMES) alike.

Changes go through `Op`: insert, replace, set one field, remove, restore, or a batch that applies whole or not at
all. Applying an operation returns its inverse, so undo is applying the inverse. Removing an element that others
still refer to is refused. `Model::validate` reports missing or duplicate identifiers, dangling references, zero
impedances, impossible ratings and limits, each naming the element and the fix.

A 0.1 document converts without loss of electrical data: per-length line data become totals (R′·length / parallel
systems, B′·length·parallel systems), uk and uR become the impedance referred to the HV winding, and iron losses and
no-load current become a magnetising admittance split half to each winding. Diagram positions stay with the document.

## Units and per unit

`ps-net` converts the model to per unit on two bases: the model's base power (100 MVA unless changed) and each
calculation bus's nominal voltage. Every branch becomes a two-port with admittances `yff`, `yft`, `ytf` and `ytt` in
the MATPOWER convention: an ideal transformer t = τ·e^{jθ} at the from end, the series impedance on the to side, and
shunt admittances at each end, the from one behind the ideal transformer. Load flow, short circuit and stability
build their matrices from these conversions.

| Element | Model |
| --- | --- |
| Line | π model: series impedance R + jX, shunt admittance G + jB split between both ends. Zero sequence uses R0, X0 and B0. |
| Two-winding transformer | Series impedance referred to winding 2 by the rated ratio (taps do not change it), magnetising admittance at each winding. Ratio τ = (Ur1·f1 / Ur2·f2) / (Ub1 / Ub2), where f = 1 + (position − neutral)·step on the winding carrying the tap changer. Phase shift θ = clock number × 30° + fixed shift + phase tap angle, winding 2 lagging. |
| Three-winding transformer | Three branches from the windings to a star-point bus on winding 1's rated voltage, with the magnetising admittance at the star point. |
| Synchronous machine | Load flow: PV (P and \|U\| held), PQ (P and Q held) or reference (\|U\| and angle held). Short circuit: KG·(RG + jX″d). Stability: E′ behind x′d with inertia H. |
| External grid | Load flow: reference with \|U\| and angle held. Short circuit: c·Un²/Sk″ with the given R/X; zero sequence from X0/X1 and R0/X0. Stability: a constant voltage behind its short-circuit impedance. |
| Load | Constant P and Q, scaled by the study case's load scaling. Stability: a constant admittance at its load-flow voltage. |
| Shunt | Constant admittance per section times the sections in service. |

Loads with voltage-dependent (ZIP) shares, generators regulating a remote node and static var compensators are part
of the model but not yet of the calculations; a calculation that meets them says so in its warnings.

## Topology

Nodes joined by closed switches form one calculation bus, reported under its first node's identifier. Lines and
transformers in service join buses into islands. An island is energised when it holds an external grid or a
reference machine; an island with machines but neither gets its largest machine (by rated power) as reference, with
a warning; any other island is de-energised and left out, and the report lists its nodes. A contingency case takes
elements out for one calculation without editing the model.

## Load flow

`ps-lf` solves the AC power-flow equations S = V·conj(Y·V) by the Newton-Raphson method in polar coordinates. The
Jacobian comes from ∂S/∂θ and ∂S/∂|V| (the formulation of MATPOWER's `dSbus_dV`) on a fixed sparse pattern, so the
ordering and symbolic factorisation (`ps-sparse`, faer's sparse LU with COLAMD ordering) are computed once per solve
and each iteration only refactorises. Iterations stop when the largest power mismatch is below the study case
tolerance (1 kVA by default). A step that does not reduce the squared mismatch enough (Armijo's condition) is
shortened to the minimum of a quadratic fitted along the Newton direction, up to eight times; a start far from the
solution then stalls at a mismatch it reports, bus by bus, instead of diverging.

- **Start.** Voltage magnitudes start at the no-load profile: every bus no control fixes takes the average of its
  neighbours' voltages, weighted by branch susceptance and scaled by the transformers' off-nominal ratios, with the
  controlled buses at their targets (OpenLoadFlow's voltage magnitude initialiser). Angles start at the nominal angles
  (every transformer phase shift applied outward from the reference), then a DC load flow that includes the phase
  shifts sets them. The Riverside sample, a meshed 20 kV ring with Yd5 and Dy5 transformers, needs it: pandapower's flat start
  does not converge on it in 50 iterations; with a DC start both programs converge in 3. The study case can switch to
  a flat start. A warm start (contingency cases, models that carry a solution) starts from the previous voltages.
- **Voltage control.** A machine holds the voltage of the busbar its data name (its own, or a remote one with
  "Machines regulate remote busbars" on): that busbar's voltage is fixed and the machine's own becomes an unknown.
  Several machine busbars regulating one busbar share its reactive power in proportion to their reactive ranges, an
  equation per extra controller. Machines on one busbar act as one, sharing its output at the same fraction of their
  ranges.
- **Voltage-dependent loads.** A load consumes P·(z·V² + i·V + c) with its constant impedance, current and power
  shares (and likewise Q); the shares enter the Jacobian. Off, every load is constant power.
- **HVDC links** run at their setpoints: the rectifier draws the setpoint from its AC network and the inverter delivers
  it less the stations' losses (a percentage) and the line's R·P²/V². A line-commutated station also consumes
  |P|·tan(acos pf); a voltage-source station regulates voltage or holds its reactive power within limits.
- **Controls** act as outer loops around Newton, in OpenLoadFlow's order: slack distribution, area interchange, reactive
  limits, phase shifters, tap changers, switched shunts. A loop that changes something re-solves before the next is
  checked, and a round repeats until nothing changes (at most 30 changes). `engine/crates/ps-lf/src/control.rs` and
  `discrete.rs` state each rule:
  - *Slack distribution* shares each island's imbalance among machines (by maximum power, present power,
    participation factor or remaining margin) within their active limits and without changing their sign, or among
    loads by their active power. What the participants cannot take stays with the reference. An island with an
    external grid leaves it to the grid.
  - *Reactive limits* apply per controller busbar. A busbar beyond its limit is held at it; one stays in voltage
    control even if all are beyond; a held busbar returns to voltage control when its voltage passes the target in the
    direction the limit was resisting, at most three times. With limits on, a machine whose reactive range is under
    1 Mvar holds its stated reactive power. (The `ieee14-qlim` case: G2 reaches 50 Mvar only after G4 and G5 are
    held.)
  - *Area interchange* holds each control area's net export (the active power entering the branches to other areas,
    at their ends inside it) within its tolerance of its target. The machines at the area's slack bus take the
    difference, shared equally within their active power limits; an area whose slack bus holds an island's
    reference balances the island instead, so its export is what the others leave; an area whose slack machines reach
    their limits stops there and the report says how far short it is. The definition follows the PSS/E area record
    (ISW, PDES, PTOL); docs/research/sources.md gives the evidence for PDES being an export and why PowSyBl is not the
    reference here. In the editor an area is a zone, with its target, tolerance and slack busbar in the study case.
  - *Tap changers, phase shifters and switched shunts* move whole positions. The change each needs comes from a
    sensitivity at the converged state; the new position is the closest to that change, within three positions per
    round for a single tap changer, one per pass when several regulate one busbar, four sections per round for a
    shunt. The voltage target of a busbar a machine also regulates is the machine's.
- **Diagnostics.** The report lists the final tap positions and shunt sections, the power each island's distribution
  moved, every area's net export with its target, what each control did, and in plain words every control that could
  not do what was asked.
- **Results.** Voltages, branch flows and currents at both ends, losses, loading (current against the permanent
  limit for lines, apparent power against the rating for transformers), the output of every machine and grid, the
  iteration log and the time spent. A bus's active power balance goes to its reference units. Its reactive balance
  goes to its external grids if it has any; otherwise the reference and PV machines on the bus share it as MATPOWER
  does (`pfsoln.m`): each at the same fraction k of its range, Q = Qmin + k·(Qmax − Qmin), with infinite limits
  replaced by a finite proxy and an equal split when the bus has no range at all.

**Checked by** `engine/crates/ps-study/tests/controls.rs` against OpenLoadFlow with each control on, alone and
together, on every solvable PSS/E case and the 2,000- and 10,000-bus ACTIVSg grids, with raised voltage targets so
the taps and shunts move: 255 variants agree to 1e-9 p.u. and 1e-3 MW, every tap and section on the same position. A
phase shifter's flow control is checked against its own definition. Also by
`engine/crates/ps-study/tests/loadflow.rs` (native) and `tests/loadflow.test.mjs` (WebAssembly):
MATPOWER case14, case30 and case118 agree with PYPOWER to |ΔU| < 1e-9 p.u. and |Δθ| < 1e-7°; the IEEE 14 and
Riverside samples agree with pandapower in voltages, branch flows (1e-6 MW) and machine outputs, with and without
reactive limits; power balances at every bus, computed from the reported flows.

At scale, `engine/crates/ps-study/tests/matpower.rs` compares every bus voltage and machine output, and on the cases
up to 13,659 buses every branch flow, with PowSyBl's OpenLoadFlow on the ACTIVSg synthetic grids (2,000, 10,000,
25,000 and 70,000 buses) and the PEGASE European cases (2,869, 9,241 and 13,659 buses). Voltages agree to 1.1e-10
p.u. or better and flows and outputs to 2e-8 MW or Mvar, except one PEGASE 9241 machine whose reactive output
differs by 1.7e-4 Mvar.

## Short circuit

`ps-sc` implements the method of the equivalent voltage source at the fault location of IEC 60909-0. **It is
IEC 60909-style, not certified**: the formulas follow pandapower 3.5.6's implementation of the standard (see
`docs/research/sources.md`), and PowerStudio agrees with pandapower on both samples, maximum and minimum, to about
1e-15 relative for three-phase and line-to-line faults and within 2e-8 for earth faults. The earth-fault difference
comes from the tiny numerical earthing each program adds to otherwise isolated zero-sequence networks.

- The only source is c·Un/√3 at the faulted bus. Machines, grids and transformers become impedances; loads, shunts,
  line capacitances (positive sequence) and transformer magnetising branches are left out.
- Voltage factor: cmax 1.10 and cmin 1.00 above 1 kV; below 1 kV cmax 1.05 or 1.10 and cmin 0.95 or 0.90 for the
  6 % and 10 % tolerance settings.
- Transformer correction KT = 0.95·cmax/(1 + 0.6·xT) in the maximum case, with cmax of the winding-2 bus.
- Generator correction KG = Un/UrG · cmax/(1 + x″d·sin φrG), in both cases.
- Thévenin impedances Zkk come from solving Y·z = e_k for each bus on the factorised sparse admittance matrix, in the
  positive sequence and, for earth faults, the zero sequence. Ik″ = c·Un/(√3·|Z1|), c·Un/|2·Z1| and
  √3·c·Un/|2·Z1 + Z0|.
- Zero sequence: YNyn transformers pass zero-sequence current; Dyn and YNd provide an earth path on their earthed
  side; other connections block it. Line B0 is kept. Generators are unearthed. Every bus gets 1e-10 p.u. to earth so
  isolated zero-sequence networks stay solvable; their earth-fault current reads about zero.
- Peak current ip = κ·√2·Ik″. Method C (default) evaluates R/X at the equivalent frequency (20 Hz for 50 Hz systems)
  with the fictitious generator resistances (0.05, 0.07 or 0.15 of X″d). Method B uses κ of the fault R/X, multiplied
  by 1.15 when any branch has R/X ≥ 0.3, capped at 2.0 (1.8 below 1 kV); method B is checked against its formula,
  not against pandapower.
- Thermal equivalent current Ith = Ik″·√(m + n) for Tk = 1 s with n = 1 (far from generators), as pandapower does.
- With a single fault location, the contribution of every branch comes from the voltage changes −Z(:,k)·If.

**Checked by** `engine/crates/ps-study/tests/shortcircuit.rs` and `tests/shortcircuit.test.mjs`: Ik″, ip and Ith
against pandapower at every bus of both samples for all twelve combinations of fault type and case (pandapower
reports no ip or Ith for earth faults); a hand calculation for a single infeed; Kirchhoff's current law at the fault
for the branch contributions; the correction factors against their formulas (`ps-sc` unit tests).

## Contingency analysis

`ps-study::contingency` solves the network after each contingency and judges the result against the study case's
limits. The contingencies are every selected line, transformer, machine and HVDC link taken out alone (in that order,
each in model order, with the element's identifier as the contingency's), then, with busbar faults selected, a fault on
every busbar where anything connects (buses of bus-branch models, busbar sections of node-breaker ones), followed by
the study case's own list: a contingency there has its own identifier and takes out several elements together, such
as both circuits of a double line. A busbar among a contingency's elements stands for a fault there: its protection
opens every switch around it and everything connected there goes out, so feeders reached through those switches hang
open at that end. CGMES contingency data (`Contingency`, `ContingencyEquipment`) is not read: none of the conformity
configurations carries any, so there is nothing to test a mapping against. Each case lists its highest loading, its voltage extremes, the buses it cuts off and its violations of the
loading limit and of every node's voltage band, marking those already present in the base case. Cases are ranked with
unsolvable cases first, then by the number of violations, then by highest loading.

**Limits.** A branch end is judged against the largest of its limits that lasts at least the study case's time to act
(`acceptableS`; its permanent limit always qualifies), in kA where the end has a current limit and against its MVA
rating otherwise. With the default of 0 s only permanent limits count.

**Solving.** The base case is solved once and every contingency starts from its voltages and, with reactive limits
respected, from its machines' limit state: a bus the base case holds at a limit starts held there (released as usual
when its voltage passes its target), as OpenLoadFlow's security analysis restores the base case's bus states before
each contingency. An island must keep a voltage control, so a reference machine starts in control and an island whose
controlling buses would all start held keeps its strongest in control, by the rule of the reactive limit loop. On
ACTIVSg2000 with limits this takes N-1 from 102 to 22 s natively with the same outcome (29 outages without a
solution, 41 with violations); ACTIVSg10k takes 75 ms per outage against 26 ms without limits, since its outages
still switch tens of machines in three to six rounds. A single-branch outage
that leaves the network connected (Tarjan's bridges tell which do) keeps the base network's matrix pattern: the
branch's admittances are zeroed and the sparse analysis of the base Jacobian is reused, which takes 27 ms per outage
on the 10,000-bus ACTIVSg grid natively. Bridges, machines, HVDC links and multi-element contingencies rebuild the
network. The report's `effort` counts the outages each way.

**Screening** (off by default). Each single-branch outage that keeps the network connected is first solved by fast
decoupled iterations on its full AC equations, in the XB form (B′ from branch reactances alone for angles, B″ from
the full susceptance matrix for magnitudes), starting
from the base solution. B′ and B″ are factorised once for the base network; the outage enters as a rank-two
correction of those factors (the Woodbury identity), so no outage needs a factorisation of its own. The iterations
stop at 1e-5 p.u. of mismatch and converge in four or five. When the result keeps every branch below
(100 − margin) % of the loading limit and every voltage the voltage margin inside its band, the case is reported as
screened with the estimate's highest loading; anything else, including iterations that do not converge, gets the full
Newton load flow. An element already inside the margins in the base case counts when the outage worsens it (by
0.1 % of loading or 0.001 p.u., the drift), so a base-case loading of 96 % does not send every outage to the full
solve; it always counts once the estimate comes within the drift of the limit itself, so an element parked just under
its limit cannot cross it unseen. A voltage band is judged by side: a bus above its band in the base case is still
checked against the lower edge. A bus whose voltage a control holds keeps it in the full solution as well, so it is
not judged. The defaults are 5 % and 0.01 p.u. A screened case reports the decoupled solution's
loadings and voltages, which differ from the full solution's by at most 0.0005 % and 3e-6 p.u. on the reference
cases.

The decoupled solution holds the base solution's controls where they are, so it models what follows the voltage
without moving a control and turns the rest away. Voltage-dependent loads take their power at the new voltages, and
a static var compensator held at a limit gives B·V² at its new voltage. With reactive limits respected, the reactive
power each voltage-held bus must supply after the outage is checked against the room its machines have left, and a
bus held at a limit must not come within 1e-4 p.u. of the voltage that would release it; either sends the outage to
the full solve. The buses whose voltage the base solution held come from the solver itself, since a reference machine
that reaches a limit keeps its angle but not its voltage. Controls that the outage would move rule screening out
for the whole run, with a note in the report saying which: machines regulating remote busbars, an imbalance shared
among several units, regulating tap changers or phase shifters, and switched shunts.

A first version estimated with one linear step from the base factors. It missed voltage collapses: on IEEE 57 it moved
the lowest voltage by 0.01 p.u. where the full solution falls to 0.65. The outage-corrected iterations are the fix,
and the guarantee test below holds the screen to them.

**Remedial actions.** A rule names the contingencies it is for (none: every one), conditions on the post-contingency
solution (a branch's loading above a value, a node's voltage below or above one, the contingency taking out a given
element) and actions (switching an element in or out, setting a machine's active power or a transformer's tap
position, shedding a share of a load's P and Q). After a contingency is solved, every rule whose conditions all hold
fires; their actions apply together and the contingency is solved once more, by a full rebuild. The case then reports
the state after the actions, the rules that fired (`remedial`) and how many violations the outage caused before them
(`violationsBefore`). Rules do not chain: actions are not re-checked against the conditions after the second solve.
Screening hands an outage to the full solve whenever a rule would fire on its estimate.

**The contingency file.** The app imports and exports a study case's own contingencies and rules as JSON
(`src/core/contingencies.js`):

```json
{ "format": "powerstudio-contingencies", "version": 1,
  "contingencies": [{ "id": "C1", "name": "Double circuit 1-2", "elements": ["L1", "L2"] }],
  "remedialActions": [{ "id": "R1", "name": "Shed load at bus 3", "contingencies": ["L1"],
    "conditions": [{ "kind": "loading", "element": "L2", "above": 100 }],
    "actions": [{ "kind": "loadShed", "element": "D3", "percent": 60 }] }] }
```

Condition kinds are `loading` (`element`, `above` in %), `voltageBelow` and `voltageAbove` (`node`, `below` or
`above` in p.u.) and `outage` (`element`); action kinds are `switch` (`element`, `inService`), `generation`
(`element`, `p` in MW), `tap` (`element`, `position`) and `loadShed` (`element`, `percent`). Reading a file keeps
what names elements of this network of the right class. A rule never ends up wider than written: one with a condition
that does not fit the network, or whose contingencies are all missing, is skipped whole, and removing an element
from the diagram removes the rules that depend on it in the same way (undo restores them).

**Parallel runs.** The contingencies split into contiguous chunks. The browser runs the chunks on a pool of workers
(one engine instance each, up to eight) and the engine merges them in contingency order, keeping the first case on
ties, so the result is identical to a sequential run whatever the pool size. Only `timing` differs between runs.

**DC sensitivities.** `ps-lf::sensitivity` holds the network's linear models: a factorised DC model (B′) that gives
power transfer distribution factors (PTDF) for any transfer, line outage distribution factors (LODF) and angles, and
the decoupled voltage model (B″). Both take a branch outage as a low-rank correction, which is what screening uses.

**Checked by:**

- `engine/crates/ps-study/tests/security.rs` against PowSyBl's security analysis (OpenLoadFlow, goldens from
  `scripts/oracle/security.py`): every single-element outage of the 22 PSS/E reference cases and of ACTIVSg2000, the
  ten branches whose flow changes most per outage to 1e-3 MW or Mvar at both ends and the five buses whose voltage
  changes most to 1e-6 p.u. Outages that cut PowSyBl's slack bus off are left out, since each tool then picks a new
  reference by its own rule.
- `engine/crates/ps-study/tests/sensitivity.rs` against PowSyBl's DC sensitivity analysis (`scripts/oracle/sensitivity.py`):
  PTDFs on IEEE 14, 39 and 118 to 5e-11.
- `engine/crates/ps-study/tests/contingency.rs`: every case equals a separate load flow with the element out; Line 1-2
  out overloads Line 1-5 on the IEEE 14 sample; radial outages report the lost nodes; chunked runs merge to exactly the
  sequential report; and the screening guarantee, which runs every PSS/E case and ACTIVSg2000 with and without
  screening, once with the plain settings and once with reactive limits and voltage-dependent loads, and requires
  every outage that full AC flags (a new violation or no solution) to have been solved in full, and the screened
  estimates to stay within a tenth of the drift of the full solution. With limits on, screening clears 2,111 of
  ACTIVSg2000's outages; ieee300 and rts96, whose machines nearly all lose voltage control at their limits, clear
  none, because the decoupled iterations do not converge on them; nor does ACTIVSg10k, whose base case holds a few
  hundred machines at their limits within 1e-5 p.u. of their targets, so that every outage could switch some of
  them. Bounding those switches inside the screen cost more solves than it saved and is not attempted. Another test checks that regulating tap changers
  turn screening off with a note. A second test parks each line
  of IEEE 14 in turn at 99.99 % of its limit and each busbar's band edge 0.0001 p.u. from its voltage, below and
  above: the cases the drift rule alone let through (24 outages before the limit rule) and a bus over its band in the
  base case falling under it. Screening clears 2,584 of ACTIVSg2000's 3,206
  branch outages, and takes ACTIVSg10k from 26 to 11.5 ms per outage natively. A remedial action relieves the IEEE
  14 overload and leaves every other outage unchanged. A busbar fault on the IEEE 14 sample equals the contingency of
  everything connected at the bus; on the node-breaker IEEE 14 every busbar section's fault solves and loses that
  section.
- `tests/contingency.test.mjs` and `tests/contingencies.test.mjs`: the same through WebAssembly, the file's checks, and
  removal and undo in the document.

## Stability (RMS simulation)

`ps-dyn` runs an electromechanical simulation with the classical model: every machine is a constant voltage E′
behind x′d whose angle follows the swing equation 2H·dω/dt = Pm − Pe − D·(ω − 1), dδ/dt = ωs·(ω − 1), on the system
base. E′ and δ0 come from the load flow; loads become constant admittances; external grids are constant voltages
behind their short-circuit impedance. The network is solved on its factorised sparse admittance matrix at every
stage of a fourth-order Runge-Kutta step (1 ms by default), and refactorised only when an event changes it. Events
at given times apply a three-phase fault at a node (1e6 p.u. to earth), clear it, switch out a branch, machine or
load, or scale a load. Angles are reported against the external grid when there is one, otherwise against the centre
of inertia, and net of transformer phase shifts. A machine more than 180° from another is reported as loss of
synchronism.

**Checked by** `engine/crates/ps-study/tests/rms.rs` and `tests/rms.test.mjs`: on a single machine against an
infinite bus, clearing 2 % before the equal-area critical clearing time stays in step and 2 % after it does not;
small oscillations follow the linearised swing frequency within 1 %; undisturbed operation stays at its load-flow
equilibrium.

## MATPOWER import

`ps-io` reads MATPOWER cases of format version 2 straight into the model and is exact for everything MATPOWER
describes: transformers keep arbitrary phase shifts and carry their charging as magnetising admittance, generators
keep their active power limits, and buses keep the case's stored voltages for warm starts. Branches and generators
are named by their row in the case, as MATPOWER identifies them (`L17` or `T17` for branch row 17, `G4` for generator
row 4). RATE_A is the branch's rating in MVA; a line gets it as a current limit at nominal voltage, and a transformer
as its rated power. A RATE_A of 0 means no rating, as in MATPOWER: such a transformer takes the system base as its
rated power, only as a base for its data, and is marked unrated (`thermal` off in the editor), so its loading is not
reported. PSS/E branch records that join two voltage levels follow the same rule. MATPOWER has no zero-sequence,
machine or inertia data; the importer fills them with stated typical values and lists them in the import's notes. The app opens cases through it like any other file (see "Opening other tools'
files in the app").

## CGMES import

`ps-io` reads CGMES 2.4.15 and 3.0 models from XML files, folders or zip archives (nested archives included): EQ, TP,
SSH, SV, DL, GL and the boundary set. `rdf.rs` merges the profiles by object identifier, so files can come in any
order. The importer keeps the node-breaker structure: connectivity nodes with their switches, or topological nodes
where a model has only those. Lines, series compensators and equivalent branches become lines; power transformers
become two- or three-winding transformers with their ratio and phase tap changers (linear, symmetrical, asymmetrical
and tabular, with the reactance variation of the asymmetrical and symmetrical kinds), and the tap changer of winding 2
stays on winding 2. Machines and external network injections keep their regulating controls and reactive capability
curves; loads keep their load-response characteristics; linear and non-linear shunts, equivalent shunts and
injections, and static var compensators are mapped. Equipment whose SSH `Equipment.inService` is false is out of
service. Starting voltages come from SV. Vector group clocks are read but not applied, as PowSyBl does not apply them
by default; the report says so.

**Checked by** `engine/crates/ps-study/tests/cgmes.rs` against PowSyBl's import and OpenLoadFlow on twelve ENTSO-E
conformity configurations (MicroGrid, MiniGrid, SmallGrid, Svedala, the PST cases, PowerFlow, FullGrid's import, and
the 2.4.15 MicroGrid in its BE, NL and assembled forms): imported data to 1e-9 relative, voltages to 1e-6 p.u.,
flows to 1e-3 MW. The worst case agrees to 1e-11 p.u. and 2e-8 MW.

## PSS/E RAW import

`ps-io` reads RAW files of versions 33 and 35, bus-branch and node-breaker. Fields may be separated by commas or
blanks; the section terminators' comments name the next section, which copes with files that leave sections out.
What maps:

| RAW data | Model |
| --- | --- |
| Buses | Nodes `B<number>`; type 4 takes everything at the bus out of service; a type 3 bus without a generator gets an external grid |
| Substations (version 35) | A substation per record, a voltage level per bus, a node per substation node (`B<bus>-N<node>`), switches from the switching devices; equipment connects at the node its terminal record names, otherwise at the bus's lowest node |
| Loads | Loads `B<bus>-L<id>` at their value at 1 p.u. voltage, P = PL + IP + YP and Q = QL + IQ − YQ, with the constant-power, current and admittance shares kept |
| Fixed and switched shunts | Shunts; a switched shunt's levels follow its blocks (reactors, then capacitors) and it sits at the level nearest BINIT; MODSW 1 and 2 become voltage control |
| Generators | Generators `B<bus>-G<id>`, voltage control on type 2 and 3 buses, the first in service on a type 3 bus is the reference; IREG is kept as the regulated node |
| Branches | Lines `L-<i>-<j>-<ckt>` with their charging split between the ends plus GI, BI, GJ, BJ; a branch between buses of different base voltage becomes a transformer at the ratio of the bases, which is what its per-unit data mean |
| Transformers | Two- and three-winding transformers (`T-<i>-<j>-<ckt>`, `T-<i>-<j>-<k>-<ckt>`); CW, CZ and CM conversions; three-winding units as a star; each winding's tap range RMI…RMA in NTP steps with the stated ratio as the present step, voltage control from VMA, VMI and CONT; COD 3 windings as phase tap tables with their flow control |
| System switching devices (version 35) | Switches |
| FACTS devices | A shunt device (a STATCOM) becomes a static var compensator holding VSET within ±SHMX |
| Areas | Areas with their scheduled interchange (PDES, as net export), tolerance (PTOL) and slack bus (ISW) for interchange control |
| Two-terminal DC lines | HVDC links `DC-<name>` between line-commutated stations `DC-<name>-R` and `-I`, at the scheduled power (MDC 1: SETVL MW; MDC 2: SETVL A at VSCHD) with the resistance RDC at VSCHD, each station at the power factor ½·(cos ANMX + cos 60°) as PowSyBl converts them |
| VSC DC lines | HVDC links `VSC-<name>` between voltage-source stations `-1` and `-2`, at \|DCSET\| of the converter controlling AC power, losses from ALOSS, voltage control (MODE 1) at ACSET or a power factor (MODE 2) |

Multi-terminal DC lines, series FACTS devices, induction machines, impedance correction tables and the generator
step-up data in generator records are not modelled; the report counts what it left out. Tap, shunt and phase-shifter
controls are imported with their targets and act when the study case lets them.

**Checked by** `engine/crates/ps-study/tests/psse.rs` against PowSyBl on 23 RAW files from powsybl-core's tests,
versions 33 and 35, up to the 500-bus South Carolina synthetic grid: imported set points, admittances, impedances and
tap changers, and the load flow at every bus and equipment terminal. Every case that can be solved agrees to 1e-10
p.u. or better, IEEE 300 with its HVDC links to 3e-9 p.u.; `docs/research/sources.md` lists the corrections the comparison makes to
PowSyBl's network and why.

## CGMES state variables export

After a load flow, `ps-io` (`cgmes_sv.rs`) writes the state variables (SV) profile for the CGMES files the model came
from, so the result travels with the operator's own EQ, TP and SSH files. It reads those files again for the
identifiers SV refers to: an `SvVoltage` for every topological node (zero for nodes without supply), a
`TopologicalIsland` for every island with its angle reference, an `SvPowerFlow` for every terminal PowerStudio solved
(load sign, power into the equipment), an `SvTapStep` for every tap changer, an `SvStatus` for every conducting
equipment and an `SvShuntCompensatorSections` for every shunt compensator. The version (2.4.15 or 3.0) follows the
input; the SV model depends on the input's TP and SSH models and takes their scenario time and modelling authority.
New identifiers derive from the input and the element, so the same state always gives the same file.

**Checked by** `engine/crates/ps-study/tests/cgmes_sv.rs`, which writes the SV of every solved conformity
configuration, reads the configuration back with it in place of its own SV, and requires every node to start at the
solved voltage and the load flow to need no iteration from there. And by `scripts/oracle/sv_check.py`, in which PowSyBl
reads the exported SV: it takes every flow PowerStudio wrote, on all eleven configurations, without difference.

## PSS/E RAW export

`ps-io` (`psse_write.rs`) writes any model as a RAW file of version 33 or 35. RAW is bus-branch, so nodes joined by
closed switches become one bus and open switches are left out. Each branch is written from the engine's own per-unit
form of its element (`ps-net`), which keeps the file's solution the engine's: the ideal transformer's ratio and angle
become WINDV1 and ANG1 (CW, CZ and CM all 1), the magnetising admittance moves from behind the ideal transformer to
bus I, divided by the ratio squared, and an admittance a record has no place for (at a transformer's other end, at a
three-winding transformer's windings 2 and 3, a switched shunt's conductance) becomes a fixed shunt at the same bus.
A three-winding transformer's star impedances become the pairwise ones (Z12 = Z1 + Z2), and branches with an open end
get a bus of their own for that end. Tap ranges and controls are written for two-winding transformers; a machine with
fixed reactive output on a voltage-controlled bus is pinned there with QT = QB = QG. HVDC links become two-terminal
DC records (line-commutated, rectifier first, power factor through ANMX) or VSC DC records (voltage-source, the
converter that controls AC power first). Names are written in ASCII.
Identifiers that came from RAW (`B12`, `B12-L1`, `L-1-2-1`) keep their numbers; other models get fresh ones. The
export returns notes on everything it approximated: impedance that varies with tap position, the tap ranges of
three-winding transformers, asymmetric static var compensator ranges, controls without a positive voltage band.

**Checked by** `engine/crates/ps-study/tests/roundtrip.rs`, which writes every reference model (the samples, MATPOWER
cases up to 2,869 buses, the CGMES configurations and the PSS/E files) in both versions, reads the files back and
solves them: every node keeps its voltage to 1e-14 p.u. And by `scripts/oracle/export_check.py`, which has PowSyBl
read the same files: its load flow agrees with PowerStudio's on all 64 files to 4.2e-11 p.u. or better.

On the command line, `ps cgmes <files> [--lf]` and `ps psse <file.raw> [--lf]` import and print the report, the
validation and a load flow; `ps export <input>... --raw 33|35` writes RAW and `ps cgmes <files> --sv <out.xml>`
writes the SV of a load flow.

## Opening other tools' files in the app

The app opens CGMES models, RAW files and MATPOWER cases through the engine's `import` request
(`ps-study/src/exchange.rs`). The engine recognises the format by extension, or by content when a file has none,
imports the model, validates it, and converts it into the editor's document (`ps-io/src/powerstudio_write.rs`). The
document has seven classes, so the conversion reduces what it cannot hold: closed switches join their nodes into one
busbar, a three-winding transformer becomes a star busbar with three two-winding transformers, a static var
compensator becomes a machine without active power that holds its voltage, an HVDC station becomes the fixed
injection its setpoint gives (a load or a machine), and a shunt with uneven sections keeps its present admittance.
Machines keep their regulated busbars and active limits, loads their constant impedance and current shares, shunts
with even sections their sections and voltage control, and transformers one tap changer on the HV winding with its
control (a tabled changer as the even step between its end positions, exact at its present position). Electrical values come from the engine's per-unit form of each element, so the document reproduces what
it holds exactly: a transformer's present ratio becomes its rated HV voltage, its phase shift a vector group or an
additional shift, its magnetising admittance a branch at one or both windings; uneven line charging becomes shunt
elements; an impedance with a negative part or no reactance, which uk and uR cannot express, gets a line from an
intermediate busbar for that part. The engine then solves the model and the document, the document started from the
model's solution, both with remote voltage control and voltage-dependent loads on and the discrete controls held, and
reports the largest voltage difference with the voltages to start the editor's load flows from.

The import also sets the study case where the file shows how it was solved. When in-service machines with a reactive
range of at least 1 Mvar sit at a reactive limit in the file's own solution, the study case respects reactive power
limits and the import dialog says why: such a case was solved with them, and without them its machines hold voltages
they cannot reach. ACTIVSg10k is the example: two machines 0.0007 p.u. of reactance apart hold 1.0415 and 1.0172 p.u.
without limits, which drives 3,500 Mvar through the line between them, where the file's solution, at their limits,
has 2.6 Mvar.

**Checked by** `engine/crates/ps-study/tests/document.rs`: every reference model (MATPOWER cases up to ACTIVSg70k,
the CGMES configurations, the PSS/E files) converts into a document whose load flow agrees with the model's to
2e-12 p.u. or better, and `tests/import.test.mjs`, which imports MATPOWER and RAW files through the WebAssembly
engine and checks the document passes the editor's import gate unchanged. The same test file checks that ACTIVSg2000
opens with reactive limits respected and case14 without, and that a MATPOWER transformer without a rating reports no
loading, in the model and in its document.

## Requests

The browser and the `ps` program send the engine the same requests (`ps-study/src/api.rs`). A request names a kind,
carries options that override the document's study case for one run, and returns the report as JSON.

| Kind | Options | Report |
| --- | --- | --- |
| `loadflow` | `tolerance` (MVA), `maxIter`, `enforceQLimits`, `dcStart`, `loadScale` (%), `outages` (identifiers), `start` (`busIds`, `vm`, `va` in degrees) | buses, branches, units, totals, warnings, state, timing |
| `shortcircuit` | `fault` (`3ph`, `2ph`, `1ph`), `mode` (`max`, `min`), `kappa` (`B`, `C`), `lvTolerance` (`6`, `10`), `location` | per-bus Ik″, ip, Ith, Sk″, κ, Thévenin impedances; branch contributions |
| `contingency` | none | base case, ranked cases, worst loading per branch, voltage extremes per bus |
| `contingency_plan`, `contingency_chunk`, `contingency_merge` | none; `from`, `to`; the chunks | the outage list; one chunk; the merged report |
| `rms` | `tEnd`, `dt`, `events`, `maxSamples` | traces per machine and bus, events with what they did, stability verdict |

The WebAssembly module has one entry point, `ps_call`, which takes and returns an envelope: a little-endian u32
header length, a JSON header, and a payload (the document in, the report out). `ps_alloc` and `ps_free` manage the
buffers; the host provides `ps_now` (a clock) and `ps_progress`. `engine/crates/ps-wasm/src/engine.rs` lists the
operations.

## Numerical methods and scale

All matrices are sparse. Measured on an Apple M5 Pro for a full AC load flow from a MATPOWER file through the model,
topology and per-unit network to a mismatch of 1 VA, best of three; WebAssembly in a Web Worker in Chromium 156 and
under Node 26:

| Case | Buses | Native | Chromium worker | Node | Engine memory |
| --- | --- | --- | --- | --- | --- |
| ACTIVSg2000 | 2,000 | 22 ms | 23 ms | 23 ms | 7 MB |
| ACTIVSg10k | 10,000 | 81 ms | 86 ms | 85 ms | 27 MB |
| PEGASE 13659 | 13,659 | 93 ms | | 100 ms | 40 MB |
| ACTIVSg25k | 25,000 | 285 ms | 295 ms | 297 ms | 68 MB |
| ACTIVSg70k, warm start | 70,000 | 500 ms | 692 ms | 686 ms | 332 MB |

`node scripts/browser-bench.mjs <case.m>`, `node scripts/wasm-bench.mjs src/engine/powerstudio-engine.wasm <case.m>`
and `engine/target/release/ps bench <case.m>` reproduce them. ACTIVSg70k does not converge from a flat or DC start in PowerStudio or in PYPOWER; both
converge from the voltages stored in the case. The short-circuit calculation solves once per faulted bus, which
suits networks up to a few thousand buses; national-scale short circuit is phase 6 of the design.
