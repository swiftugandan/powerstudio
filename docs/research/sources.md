# Sources

Every number PowerStudio checks itself against comes from one of these sources. Nothing in the tests is typed in
from memory.

## Benchmark networks

`tests/fixtures/case14.m`, `case30.m` and `case118.m` are MATPOWER case files, fetched unchanged from the MATPOWER
repository at tag 8.0:

- https://raw.githubusercontent.com/MATPOWER/matpower/8.0/data/case14.m
- https://raw.githubusercontent.com/MATPOWER/matpower/8.0/data/case30.m
- https://raw.githubusercontent.com/MATPOWER/matpower/8.0/data/case118.m

MATPOWER is distributed under the 3-clause BSD licence (Copyright (c) 1996-2024, Power Systems Engineering Research
Center (PSERC) and individual contributors). case14 and case118 were converted by MATPOWER from the IEEE Common
Data Format files of the University of Washington Power Systems Test Case Archive. The IEEE 14-bus sample in
`src/samples/ieee14.js` reproduces the per-unit data of case14; its nominal voltages, line lengths, ratings,
transformer sizes and machine data are assumptions, stated as such in the sample's description.

The CGMES test configurations are the ENTSO-E CGMES Conformity Assessment Scheme packages, downloaded by
`scripts/fetch-reference.mjs` and checked against the SHA-256 values pinned in `tests/oracle/cgmes-cases.json`:

- CGMES 3.0 test configurations v3.0.3 (MicroGrid, MiniGrid, SmallGrid, FullGrid, Svedala, PST, PowerFlow, RealGrid),
  https://www.entsoe.eu/Documents/CIM_documents/Grid_Model_CIM/CGMES_ConformityAssessmentScheme_TestConfigurations_v3-0-3.zip,
  © ENTSO-E, licensed CC BY-NC-SA 4.0.
- CGMES 2.4.15 test configurations v4.0.3 (MicroGrid base case, BE, NL and assembled),
  https://www.entsoe.eu/Documents/CIM_documents/Grid_Model_CIM/CGMES_v2.4.15_TestConfigurations_v4.0.3.zip,
  © ENTSO-E; the package states no licence.

Neither package is redistributed with this MIT-licensed repository; the tests read the files from the downloaded
archives. The goldens in `tests/oracle/golden/cgmes-*.json` hold results computed from them.

The large MATPOWER cases are the ACTIVSg synthetic grids (`case_ACTIVSg2000`, `10k`, `25k`, `70k`, from the Texas
A&M Electric Grid Test Case Repository) and the PEGASE cases (`case2869pegase`, `case9241pegase`, `case13659pegase`)
as distributed in MATPOWER's `data` folder (https://github.com/MATPOWER/matpower, commit
`2e0ef79a6c4526858ee923491d92781ad4507fb7`), listed with their SHA-256 values in `tests/oracle/matpower-cases.json`.
They are not copied into this repository; `tests/oracle/golden/matpower-*.json` hold results computed from them.

