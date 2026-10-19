# Electromagnetic transients: design (ADR 16)

Issue [#5](https://github.com/swiftugandan/powerstudio/issues/5) asks for electromagnetic transient (EMT) studies
beside the RMS simulation. This record refines the issue into the first shippable slice and fixes its decisions. The
slice ships as the `emt` study; RMS stays the default for electromechanical swings, controls and long horizons.

## What the first slice does

A user opens a sample (Riverside or IEEE 14), sets an EMT event list in the study case (a fault at a busbar, its
clearing, a branch or load switched out and back in), runs **Calculate › EMT simulation** and reads the phase voltages
and currents of any busbar, branch, source or fault as waveforms, with peak values on the diagram and in a table, and
exports them as CSV. The engine documentation states what is modelled and what is not.

| Question | Decision |
| --- | --- |
| Solver class | Nodal analysis with trapezoidal companion models (Dommel's method, the EMTP family's), fixed step |
| Network | Full three-phase (phase a, b, c and neutral nodes), not positive sequence: the faults users ask EMT for are mostly unbalanced, and the vector groups' zero-sequence paths and ±30° shifts must come out of the windings, not be imposed |
| Time step | 50 µs by default (1 to 1,000 µs); 0.2 s simulated by default (up to 10 s) |
| Numerical oscillation | Critical damping adjustment: after every switching, two backward-Euler half steps. Their conductance matrix is the trapezoidal one, so no refactorisation is needed for them |
| Lines | Constant-parameter travelling-wave model (Bergeron, losses lumped at the ends and middle) in Clarke modal components where every mode's travel time is at least one step; otherwise a coupled π model. The study case can force π everywhere |
| Transformers | Per leg: an ideal transformer between the two windings' leg voltages with the leakage impedance on the second side and the magnetising branch on either side, the windings connected as their vector group says (star, earthed star with its neutral impedance, delta). The ±30° shifts and the zero-sequence paths follow from the connections; a further shift (phase shifter, tap angle) is a real 3 × 3 rotation that turns the positive sequence by the angle and leaves the zero sequence alone |
| Sources | Synchronous machines: a constant EMF behind the subtransient impedance, star with the neutral earthed or not as the machine's data say. External grids and network feeders: a constant EMF behind their short-circuit impedance with its zero-sequence ratio. Converter-fed sources: balanced sinusoidal current at their load-flow output. No rotor or control dynamics in this slice |
| Loads and shunts | Loads: R in parallel with L or C per phase, earthed star, from their load-flow consumption. Shunts, static var compensators and HVDC stations: their load-flow admittance |
| Switching | Every element connects to its busbar through a three-pole breaker (a small resistance when closed). A trip opens each pole at the first current zero after the command, as an arc would go out; closing closes all poles at the command's time. Faults: three-phase to earth, line to line, two-phase to earth or line to earth, through a resistance; a clearing extinguishes each faulted phase at its current zero |
| Initial state | The load flow solves first; the three-phase phasor solution of the EMT network itself at the system frequency (sources at their load-flow EMFs, loads at their load-flow impedances) sets every inductor current, capacitor voltage and travelling-wave history, so the simulation starts in steady state |
| Out-of-service elements | Lines, transformers, loads and shunts out of service but with both busbars energised are built with open breakers, so "switch in" energises them (line and capacitor bank energisation) |
| Results | Per busbar the three phase-to-earth voltages (kV); per branch the three phase currents at each end (kA); per source and fault the phase currents; peaks and one-cycle RMS extremes computed at every step, not from the decimated traces; every pole operation with its time |
| Report size | At most 10,000 samples per trace and 6 million values in all, uniformly decimated; statistics always at full resolution |
| Browser and WebAssembly | The same engine and worker path as every study: one request, progress by simulated time, cancellation by ending the worker. Every array is real; the matrix is ordered once and refactorised only when a pole or fault changes |
| Results next to RMS | A separate study kind (`emt`) with its own dock tab, report section and study case section; the RMS study is unchanged |
| Validation | ngspice (an independent circuit simulator) on networks the oracle rebuilds in SI units from the document, started from ngspice's own AC solution, with pandapower's load flow giving the operating point; closed-form solutions; the engine's own load flow for the initial state |

## Decisions and their alternatives

**Three-phase from the first slice.** A positive-sequence EMT (as some tools offer first) would show three-phase
faults only and could not show why EMT is asked for: earth faults on networks earthed in different ways, the 30°
shifts of delta windings on unbalanced currents, the DC offset per phase. The three-phase network costs three unknowns
per node where positive sequence costs one; the samples and networks of a few thousand busbars stay well within a
step's budget.

**Breakers on every element, not removal of elements.** Removing an element's stamps at a trip interrupts inductor
currents instantly, a numerical event no breaker makes; a breaker that opens at current zero leaves the element's
stored energy where physics leaves it (trapped charge on a line, a load's inductor current decaying through its
resistance), so reclosure onto trapped charge and capacitor energisation come out right. The cost is three extra nodes
per connection.

**Bergeron lines with automatic fallback.** A π model cannot show travelling waves, but a line whose travel time is
below the step cannot be a Bergeron line. Choosing per line keeps the default step (50 µs) usable on distribution
networks, whose cables are short, and the report counts each kind. Frequency-dependent line models (J. Marti,
universal line model) need fitted rational approximations of line constants that the document does not hold: later.

**Fixed step with critical damping adjustment.** Variable steps buy little for networks with switching every few
milliseconds and complicate travelling-wave histories. The trapezoidal rule's oscillation after switching is removed by
two backward-Euler half steps (the companion conductances are equal, so the factorisation stays); a pole that opens at
a current zero is detected at the first step past it.

**Constant EMF sources in the first slice.** Machine and converter dynamics are the issue's third phase. Without them
an EMT study is valid for the first cycles (fault inception, DC offsets, switching overvoltages, travelling waves);
longer windows belong to RMS. The engine documentation and the UI say so.

**ngspice as the oracle.** SPICE solves the same circuit equations by a different program, with its own integration
and step control; nothing of the engine is shared, not even the per-unit conversion. Where SPICE lacks an element
(the coupled resistance of a line's zero sequence, an ideal transformer), the oracle builds it from controlled sources.
Switching at a current zero is not compared with SPICE (a SPICE switch is time-controlled); a test option makes the
engine's breakers open at the command so the switching itself can be compared, and the current-zero rule has its own
tests.

## Not in the first slice

Machine, exciter and governor dynamics in EMT; converter controls (grid-following, grid-forming); transformer
saturation, inrush and residual flux; surge arresters and other non-linear elements; frequency-dependent lines;
three-winding transformers with their own core model (they are built from their star equivalent); zigzag windings;
harmonics and frequency scans; RMS–EMT co-simulation. No claim of compliance with any grid code or EMT standard is
made.

## Later phases

1. **Machines and converters**: a synchronous machine in d-q coordinates with the RMS library's exciters and governors
   on its terminals; a converter as an average model with current control and a phase-locked loop.
2. **Non-linear elements**: surge arresters, transformer saturation and inrush (compensation method on top of the
   linear network).
3. **Grid-code checks** (issue #4) that need EMT: fault ride-through of converter-fed sources with their controls.
