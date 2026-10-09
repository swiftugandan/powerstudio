"""Writes the large MATPOWER goldens: PowSyBl's load flow of each case in tests/oracle/matpower-cases.json.

PowSyBl (pypowsybl, with OpenLoadFlow and the settings in olf.py) reads MATPOWER cases as MAT-files only, so this
script reads the .m file (base MVA, bus, gen and branch matrices), writes it as a MAT-file in MATPOWER's layout and
imports that. The goldens hold arrays in the case's own row order, to 12 significant digits: bus voltages (p.u. and
degrees), generator outputs and, unless the case says "flows": false, branch flows (MW and Mvar at each end, load
convention). Without flows the 70,000-bus golden stays near 3 MB; the voltages still expose any branch data error.

PowSyBl's MATPOWER import departs from MATPOWER's definitions in three places, none of which occurs in these cases;
the script checks each and stops if a case would need a correction:

* a generator with a nonzero voltage set point regulates even on a PQ bus, where MATPOWER holds its Q;
* a transformer's line charging B becomes one magnetising admittance, where MATPOWER splits it over the pi model;
* every generator on a bus regulates to its own set point, where MATPOWER uses the first one's.

The files are read in place from .cache/reference (run node scripts/fetch-reference.mjs first):

    python scripts/oracle/matpower.py              # every case
    python scripts/oracle/matpower.py activsg2000  # one case
"""

import json
import re
import sys
import tempfile
import warnings
from importlib.metadata import version
from pathlib import Path

import numpy as np
import pypowsybl as pp
import pypowsybl.loadflow as lf
import scipy.io

from olf import num, parameters

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[2]
CASES = json.loads((ROOT / "tests" / "oracle" / "matpower-cases.json").read_text())
GOLDEN = ROOT / "tests" / "oracle" / "golden"
CACHE = ROOT / ".cache" / "reference"

# MATPOWER column indices (0-based).
BUS_I, BUS_TYPE, BASE_KV = 0, 1, 9
GEN_BUS, VG, GEN_STATUS = 0, 5, 7
F_BUS, T_BUS, BR_B, TAP, SHIFT, BR_STATUS = 0, 1, 4, 8, 9, 10


def read_m(path):
    """The base MVA and the bus, gen and branch matrices of a MATPOWER .m file."""
    text = re.sub(r"%[^\n]*", "", path.read_text(encoding="latin-1"))
    case = {"baseMVA": float(re.search(r"mpc\.baseMVA\s*=\s*([^;]+);", text).group(1))}
    for name in ("bus", "gen", "branch"):
        body = re.search(rf"mpc\.{name}\s*=\s*\[(.*?)\];", text, re.S).group(1)
        rows = [r.split() for r in re.split(r"[;\n]", body) if r.strip()]
        case[name] = np.array([[float(x) for x in r] for r in rows])
    return case


def is_transformer(br, kv):
    """PowSyBl's rule (MatpowerImporter.isLine)."""
    if br[SHIFT] != 0:
        return True
    if br[TAP] == 0:
        return False
    return not (br[TAP] == 1 and kv[int(br[F_BUS])] == kv[int(br[T_BUS])])


def check_definitions(case):
    """Stops when a case needs one of the corrections described in the module docstring."""
    kind = {int(b[BUS_I]): int(b[BUS_TYPE]) for b in case["bus"]}
    kv = {int(b[BUS_I]): b[BASE_KV] for b in case["bus"]}
    on = [g for g in case["gen"] if g[GEN_STATUS] > 0]
    assert not any(kind[int(g[GEN_BUS])] == 1 and g[VG] != 0 for g in on), "a generator on a PQ bus has a voltage set point"
    assert not any(is_transformer(r, kv) and r[BR_B] != 0 for r in case["branch"]), "a transformer has line charging"
    first = {}
    for g in on:
        assert first.setdefault(int(g[GEN_BUS]), g[VG]) == g[VG], "generators on one bus have different set points"