The PSS/E RAW cases are test resources of powsybl-core (https://github.com/powsybl/powsybl-core, MPL 2.0) at commit
`0a7e5410d41a7eee3ccf61fc8f6b39f145ab648d`, listed with their SHA-256 values in `tests/oracle/psse-cases.json` and
downloaded by the same script. They are version 33 and 35 files written by PSS/E and by PowSyBl: IEEE 14, 24, 39, 57,
118 and 300 buses, WSCC 9, the IEEE RTS-96, small transformer, switched shunt and remote control cases, node-breaker
exports, and two synthetic grids from the Texas A&M Electric Grid Test Case Repository (Illinois 200 and South
Carolina 500 buses) as included in powsybl-core. Their licences were not checked beyond powsybl-core's own, so the
files are not copied into this repository; `tests/oracle/golden/psse-*.json` hold results computed from them.

## Reference solvers

The goldens in `tests/oracle/golden/` were written by `scripts/oracle/oracle.py` on 2026-10-09 with the packages
pinned in `scripts/oracle/requirements.txt`:

- PYPOWER 5.1.21 (`runpf`, Newton-Raphson, tolerance 1e-10 p.u.) solves the MATPOWER fixtures directly from their
  per-unit matrices. It is the Python port of MATPOWER and so checks the MATPOWER import and load flow conventions.
- pandapower 3.5.6 solves the exported sample networks: load flow (`runpp`, pi transformer model, DC start,
  tolerance 1e-9 MVA, with and without reactive limits) and short circuit (`calc_sc`, IEC 60909, maximum and
  minimum, three-phase, line-to-line and line-to-earth, peak current method C, Ith with Tk = 1 s).

The CGMES goldens (`tests/oracle/golden/cgmes-*.json`) were written by `scripts/oracle/cgmes.py` with pypowsybl
1.16.1, the Python packaging of PowSyBl with its CGMES import and OpenLoadFlow. Each golden records the OpenLoadFlow
parameters it used. The script sets every control off (distributed slack, reactive limits, tap, shunt and
phase-shifter controls, remote voltage control), starts every generator and accepts every voltage target, chooses
the slack by PowerStudio's rule, and removes equipment whose SSH `Equipment.inService` is false, which PowSyBl's
CGMES import does not read. Two PowSyBl conventions differ from PowerStudio's and are bridged in the comparison
test (`engine/crates/ps-study/tests/cgmes.rs`), not in the engine: a line to a boundary point carries its whole
shunt admittance at the network end, and OpenLoadFlow reports a slack machine's active power as its target.
PowSyBl's conversion rules for tap changers (`TapChangerConversion`, `CgmesPhaseTapChangerBuilder`,
`InterpretedT2xModel`) and dangling and tie lines (`TieLineUtil`) were read in the powsybl-core source
(https://github.com/powsybl/powsybl-core, MPL 2.0) to match them.

The PSS/E goldens (`tests/oracle/golden/psse-*.json`) were written by `scripts/oracle/psse.py` with the same
pypowsybl and the same OpenLoadFlow settings (`scripts/oracle/olf.py`). Four corrections bring PowSyBl's network in
line with the PSS/E definitions before the load flow; each is recorded in the golden's `corrected` field:

- Identifiers lose their blanks: PowSyBl keeps the padding of quoted identifiers ("B1-G1 ").
- A load's constant-admittance reactive part enters as Q0 = QL + IQ − YQ. The PSS/E data format defines YQ as negative
  for an inductive load; MATPOWER's `psse_convert.m` (https://github.com/MATPOWER/matpower, `lib/psse_convert.m`)
  subtracts it with the comment "reactive power component of constant admittance load is negative quantity for
  inductive load"; PowSyBl 1.16.1 adds it (`LoadConverter`).
- Generators on type 2 and 3 buses whose reactive range is empty keep their voltage control. PowSyBl turns it off
  and says why in `GeneratorConverter`: "we consider < but psse accepts bus type 2 with Qmin == Qmax".
- A transformer keeps its stated winding ratio. PowSyBl replaces it with a tap step within 1e-5 of it
  (`TransformerConverter.TOLERANCE`), which moved IEEE 39 by 1.5e-6 p.u. before the correction.

One case, the completed IEEE 14 (version 35), is solved without its HVDC links: its setpoints (209 MW over one VSC
link in a system of about 260 MW) leave no solution, and neither PowSyBl nor PowerStudio converges with them.
`tests/oracle/psse-cases.json` marks it (`without_hvdc`) and the oracle and the tests both take the links out.

PowSyBl's PSS/E conversion rules were read in its source (`TransformerConverter`, `LineConverter`,
`SwitchedShuntCompensatorConverter`, `FactsDeviceConverter`, `VoltageLevelConverter`, `AbstractConverter` in
`psse/psse-converter`) to match identifiers, winding codes CW, CZ and CM, the star equivalent of three-winding
units, switched shunt levels and node-breaker connectivity. Where PowerStudio differs on purpose, the comparison test
(`engine/crates/ps-study/tests/psse.rs`) bridges it and says why: a branch between buses of different base voltage
is a transformer at the ratio of the bases in PowerStudio and a line with compensating end shunts in PowSyBl; and
the on and off state of tap controls follows the sign of COD in PowerStudio, which PowSyBl does not read.

The large MATPOWER goldens (`tests/oracle/golden/matpower-*.json`) were written by `scripts/oracle/matpower.py`,
which converts each `.m` file to the MAT-file layout PowSyBl's MATPOWER importer reads and checks that the case avoids
the three places where that importer departs from MATPOWER's definitions (`MatpowerImporter`: a generator with a
voltage set point regulates even on a PQ bus; a transformer's line charging becomes one magnetising admittance; every
generator on a bus keeps its own set point). None of the seven cases needs a correction.

