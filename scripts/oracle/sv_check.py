"""Checks PowerStudio's CGMES state variables (SV) export against PowSyBl.

For every CGMES configuration PowerStudio solves, `ps cgmes <files> --sv` writes the SV of its load flow and the
same state by element (`--solution`). The script replaces the configuration's own SV with the exported one and has
PowSyBl read the files: PowSyBl takes SvPowerFlow as the terminal flows of every line, transformer, machine, load,
shunt and static var compensator, and the check is that those equal PowerStudio's, terminal by terminal. Voltages
are checked by the engine's own SV round trip (engine/crates/ps-study/tests/cgmes_sv.rs).

For information it also solves the network in PowSyBl (the goldens' settings) and reports how far that solution is
from the exported one. That difference includes the boundary-line convention the CGMES comparison test bridges
(PowSyBl puts a boundary line's whole shunt at its network end), so it is not part of the verdict.

It needs the release `ps` program (cd engine && cargo build --release -p ps-cli) and writes nothing into the
repository:

    python scripts/oracle/sv_check.py              # every case
    python scripts/oracle/sv_check.py microgrid-3  # one case
"""

import json
import subprocess
import sys
import tempfile
import warnings
from pathlib import Path

import pypowsybl.loadflow as lf

import cgmes
from olf import num

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[2]
PS = ROOT / "engine" / "target" / "release" / "ps"
FLOW_TOL = 1e-9


def is_sv(data):
    head = data[:4096].decode("utf-8", "replace")
    return "StateVariables" in head


def check(case, tmp):
    folder = Path(tmp) / case["name"]
    folder.mkdir()
    files = cgmes.xml_files(case)
    for k, (name, data) in enumerate(files):
        # Nested archives can hold folders (a spreadsheet's XML parts); the engine reads the CIM files only.
        (folder / f"{k}-{Path(name).name}").write_bytes(data)
    sv, solution = Path(tmp) / f"{case['name']}-SV.xml", Path(tmp) / f"{case['name']}.json"
    command = [str(PS), "cgmes", str(folder), "--sv", str(sv), "--solution", str(solution)]
    if case["start"] == "sv":
        command.append("--warm")
    run = subprocess.run(command, capture_output=True, text=True)
    if run.returncode != 0:
        return f"export failed: {run.stderr.strip()}"
    mine = json.loads(solution.read_text())["flows"]
    ours = [(name, data) for name, data in files if not is_sv(data)] + [("PowerStudio_SV.xml", sv.read_bytes())]
    n, params, _, _ = cgmes.network(case, ours)

    # What PowSyBl read from the SV, against PowerStudio's state.
    worst, at, compared = 0.0, "", 0
    tables = [
        (n.get_lines, ("1", "2")),
        (n.get_2_windings_transformers, ("1", "2")),
        (n.get_3_windings_transformers, ("1", "2", "3")),
        (n.get_generators, ("",)),
        (n.get_loads, ("",)),
        (n.get_shunt_compensators, ("",)),
        (n.get_static_var_compensators, ("",)),
    ]
    for get, sides in tables:
        for i, row in get().iterrows():
            flows = mine.get(i)
            if flows is None:
                continue
            for k, side in enumerate(sides):
                if k >= len(flows) or flows[k] is None:
                    continue
                for quantity, value in zip(("p", "q"), flows[k]):
                    read = num(row.get(f"{quantity}{side}"))
                    if read is None:
                        continue
                    compared += 1
                    if abs(read - value) > worst:
                        worst, at = abs(read - value), f"{i} {quantity}{side}"
    if compared == 0:
        return "PowSyBl read no flows from the exported SV"

    # For information: PowSyBl's own solution against the exported state.
    before = n.get_buses()
    results = lf.run_ac(n, parameters=params)
    after = n.get_buses()
    vls = n.get_voltage_levels()
    dv = 0.0
    for bus, b in after.iterrows():
        if num(b["v_mag"]) is not None and num(before.loc[bus, "v_mag"]) is not None:
            dv = max(dv, abs(b["v_mag"] - before.loc[bus, "v_mag"]) / vls.loc[b["voltage_level_id"], "nominal_v"])
    verdict = "ok" if worst <= FLOW_TOL else "DIFFERS"
    return (
        f"{verdict}: PowSyBl read {compared} flows, worst difference {worst:.1e} MW or Mvar{f' ({at})' if worst else ''}; "
        f"its own load flow {[r.status.name for r in results]} is {dv:.1e} p.u. from the exported voltages"
    )


if __name__ == "__main__":
    wanted = set(sys.argv[1:])
    failed = False
    with tempfile.TemporaryDirectory() as tmp:
        for case in cgmes.CASES["cases"]:
            if wanted and case["name"] not in wanted:
                continue
            if not case.get("loadflow", True):
                continue
            result = check(case, tmp)
            failed |= not result.startswith("ok")
            print(f"{case['name']:24} {result}")
    sys.exit(1 if failed else 0)
