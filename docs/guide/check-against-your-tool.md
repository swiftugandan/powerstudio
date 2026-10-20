# Check PowerStudio against your own tool

Your acceptance test is agreement with your own tool on your own model. This chapter shows you how to export the model, run the same studies in both tools and find where the results differ.

You compare with `ps compare`. It is a command-line program that runs the same engine as the app, natively, on your device. It sends nothing anywhere.

PowerStudio's own verification makes the comparison worth doing, but it cannot replace it. For that verification, see [the testing guide](../TESTING.md) and [the test report](../TEST-REPORT.md).

**Warning.** Agreement with your tool does not certify PowerStudio. Its short-circuit calculation is IEC 60909-style, not certified. Check results that matter with a validated tool.

## Gather what you need

You need 3 things:

- the model as CGMES or as PSS/E RAW. CGMES is version 2.4.15 or 3.0, with the EQ, TP, SSH, SV and boundary files, as XML files, a folder or a ZIP archive. RAW is version 32, 33 or 35.
- your tool's results for the studies you want to compare, as CSV tables
- the `ps` program, built from the PowerStudio repository

To build `ps`, run this command in a terminal, from the repository folder:

```sh
cd engine && cargo build --release -p ps-cli
```

The program is then at `engine/target/release/ps`.

## Prepare your tool's results

Put the tables in one folder. Each table is a CSV file with a header row. The file name says what the table holds.

Any subset of the tables works. Values are in the units the column names give. Cells may be quoted.

| File | Columns | What it holds |
| --- | --- | --- |
| `loadflow_buses.csv` | `bus, u_pu, angle_deg` | Each bus's voltage magnitude and angle |
| `loadflow_branches.csv` | `branch, p_from_mw, q_from_mvar, p_to_mw, q_to_mvar` | Each branch's flows at both ends |
| `shortcircuit_3ph_max.csv` | `bus, ikss_ka`, and optionally `ip_ka`, `ib_ka` | Initial short-circuit current, and optionally peak and breaking currents, for a fault at each bus |
| `contingency.csv` | `outage, branch, loading_pct` | A branch's loading with another element out |

For other short-circuit tables, change the fault type and the case in the file name. The fault type is `3ph`, `2ph` or `1ph`. The case is `max` or `min`.

For example, `shortcircuit_1ph_min.csv` holds minimum currents for line-to-earth faults. The columns are the same as in the table above.

## Name buses and branches

Name buses and branches the way your tool names them. These names work:

- **PSS/E**: a bus by its number (`12`) and a branch by `from-to-circuit` (`4-7-1`), as RAW numbers them.
- **CGMES**: a bus by its TopologicalNode's mRID or name, or by a ConnectivityNode's mRID. A branch by its mRID.
- **Either format**: an element's name, where only one element has it.

`ps compare` lists every reference it cannot match. A naming mismatch shows in the report instead of passing silently.

## Run the comparison

Run this command:

```sh
ps compare <model files> --reference <folder> [--study <document.json>] [--qlim] [--out report.md] [--json]
```

These are the options:

- `--reference <folder>` is the folder that holds your tables.
- `--study <document.json>` uses the study case of a PowerStudio document.
- `--qlim` respects reactive power limits in the load flow.
- `--out report.md` writes the report to a file.
- `--json` writes the report as JSON instead of Markdown.

Without `--study`, PowerStudio solves the load flow with a plain Newton-Raphson method to 1e-6 MVA. With `--qlim`, it respects reactive limits.

To use the same tap, shunt and area controls as your tool, export your settings from the app. Select **File**, select **Export**, then select **PowerStudio file**. Pass that file with `--study`.

The study case also sets the short-circuit settings, such as the voltage factor tolerance, the fault impedance and the line temperature. The fault type and the case come from each table's file name.

## Read the report

The report is in Markdown, or JSON with `--json`. For each quantity, it lists:

- how many values were compared
- how many lie beyond the tolerance
- the largest difference

It then lists the largest differences one by one, and the references that name nothing in the model.

The exit status tells a script what happened:

| Exit status | Meaning |
| --- | --- |
| 0 | Every value is within its tolerance and every reference matched |
| 1 | A value is beyond its tolerance, or a reference matched nothing |
| 2 | The comparison could not run |

The tolerances are:

| Quantity | Tolerance |
| --- | --- |
| Voltage magnitude | 0.001 p.u. |
| Voltage angle | 0.1°, after removing the median difference (tools choose different reference angles) |
| Active and reactive power | 1 MW, 1 Mvar |
| Short-circuit currents | 1 % |
| Loading | 1 percentage point |

## Find out why a value differs

A difference is a question, not a verdict. Check the usual causes in this order:

1. **The model.** The export may have changed or left out a value. Run `ps cgmes <files>` or `ps psse <file>` to get PowerStudio's import report. It lists what it read, what it simplified and what it assumed. Compare the data the two tools hold for the element that differs most.
2. **The settings.** A control may be on in one tool and off in the other. Check tap changers, switched shunts, reactive limits and distributed slack. For short circuits, check the voltage factor, the fault impedance and the line temperature.
3. **The method.** The tools may model something differently. [The engine description](../ENGINE.md) says what PowerStudio computes, element by element, and what it leaves out.

Here is an example of the first kind, from this project's own checks. CGMES's MiniGrid configuration is the IEC TR 60909-4 test network. Its three-phase short-circuit currents, compared with the report's values, put 3 buses beyond 1 %. The largest difference is 2.4 % at the 110 kV bus that machine G2 feeds.

The cause was the model. The files rate G2 at 150 MVA, where the report has 100 MVA. With the report's rating, every current agrees to 1e-4. See phase 6 in [the test report](../TEST-REPORT.md).

## See what the kit checks about itself

The test `engine/crates/ps-study/tests/compare.rs` runs a check of the comparison itself. It writes PowSyBl's load flow of the IEEE 14-bus PSS/E case as the kit's tables. Buses are by number, branches are by `from-to-circuit`, and angles are on another reference.

The test requires those tables to compare within tolerance. It then changes one voltage and adds a bus the model lacks, and requires the report to show both.

## Read more

- [Run a load flow](run-a-load-flow.md)
- [Find fault levels](find-fault-levels.md)
- [Reference](reference.md)