OpenLoadFlow's `reactivePowerDispatchMode` is set to `K_EQUAL_PROPORTION` in every oracle: each machine on a bus at
the same fraction of its reactive range, the rule of MATPOWER's `pfsoln.m` that PowerStudio follows. OpenLoadFlow
falls back to an equal split when a machine's limits are implausible (`AbstractLfBus.dispatchQ`; beyond ±1,000 Mvar
or a range outside 1 to 10,000 Mvar, `PlausibleValues`), so the comparison checks those buses by their total.

The oracle removes one pandapower modelling choice so both programs describe the same network: pandapower adds a
placeholder zero-sequence admittance of 1/(1000 + 1000j) p.u. at generator buses; PowerStudio models generator
neutrals as unearthed. pandapower's transformer zero-sequence magnetising impedance is set very large
(`mag0_percent = 1e12`) for the same reason.

## Load flow controls

The controls goldens (`tests/oracle/golden/controls-*.json`, written by `scripts/oracle/controls.py`) run
OpenLoadFlow 2.3.0 (pypowsybl 1.16.1, powsybl-core 7.3.0) with one control at a time, all together, and with the
voltage targets of regulating two-winding tap changers and shunts raised by 2 % so the discrete controls move. The
rules PowerStudio reproduces were read in OpenLoadFlow's source (https://github.com/powsybl/powsybl-open-loadflow,
commit a651a514, tag v2.3.0); `engine/crates/ps-lf/src/control.rs` and `discrete.rs` restate them:

- the outer loops' order and the rule that a round ends at the last loop that changed something
  (`DefaultAcOuterLoopConfig`, `AcloadFlowEngine.runOuterLoop`);
- slack distribution from the initial targets with limits and no change of sign (`DistributedSlackOuterLoop`,
  `ActivePowerDistribution`, `GenerationActivePowerDistributionStep`, `LoadActivePowerDistributionStep`), with the
  participation checks of `AbstractLfGenerator.checkActivePowerControl` (maximum above 10,000 MW, target outside the
  active limits, a range under 1e-4 MW);
- reactive limits per controller bus, the strongest controller kept, release when the voltage passes the target, at
  most three releases (`ReactiveLimitsOuterLoop`, `AbstractLfBus.getMinQ`), and generators with a reactive range
  under 1 Mvar left out of voltage control when limits apply (`checkIfReactiveRangesAreLargeEnoughForVoltageControl`,
  `PlausibleValues.MIN_REACTIVE_RANGE`);
- shared voltage control by reactive keys, the sum of the machines' ranges or a uniform split when a range is
  implausible (`GeneratorVoltageControl`, `Control.createReactiveKeys`, `AcEquationSystemCreator` `DISTR_Q`);
- incremental tap changer, shunt and phase shifter control: sensitivities from the Jacobian at the converged state,
  the closest position within three steps (several tap changers on one bus: one step each per pass), at most four
  sections per round, a 0.05 insensitivity threshold for tap changers, direction locking after three reversals, a
  0.1 kV dead band when none is given, and the voltage target priority machine, tap changer, shunt
  (`IncrementalTransformerVoltageControlOuterLoop`, `IncrementalShuntVoltageControlOuterLoop`,
  `AcIncrementalPhaseControlOuterLoop`, `PiModelArray`, `IncrementalContextData`, `VoltageControl`);
- static var compensator limits B·V² at the solved voltage (`LfStaticVarCompensatorImpl`);
- voltage-dependent loads as P = p0·(c0 + c1·V + c2·V²) (`AbstractLoadModelEquationTerm`).

Two PowSyBl readings of PSS/E data differ from the data format and are corrected for the controls goldens: a load's
ZIP model is built with +YQ (`LoadConverter`), so the oracle reads a copy of the file with YQ negated; and phase
shifters' COD 3 regulation is usually dropped by PowSyBl's import (its regulating terminal is the first equipment on
bus CONT), so phase shifter control is checked by an engine test against its own definition instead.

HVDC links follow PowSyBl's setpoint model (`HvdcUtils.getConverterStationTargetP`, `getLccConverterStationLoadTargetQ`;
`LfVscConverterStationImpl`; `LfLoadImpl` for line-commutated stations) and its PSS/E conversion
(`TwoTerminalDcConverter`, `VscDcTransmissionLineConverter`): the rectifier draws the setpoint, the inverter delivers it
less the stations' losses and R·P²/V²; a line-commutated station consumes |P|·tan(acos pf) with pf = ½·(cos ANMX +
cos 60°). That power factor is PowSyBl's approximation of PSS/E's converter equations, which neither tool solves.

## Contingency analysis and sensitivities

