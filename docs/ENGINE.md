# The calculation engine

This document states what every PowerStudio calculation computes, with which model, and how each result is checked.
The code lives in `src/core/`, which has no DOM access, so the same modules run in Node (the tests), in the calculation
worker and, as a fallback, on the browser's main thread. `docs/research/sources.md` lists where every reference value
comes from.

## Units and per unit

The document stores engineering values: kV, MW, Mvar, MVA, Ω/km, µS/km and percentages, as an engineer types them.
`src/core/network.js` converts them to per unit on two bases: the document's base power (100 MVA unless changed) and
each busbar's nominal voltage. Every branch becomes a two-port with admittances `yff`, `yft`, `ytf` and `ytt` in the
MATPOWER convention, so load flow, short circuit and the stability model build their matrices from the same numbers.

| Element | Model |
| --- | --- |
| Line | π model. Series impedance (R′ + jX′)·length / parallel systems, shunt susceptance B′·length·parallel systems split between both ends. Zero sequence uses R0′, X0′ and B0′. |
| Transformer | Series impedance from uk and uR on the rated power, referred to the LV busbar. Magnetising admittance from i0 and iron losses, split between both ends. An ideal transformer with ratio t = τ·e^{jθ} at the HV end: τ = (UrHV·(1 + n·step/100)/UrLV)/(UbHV/UbLV), θ = clock number × 30°, the LV side lagging. |
| Synchronous machine | Load flow: PV (P and |U| held), PQ (P and Q held) or Reference (|U| and angle held). Short circuit: KG·(RG + jX″d). Stability: E′ behind x′d with inertia H. |
| External grid | Load flow: reference with |U| and angle held. Short circuit: c·Un²/Sk″ with the given R/X; zero sequence from X0/X1 and R0/X0. Stability: a constant voltage behind its short-circuit impedance. |
| Load | Constant P and Q, scaled by the study case load scaling. Stability: a constant admittance at its load-flow voltage. |
| Shunt | Constant admittance from Q (positive for a capacitor) and P at its rated voltage. |

Busbars that cannot reach a source through switched-in branches are de-energised and left out. An island with
machines but no reference gets its largest machine as reference, with a warning.

## Load flow

