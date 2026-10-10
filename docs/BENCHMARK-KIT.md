# Operator benchmark kit

Acceptance by an operator means agreement with its own tool on its own model. This kit is the procedure: export the
model from your tool, run the same studies in both, and let `ps compare` say where the results differ and by how much.
PowerStudio's own verification (docs/TESTING.md, docs/TEST-REPORT.md) makes the comparison worth doing; it cannot
replace it.

## What you need

- The model as CGMES (2.4.15 or 3.0: EQ, TP, SSH, SV and the boundary set, as XML files, a folder or a ZIP archive) or
  as PSS/E RAW (version 32, 33 or 35).
- Your tool's results for the studies you want to compare, as CSV tables (below).
- The `ps` program, built from this repository: `cd engine && cargo build --release -p ps-cli`, then
  `engine/target/release/ps`. It runs the same engine as the app, natively, and sends nothing anywhere.

## The tables

Put the tables in one folder. Each is a CSV file with a header row; its name says what it holds, and any subset will
do. Values are in the units the column names give; cells may be quoted.

| File | Columns | What it holds |
| --- | --- | --- |
| `loadflow_buses.csv` | `bus, u_pu, angle_deg` | Each bus's voltage magnitude and angle |
| `loadflow_branches.csv` | `branch, p_from_mw, q_from_mvar, p_to_mw, q_to_mvar` | Each branch's flows at both ends |
| `shortcircuit_3ph_max.csv` (also `_min`, and `2ph`, `1ph`) | `bus, ikss_ka`, and optionally `ip_ka`, `ib_ka` | Initial short-circuit current (and peak and breaking currents) for a fault at each bus |
| `contingency.csv` | `outage, branch, loading_pct` | A branch's loading with another element out |

Buses and branches may be named the way your tool names them:

- **PSS/E**: a bus by its number (`12`), a branch by `from-to-circuit` (`4-7-1`), as RAW numbers them.
- **CGMES**: a bus by its TopologicalNode's mRID or name, or by a ConnectivityNode's mRID; a branch by its mRID.
- **Either**: an element's name, where only one element has it.

`ps compare` lists every reference it cannot match, so a naming mismatch shows instead of passing silently.

## Running the comparison

```sh
ps compare <model files> --reference <folder> [--study <document.json>] [--qlim] [--out report.md] [--json]
```

PowerStudio solves the load flow with a plain Newton-Raphson to 1e-6 MVA (`--qlim` respects reactive limits), or with
the study case of a PowerStudio document given with `--study`: export your settings from the app (File, Export,
PowerStudio file) to use the same tap, shunt and area controls and the same short-circuit settings as your tool. Short
circuits use the study case's settings with the fault type and case the table's name gives.

The report, in Markdown (or JSON with `--json`), lists for each quantity how many values were compared, how many lie
beyond the tolerance and the largest difference, then the largest differences one by one, then the references that name
nothing in the model. The exit status is 0 when every value is within its tolerance and every reference matched, 1
otherwise, and 2 when the comparison could not run.

| Quantity | Tolerance |
| --- | --- |
| Voltage magnitude | 0.001 p.u. |
| Voltage angle | 0.1°, after removing the median difference (tools choose different reference angles) |
| Active and reactive power | 1 MW, 1 Mvar |
| Short-circuit currents | 1 % |
| Loading | 1 percentage point |

## Reading the result

A difference is a question, not a verdict. The usual answers, in the order to check them:

1. **The model**: a value the export changed or left out. PowerStudio's import report (`ps cgmes <files>` or
   `ps psse <file>`) lists what it read, what it simplified and what it assumed. Comparing the data the two tools hold
   for the element that differs most usually finds it.
2. **The settings**: controls on in one tool and off in the other (tap changers, switched shunts, reactive limits,
   distributed slack), or a different voltage factor, fault impedance or line temperature for short circuits.
3. **The method**: where the tools model something differently. docs/ENGINE.md says what PowerStudio computes, element
   by element, and what it leaves out.

An example of the first kind, from this project's own checks: CGMES's MiniGrid configuration is the IEC TR 60909-4 test
network, and comparing its three-phase short-circuit currents with the report's values puts three buses beyond 1 %, the
largest 2.4 % at the 110 kV bus that machine G2 feeds. The files rate G2 at 150 MVA where the report has 100 MVA; with
the report's rating every current agrees to 1e-4 (docs/TEST-REPORT.md, phase 6).

## What the kit checks itself

`engine/crates/ps-study/tests/compare.rs` writes PowSyBl's load flow of the IEEE 14-bus PSS/E case as the kit's tables
(buses by number, branches by `from-to-circuit`, angles on another reference) and requires them to compare within
tolerance, then changes one voltage and adds a bus the model lacks and requires both to be reported.
