"""Checks PowerStudio's PSS/E RAW export against PowSyBl: every CGMES and PSS/E reference case is exported by
`ps export` as RAW versions 33 and 35, read by pypowsybl and solved with the OpenLoadFlow settings in olf.py, and
PowSyBl's bus voltages are compared with PowerStudio's own load flow of the original model.

The engine's round-trip test (engine/crates/ps-study/tests/roundtrip.rs) reads the files back with PowerStudio's own
importer; this script shows an independent reader understands them the same way. It needs the release `ps` program
(cd engine && cargo build --release -p ps-cli) and writes nothing into the repository:

    python scripts/oracle/export_check.py             # every case
    python scripts/oracle/export_check.py ieee300     # one case

The corrections of psse.py apply to the exported files as to any RAW file (PowSyBl's reading of YQ, of machines
with QT = QB, and of tap steps near the stated ratio).
"""

import json
import subprocess
import sys
import tempfile
import warnings
from pathlib import Path

import pypowsybl as pp
import pypowsybl.loadflow as lf

import cgmes
import psse
from olf import num, parameters

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[2]
PS = ROOT / "engine" / "target" / "release" / "ps"
V_TOL, ANGLE_TOL = 1e-6, 1e-4


def cases(tmp):
    """(name, input paths) of every case whose load flow both tools solve as the file stands (a case the goldens
    solve without its HVDC links is left out)."""
    for case in psse.CASES["cases"]:
        if case.get("loadflow", True) and not case.get("without_hvdc"):
            yield case["name"], [str(psse.CACHE / psse.CASES["archives"][case["archive"]]["file"])]
    for case in cgmes.CASES["cases"]:
        if not case.get("loadflow", True) or case["start"] == "sv":
            continue
        folder = Path(tmp) / case["name"]
        folder.mkdir()
        for k, (name, data) in enumerate(cgmes.xml_files(case)):
            # Nested archives can hold folders (a spreadsheet's XML parts); the engine reads the CIM files only.
            (folder / f"{k}-{Path(name).name}").write_bytes(data)
        yield case["name"], [str(folder)]


def check(name, inputs, rev, tmp):
    raw, solution = Path(tmp) / f"{name}-{rev}.raw", Path(tmp) / f"{name}-{rev}.json"
    run = subprocess.run([str(PS), "export", *inputs, "--raw", str(rev), "--out", str(raw), "--solution", str(solution)], capture_output=True, text=True)
    if run.returncode != 0:
        return f"export failed: {run.stderr.strip()}"
    mine = json.loads(solution.read_text())
    if not mine["converged"]:
        return f"PowerStudio does not solve the original: {mine['message']}"
    try:
        n = pp.network.load(str(raw))
    except pp.PyPowsyblError as e:
        return f"PowSyBl cannot read the file: {e}"
    psse.corrections(n, raw, {})  # the exported cases keep their HVDC links
    slack = n.get_extensions("slackTerminal")
    results = lf.run_ac(n, parameters=parameters(sorted(slack["bus_id"]), "dc"))
    if not all(r.status.name in ("CONVERGED", "NO_CALCULATION") for r in results):
        return f"PowSyBl: {[r.status.name for r in results]}"
    buses = n.get_bus_breaker_view_buses(all_attributes=True)
    vls = n.get_voltage_levels()
    reference = None
    for _, row in buses.loc[buses["bus_id"].isin(slack["bus_id"])].iterrows():
        reference = row.name
        break
    their_ref = num(buses.loc[reference, "v_angle"])
    my_ref = mine["buses"][reference[1:]][1]
    dv = da = 0.0
    worst = ""
    for number, (vm, va) in mine["buses"].items():
        b = buses.loc[f"B{number}"]
        v = num(b["v_mag"])
        if v is None:
            return f"bus {number} is not solved by PowSyBl"
        v /= vls.loc[b["voltage_level_id"], "nominal_v"]
        a = num(b["v_angle"]) - their_ref
        if abs(v - vm) > dv:
            dv, worst = abs(v - vm), f"B{number}"
        da = max(da, abs(a - (va - my_ref)))
    verdict = "ok" if dv <= V_TOL and da <= ANGLE_TOL else "DIFFERS"
    return f"{verdict}: V {dv:.1e} p.u. (worst {worst}), angle {da:.1e}°"


if __name__ == "__main__":
    wanted = set(sys.argv[1:])
    failed = False
    with tempfile.TemporaryDirectory() as tmp:
        for name, inputs in cases(tmp):
            if wanted and name not in wanted:
                continue
            for rev in (33, 35):
                result = check(name, inputs, rev, tmp)
                failed |= not result.startswith("ok")
                print(f"{name:24} v{rev}  {result}")
    sys.exit(1 if failed else 0)