`src/core/loadflow.js` solves the AC power-flow equations S = V·conj(Y·V) by the Newton-Raphson method in polar
coordinates. The Jacobian is built from ∂S/∂θ and ∂S/∂|V| (the formulation of MATPOWER's `dSbus_dV`) and solved
with a dense LU factorisation with partial pivoting (`src/core/linalg.js`). Iterations stop when the largest power
mismatch is below the study case tolerance (1 kVA by default).

- **Start.** Voltage magnitudes start at their setpoints or 1 p.u. Angles start from a DC load flow
  (`src/core/dcflow.js`) that includes every transformer phase shift. The Riverside sample, a meshed 20 kV ring with
  Yd5 and Dy5 transformers, is the case that needs it: pandapower's flat start does not converge on it in 50
  iterations; with a DC start both programs converge in 3. The study case can switch to a flat start.
- **Reactive limits.** With "Respect reactive power limits" on, machines outside their range after convergence are
  held at the violated limit and the load flow is solved again, until no machine is outside its range. A machine
  that reaches a limit in a later round is caught too (the `ieee14-qlim` test case hits this: G2 reaches 50 Mvar only
  after G4 and G5 are held).
- **Results.** Voltages, branch flows and currents at both ends, losses, loading (current against the rating for
  lines, apparent power against the rated power for transformers), the output of every machine and grid, and the
  iteration log.

**Checked by** `tests/loadflow.test.mjs`: MATPOWER case14, case30 and case118 imported from their files and solved
agree with PYPOWER to |ΔU| < 1e-9 p.u. and |Δθ| < 1e-7°; the IEEE 14 and Riverside samples agree with pandapower in
voltages, branch flows (1e-6 MW) and machine outputs, with and without reactive limits; and power balances at every
busbar, computed independently from the bus admittance matrix.

## Short circuit

`src/core/shortcircuit.js` implements the method of the equivalent voltage source at the fault location of
IEC 60909-0. **It is IEC 60909-style, not certified**: the formulas follow pandapower 3.5.6's implementation of the
standard (see `docs/research/sources.md`), and PowerStudio agrees with pandapower on both samples, maximum and
minimum, to about 1e-15 relative for three-phase and line-to-line faults and within 2e-8 for earth faults. The
earth-fault difference comes from the tiny numerical earthing each program adds to otherwise isolated
zero-sequence networks.

- The only source is c·Un/√3 at the faulted busbar. Machines, grids and transformers become impedances; loads,
  shunts, line capacitances (positive sequence) and transformer magnetising branches are left out.
- Voltage factor: cmax 1.10 and cmin 1.00 above 1 kV; below 1 kV cmax 1.05 or 1.10 and cmin 0.95 or 0.90 for the
  6 % and 10 % tolerance settings.
- Transformer correction KT = 0.95·cmax/(1 + 0.6·xT) in the maximum case, with cmax of the LV busbar.
- Generator correction KG = Un/UrG · cmax/(1 + x″d·sin φrG), in both cases.
- Thevenin impedances Zkk come from solving Y·z = e_k for each busbar, in the positive sequence and, for earth
  faults, in the zero sequence. Ik″ = c·Un/(√3·|Z1|), c·Un/|2·Z1| and √3·c·Un/|2·Z1 + Z0|.
- Zero sequence: YNyn transformers pass zero-sequence current; Dyn and YNd provide an earth path on their earthed
  side; Yy, Dd, Yd and Dy block it. Line B0 is kept. Generators are unearthed. Every busbar gets 1e-10 p.u. to earth
  so isolated zero-sequence networks stay solvable; their earth-fault current reads about zero.
- Peak current ip = κ·√2·Ik″. Method C (default) evaluates R/X at the equivalent frequency (20 Hz for 50 Hz systems)
  with the fictitious generator resistances (0.05, 0.07 or 0.15 of X″d). Method B uses κ of the fault R/X, multiplied
  by 1.15 when any branch has R/X ≥ 0.3, capped at 2.0 (1.8 below 1 kV); method B is checked against its formula,
  not against pandapower.
- Thermal equivalent current Ith = Ik″·√(m + n) for Tk = 1 s with n = 1 (far from generators), as pandapower does.
- With a single fault location, the contribution of every branch is computed from the voltage changes −Z(:,k)·If.

**Checked by** `tests/shortcircuit.test.mjs`: Ik″, ip and Ith against pandapower at every busbar of both samples
for all twelve combinations of fault type and case (ip and Ith for earth faults are not reported by pandapower);
a hand calculation for a single infeed; Kirchhoff's current law at the fault for the branch contributions.

## N-1 contingency analysis

`src/core/contingency.js` takes each selected line, transformer or machine out in turn and solves the load flow
again from the base-case voltages. Each case lists its highest loading, its voltage extremes, busbars it cuts off and
its violations of the study case loading limit and of every busbar's voltage band, marking those already present in
the base case. Cases are ranked with unsolvable cases first, then by the number of violations.

**Checked by** `tests/contingency.test.mjs`: every case equals a separate load flow with that element out; Line 1-2
out overloads Line 1-5 on the IEEE 14 sample; radial outages report the lost busbars.

## Stability (RMS simulation)

`src/core/rms.js` runs an electromechanical simulation with the classical model: every machine is a constant voltage
E′ behind x′d whose angle follows the swing equation 2H·dω/dt = Pm − Pe − D·(ω − 1), dδ/dt = ωs·(ω − 1), on the
system base. E′ and δ0 come from the load flow; loads become constant admittances; external grids are constant
voltages behind their short-circuit impedance. The network is solved algebraically at every stage of a fourth-order
Runge-Kutta step (1 ms by default). Events at given times apply a three-phase fault at a busbar (1e6 p.u. to earth),
clear it, switch out a branch, machine or load, or scale a load. Angles are reported against the external grid when
there is one, otherwise against the centre of inertia, and net of transformer phase shifts. A machine more than 180°
from another is reported as loss of synchronism.

**Checked by** `tests/rms.test.mjs`: on a single machine against an infinite bus, clearing 2 % before the
equal-area critical clearing time stays in step and 2 % after it does not; small oscillations follow the
linearised swing frequency within 1 %; undisturbed operation stays at its load-flow equilibrium.

## MATPOWER import

`src/core/matpower.js` reads MATPOWER version 2 case files. Lines get a length of 1 km and their total impedance
per km. Branches between equal voltages with ratio 0 or 1 and no shift become lines; all others become transformers
rated at the system base, with the off-nominal ratio in the HV rated voltage. Transformer line charging becomes two
shunts with exactly MATPOWER's admittances (b/2τ² at the tap end, b/2 at the other). Phase shifts that are not
multiples of 30° are dropped with a warning. Busbars without a base voltage get 110 kV, with a warning. The diagram
is laid out by `src/core/layout.js` (a deterministic force-directed layout).

## Numerical methods and limits

All matrices are dense. The LU factorisation is O(n³), which is fast for the networks a browser diagram holds
(case118 solves in about 25 ms including import) and becomes slow beyond a few hundred busbars. Results stay correct
at larger sizes; only time grows.
