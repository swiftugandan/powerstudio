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

## Reference solvers

The goldens in `tests/oracle/golden/` were written by `scripts/oracle/oracle.py` on 2026-10-09 with the packages
pinned in `scripts/oracle/requirements.txt`:

- PYPOWER 5.1.21 (`runpf`, Newton-Raphson, tolerance 1e-10 p.u.) solves the MATPOWER fixtures directly from their
  per-unit matrices. It is the Python port of MATPOWER and so checks the MATPOWER import and load flow conventions.
- pandapower 3.5.6 solves the exported sample networks: load flow (`runpp`, pi transformer model, DC start,
  tolerance 1e-9 MVA, with and without reactive limits) and short circuit (`calc_sc`, IEC 60909, maximum and
  minimum, three-phase, line-to-line and line-to-earth, peak current method C, Ith with Tk = 1 s).

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
