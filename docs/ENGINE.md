# The calculation engine

This document states what every PowerStudio calculation computes, with which model, and how each result is checked.
The engine is written in Rust (`engine/`). It compiles to WebAssembly for the browser and to a native program, `ps`,
for tests and benchmarks; both run the same code. `docs/research/sources.md` lists where every reference value comes
from, and `docs/design/NATIONAL-GRADE.md` sets out where the engine is going.

## From document to result

Every calculation follows the same path, one crate per step:

1. **Import** (`ps-io`). A PowerStudio document (`powerstudio.rs`) or a MATPOWER case (`matpower.rs`,
   `matpower_model.rs`) becomes the canonical model.
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
tolerance (1 kVA by default). When a full Newton step makes the mismatch markedly worse, the step is halved, up to
four times.

- **Start.** Voltage magnitudes start at their setpoints or 1 p.u., angles at the nominal angles (every transformer
  phase shift applied outward from the reference). A DC load flow that includes the phase shifts then sets the
  angles. The Riverside sample, a meshed 20 kV ring with Yd5 and Dy5 transformers, needs it: pandapower's flat start
  does not converge on it in 50 iterations; with a DC start both programs converge in 3. The study case can switch to
  a flat start. A warm start (contingency cases, models that carry a solution) starts from the previous voltages.
- **Reactive limits.** With "Respect reactive power limits" on, machines outside their range after convergence are
  held at the violated limit and the load flow is solved again, until no machine is outside its range. A machine
  that reaches a limit in a later round is caught too (the `ieee14-qlim` case: G2 reaches 50 Mvar only after G4 and
  G5 are held).
- **Results.** Voltages, branch flows and currents at both ends, losses, loading (current against the permanent
  limit for lines, apparent power against the rating for transformers), the output of every machine and grid
  (reference units share their bus's balance; PV machines share the reactive balance in proportion to their reactive
  range, as MATPOWER does), the iteration log and the time spent.

**Checked by** `engine/crates/ps-study/tests/loadflow.rs` (native) and `tests/loadflow.test.mjs` (WebAssembly):
MATPOWER case14, case30 and case118 agree with PYPOWER to |ΔU| < 1e-9 p.u. and |Δθ| < 1e-7°; the IEEE 14 and
Riverside samples agree with pandapower in voltages, branch flows (1e-6 MW) and machine outputs, with and without
reactive limits; power balances at every bus, computed from the reported flows.

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

## N-1 contingency analysis

`ps-study::contingency` takes each selected line, transformer or machine out in turn (lines, then transformers, then
machines, each in model order) and solves the load flow again from the base-case voltages. Each case lists its
highest loading, its voltage extremes, buses it cuts off and its violations of the study case loading limit and of
every node's voltage band, marking those already present in the base case. Cases are ranked with unsolvable cases
first, then by the number of violations, then by highest loading.

The outages split into contiguous chunks. The browser runs the chunks on a pool of workers (one engine instance
each, up to eight) and the engine merges them in outage order, keeping the first case on ties, so the result is
identical to a sequential run whatever the pool size.

**Checked by** `engine/crates/ps-study/tests/contingency.rs` and `tests/contingency.test.mjs`: every case equals a
separate load flow with that element out; Line 1-2 out overloads Line 1-5 on the IEEE 14 sample; radial outages
report the lost nodes; runs split into 2, 3 and 7 chunks merge to exactly the sequential report.

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

There are two MATPOWER importers. The app's (`src/core/matpower.js`) turns a case into a PowerStudio document with a
diagram laid out by `src/core/layout.js`: lines get a length of 1 km and their total impedance per km, transformer
line charging becomes two shunts with exactly MATPOWER's admittances, and phase shifts that are not multiples of
30° are dropped with a warning. The engine's (`ps-io`) goes straight to the model and is exact for everything
MATPOWER describes: transformers keep arbitrary phase shifts and carry their charging as magnetising admittance,
generators keep their active power limits, and buses keep the case's stored voltages for warm starts. MATPOWER has no
zero-sequence, machine or inertia data; both importers fill them with stated typical values and list them in the
import's issues.

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
