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
pypowsybl and the same OpenLoadFlow settings (`scripts/oracle/olf.py`). Five corrections bring PowSyBl's network in
line with the PSS/E definitions before the load flow; each is recorded in the golden's `corrected` field:

- Identifiers lose their blanks: PowSyBl keeps the padding of quoted identifiers ("B1-G1 ").
- A load's constant-admittance reactive part enters as Q0 = QL + IQ − YQ. The PSS/E data format defines YQ as negative
  for an inductive load; MATPOWER's `psse_convert.m` (https://github.com/MATPOWER/matpower, `lib/psse_convert.m`)
  subtracts it with the comment "reactive power component of constant admittance load is negative quantity for
  inductive load"; PowSyBl 1.16.1 adds it (`LoadConverter`).
- Generators on type 2 and 3 buses whose reactive range is empty keep their voltage control. PowSyBl turns it off
  and says why in `GeneratorConverter`: "we consider < but psse accepts bus type 2 with Qmin == Qmax".
- HVDC links and their converter stations are removed, because PowerStudio does not model HVDC yet (phase 3 drops
  this correction). Without it, IEEE 300 differs around its link at bus 120; with it, it agrees to 2e-12 p.u.
- A transformer keeps its stated winding ratio. PowSyBl replaces it with a tap step within 1e-5 of it
  (`TransformerConverter.TOLERANCE`), which moved IEEE 39 by 1.5e-6 p.u. before the correction.

PowSyBl's PSS/E conversion rules were read in its source (`TransformerConverter`, `LineConverter`,
`SwitchedShuntCompensatorConverter`, `FactsDeviceConverter`, `VoltageLevelConverter`, `AbstractConverter` in
`psse/psse-converter`) to match identifiers, winding codes CW, CZ and CM, the star equivalent of three-winding
units, switched shunt levels and node-breaker connectivity. Where PowerStudio differs on purpose, the comparison test
(`engine/crates/ps-study/tests/psse.rs`) bridges it and says why: a branch between buses of different base voltage
is a transformer at the ratio of the bases in PowerStudio and a line with compensating end shunts in PowSyBl; and
the on and off state of tap controls follows the sign of COD in PowerStudio, which PowSyBl does not read.

The oracle removes one pandapower modelling choice so both programs describe the same network: pandapower adds a
placeholder zero-sequence admittance of 1/(1000 + 1000j) p.u. at generator buses; PowerStudio models generator
neutrals as unearthed. pandapower's transformer zero-sequence magnetising impedance is set very large
(`mag0_percent = 1e12`) for the same reason.

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