def by_row(ids, prefix, keys):
    """Queues of PowSyBl element identifiers by the bus numbers in them, in creation (row) order. PowSyBl makes
    repeated identifiers unique with a suffix, so the first numbers name the element's buses."""
    out = {}
    for i in ids:
        m = re.match(rf"{prefix}-(\d+)(?:-(\d+))?", i)
        out.setdefault(tuple(int(x) for x in m.groups() if x is not None)[:keys], []).append(i)
    return out


def r12(x):
    """A value to 12 significant digits, far below the comparison's tolerances, to keep the goldens small."""
    return None if x is None else float(f"{x:.12g}")


def golden(entry):
    path = CACHE / CASES["archives"][entry["archive"]]["file"]
    case = read_m(path)
    check_definitions(case)
    with tempfile.TemporaryDirectory() as tmp:
        mat = Path(tmp) / "case.mat"
        scipy.io.savemat(mat, {"mpc": {"version": "2", "baseMVA": case["baseMVA"], "bus": case["bus"], "gen": case["gen"], "branch": case["branch"]}})
        n = pp.network.load(str(mat))
    slack = n.get_extensions("slackTerminal")
    params = parameters(sorted(slack["bus_id"]), "previous" if entry["start"] == "case" else "dc")
    results = lf.run_ac(n, parameters=params)

    buses = n.get_bus_breaker_view_buses(all_attributes=True)
    vls = n.get_voltage_levels()
    lines = n.get_lines()
    twts = n.get_2_windings_transformers()
    gens = n.get_generators()
    kv = {int(b[BUS_I]): b[BASE_KV] for b in case["bus"]}

    def vm(bus):
        r = buses.loc[f"BUS-{int(bus)}"]
        return num(r["v_mag"] / vls.loc[r["voltage_level_id"], "nominal_v"])

    queues = {"LINE": by_row(lines.index, "LINE", 2), "TWT": by_row(twts.index, "TWT", 2)}
    flows = {k: [] for k in ("p1", "q1", "p2", "q2")}
    for br in case["branch"]:
        kind, table = ("TWT", twts) if is_transformer(br, kv) else ("LINE", lines)
        i = queues[kind][(int(br[F_BUS]), int(br[T_BUS]))].pop(0)
        for k in flows:
            flows[k].append(num(table.loc[i, k]))
    gen_queue = by_row(gens.index, "GEN", 1)
    gen_rows = [gen_queue[(int(g[GEN_BUS]),)].pop(0) for g in case["gen"]]

    out = {
        "source": f"pypowsybl {version('pypowsybl')} OpenLoadFlow; parameters {params}",
        "case": entry["name"],
        "data": f"MATPOWER {entry['archive']}.m, read from .cache/reference (not redistributed)",
        "slack": sorted(int(b[BUS_I]) for b in case["bus"] if b[BUS_TYPE] == 3),
        "status": [r.status.name for r in results],
        "buses": {
            "number": [int(b[BUS_I]) for b in case["bus"]],
            "vm": [r12(vm(b[BUS_I])) for b in case["bus"]],
            "va": [r12(num(buses.loc[f"BUS-{int(b[BUS_I])}", "v_angle"])) for b in case["bus"]],
        },
        "generators": {"p": [r12(num(gens.loc[i, "p"])) for i in gen_rows], "q": [r12(num(gens.loc[i, "q"])) for i in gen_rows]},
    }
    if entry.get("flows", True):
        out["branches"] = {k: [r12(x) for x in v] for k, v in flows.items()}
    golden_path = GOLDEN / f"matpower-{entry['name']}.json"
    golden_path.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(f"{golden_path.name}: {len(case['bus'])} buses, status {out['status']}, {golden_path.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    wanted = set(sys.argv[1:])
    for entry in CASES["cases"]:
        if not wanted or entry["name"] in wanted:
            golden(entry)