The security goldens (`tests/oracle/golden/security-*.json`, written by `scripts/oracle/security.py`) are PowSyBl's
AC security analysis with OpenLoadFlow 2.3.0 (pypowsybl 1.16.1), the plain settings of `olf.py` and contingency
propagation off, over every single-element outage of the PSS/E reference cases and of ACTIVSg2000. They hold physics
only (flows and voltages of the elements each outage moves most), since the two tools judge limits by their own
rules. The DC sensitivity goldens (`sensitivity-*.json`, `scripts/oracle/sensitivity.py`) are PowSyBl's DC
sensitivity analysis of every branch flow to every generator's injection with the slack fixed, which is the PTDF of a
transfer to the slack bus; transformer ratios are left out of both DC models.

Each contingency starts from the base case's reactive limit state because OpenLoadFlow's security analysis does:
`NetworkState.save` keeps every bus's `BusState`, including whether its generator voltage control is enabled, after
the pre-contingency load flow, and `restore` puts it back before each contingency. The count of PQ-to-PV switches that
caps releases at three lives in `ReactiveLimitsOuterLoop`'s `ContextData`, which `initialize` creates afresh for every
run, so PowerStudio starts each contingency with the count at zero as well (OpenLoadFlow source at commit a651a514).

Screening uses the fast decoupled load flow of B. Stott and O. Alsac, "Fast decoupled load flow", IEEE Transactions on
Power Apparatus and Systems PAS-93 (1974) 859–869, in the XB form that R. A. M. van Amerongen compared with the
original in "A general-purpose version of the fast decoupled load flow", IEEE Transactions on Power Systems 4 (1989)
760–770: resistances are left out of B′ only. An outage enters B′ and B″ through the Woodbury identity
(M. A. Woodbury, "Inverting modified matrices", Memorandum Report 42, Statistical Research Group, Princeton, 1950),
the matrix inversion lemma of every compensation method for contingency analysis. Line outage distribution factors
follow from the PTDFs as in A. J. Wood, B. F. Wollenberg and G. B. Sheblé, Power Generation, Operation, and Control,
3rd edition, Wiley, 2014, chapter 7. No value in the tests comes from these texts; they describe the methods, and
the goldens and the full AC solution are the references.

## Area interchange

PowerStudio's area interchange control follows the PSS/E area record: ISW names the area slack bus, PDES the desired
net interchange and PTOL its tolerance, both in MW. That PDES is the net export (power leaving the area) is read from
the data rather than recalled: the IEEE 300 case in powsybl-core's test resources (`psse-ieee300.raw`, read in place
from .cache/reference) carries a solved state in which area 1 exports 94.1 MW against a PDES of +100 and areas 2 and
3 import 33.6 and 58.7 MW against −40 and −60 (each tie branch measured at its end inside the area), and the PDES
values sum to zero. PowSyBl is not used as the reference: its PSS/E importer (`AreaConverter`) copies PDES into an
interchange target that its grid model defines with the load sign convention, positive for import
(docs/grid_model/network_subnetwork.md in powsybl-core 7.3.0), and ignores ISW, and OpenLoadFlow's area interchange
loop spreads an area's correction over all its participating machines. The engine test
(`engine/crates/ps-study/tests/interchange.rs`) checks the definition on IEEE 300 and the two-area case instead.

## Short-circuit method

The voltage factors c, the correction factors KT and KG, the fictitious generator resistances, the peak factor κ
(methods B and C) and the thermal factor m follow IEC 60909-0. The standard's text is not freely available and was
not consulted for this project; the formulas and factor values were taken from pandapower's implementation
(`pandapower/build_bus.py` `_add_c_to_ppc`, `build_branch.py` `_transformer_correction_factor`,
`shortcircuit/ppc_conversion.py`, `shortcircuit/kappa.py`, `shortcircuit/currents.py`, version 3.5.6), whose
documentation states that it is validated against the IEC TR 60909-4 examples. PowerStudio's results agree with
pandapower's to about 1e-15 relative for three-phase and line-to-line faults and within 2e-8 for earth faults. That establishes agreement with pandapower, not certification against the
standard.

## Stability

The classical machine model and the equal-area criterion used by `tests/rms.test.mjs` are textbook material
(for example P. Kundur, *Power System Stability and Control*, 1994, chapters 3 and 13). The test derives the critical
clearing angle δcr = arccos[(π − 2δ0)·sin δ0 − cos δ0] and the clearing time t = √(4H(δcr − δ0)/(ωs·Pm)) for a
fault at the machine terminals, and the small-signal frequency f = √(ωs·Ks/2H)/2π, then checks the simulation
against them.
