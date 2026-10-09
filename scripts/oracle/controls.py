"""Writes the controls goldens: PowSyBl's load flow of the PSS/E and MATPOWER reference cases with each control on.

For every case in tests/oracle/psse-cases.json that solves, and the MATPOWER cases named in MATPOWER below, this
runs OpenLoadFlow once per variant in VARIANTS, each enabling the controls olf.CONTROLS names, on the network the
plain goldens solve (psse.py and matpower.py apply their corrections first). A variant records the status, the bus
voltages, every generator's output, and the positions of tap changers and shunt sections the controls move.

The files are read in place from .cache/reference (run node scripts/fetch-reference.mjs first):

    python scripts/oracle/controls.py               # every case
    python scripts/oracle/controls.py ieee14-33     # one case
"""

import json
import re
import sys
import tempfile
import warnings
from importlib.metadata import version
from pathlib import Path

import pypowsybl as pp
import pypowsybl.loadflow as lf
import scipy.io

import matpower
import psse
from olf import num, parameters

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[2]
GOLDEN = ROOT / "tests" / "oracle" / "golden"

# Each variant enables these controls (olf.CONTROLS).
VARIANTS = {
    "slack": ("slack",),
    "slack-p": ("slack-p",),
    "slack-margin": ("slack-margin",),
    "slack-load": ("slack-load",),
    "qlim": ("qlim",),
    "remote": ("remote",),
    "remote-qlim": ("remote", "qlim"),
    "zip": ("zip",),
    "taps": ("taps",),
    "shunts": ("shunts",),
    "phase": ("phase",),
    "all": ("slack", "qlim", "remote", "zip", "taps", "shunts", "phase"),
    # The same controls with every regulating two-winding tap changer's and shunt's voltage target raised by
    # STRESS, so the discrete controls have to move (the cases mostly start within their dead bands).
    "taps-stress": ("taps",),
    "shunts-stress": ("shunts",),
    "stress-all": ("slack", "qlim", "remote", "taps", "shunts"),
}

# Factor on the voltage targets of the stress variants.
STRESS = 1.02

# MATPOWER cases with controls goldens, and the variants that apply (MATPOWER data has no remote control or loads
# with voltage dependence).
MATPOWER = {"activsg2000": ("slack", "slack-p", "slack-margin", "slack-load", "qlim"), "activsg10k": ("slack", "qlim")}


def r12(x):
    return None if x is None else float(f"{x:.12g}")


def solve(n, slack, start, controls):
    params = parameters(slack, start, controls)
    results = lf.run_ac(n, parameters=params)
    return params, [r.status.name for r in results]


def zip_corrected(path, tmp):
    """A copy of a RAW file whose loads' YQ is negated. PowSyBl builds a load's ZIP model with Q = QL + IQ·V + YQ·V²;
    the PSS/E data format defines YQ as negative for an inductive load, so Q = QL + IQ·V − YQ·V². Negating YQ in the
    file gives PowSyBl's model the PSS/E definition (q0 and the coefficients both)."""
    text = path.read_bytes().decode("latin-1")
    lines = text.split("\n")
    rev = int(float(psse.fields(lines[0])[2]))
    i = 3
    if rev >= 35:
        while psse.fields(lines[i]) != ["0"]:
            i += 1
        i += 1
    while psse.fields(lines[i]) != ["0"]:  # buses
        i += 1
    i += 1
    while psse.fields(lines[i]) != ["0"]:  # loads
        f = psse.fields(lines[i])
        if float(f[10] or 0) == 0:
            i += 1
            continue
        f[10] = repr(-float(f[10]))

        def quoted(x):
            try:
                float(x)
                return x
            except ValueError:
                return "'" + x + "'"

        lines[i] = ",".join(quoted(x) for x in f)
        i += 1
    out = Path(tmp) / path.name
    out.write_bytes("\n".join(lines).encode("latin-1"))
    return out


def psse_variants(case):
    path = psse.CACHE / psse.CASES["archives"][case["archive"]]["file"]
    out = {}
    for name, controls in VARIANTS.items():
        with tempfile.TemporaryDirectory() as tmp:
            n = pp.network.load(str(zip_corrected(path, tmp) if "zip" in controls else path))
        psse.corrections(n, path, case)
        if "stress" in name:
            rtc = n.get_ratio_tap_changers(all_attributes=True)
            two = rtc[(rtc["side"] == "") & rtc["regulating"]]
            if len(two):
                n.update_ratio_tap_changers(id=list(two.index), target_v=list(two["target_v"] * STRESS))
            sh = n.get_shunt_compensators(all_attributes=True)
            reg = sh[sh["voltage_regulation_on"]]
            if len(reg):
                n.update_shunt_compensators(id=list(reg.index), target_v=list(reg["target_v"] * STRESS))
        slack = sorted(n.get_extensions("slackTerminal")["bus_id"])
        params, status = solve(n, slack, "previous" if case["start"] == "raw" else "dc", controls)
        buses = n.get_buses()
        vls = n.get_voltage_levels()

        def v(bus):
            if not isinstance(bus, str) or not bus or num(buses.loc[bus, "v_mag"]) is None:
                return None
            b = buses.loc[bus]
            return [r12(num(b["v_mag"]) / vls.loc[b["voltage_level_id"], "nominal_v"]), r12(num(b["v_angle"]))]

        bb = n.get_bus_breaker_view_buses(all_attributes=True)
        gens = n.get_generators(all_attributes=True)
        rtc = n.get_ratio_tap_changers(all_attributes=True)
        ptc = n.get_phase_tap_changers(all_attributes=True)
        sh = n.get_shunt_compensators(all_attributes=True)

        def positions(t):
            # No solved position when the load flow failed.
            return {
                f"{psse.ident(i)}#{r['side'] or 'ONE'}": None if num(r["solved_tap_position"]) is None else int(r["solved_tap_position"] - r["low_tap"])
                for i, r in t.iterrows() if r["regulating"]
            }

        out[name] = {
            "controls": list(controls),
            "stress": STRESS if "stress" in name else None,
            "parameters": str(params),
            "status": status,
            "buses": {i: v(r["bus_id"]) for i, r in bb.iterrows() if re.fullmatch(r"B\d+", i) and v(r["bus_id"])},
            "generators": {psse.ident(i): [r12(num(r["p"])), r12(num(r["q"]))] for i, r in gens.iterrows()},
            "ratio_taps": positions(rtc),
            "phase_taps": positions(ptc),
            "shunts": {psse.ident(i): None if num(r["solved_section_count"]) is None else int(r["solved_section_count"]) for i, r in sh.iterrows() if r["voltage_regulation_on"]},
        }
    return {
        "source": f"pypowsybl {version('pypowsybl')} OpenLoadFlow; the parameters of each variant are recorded with it",
        "case": case["name"],
        "data": f"powsybl-core test resource {psse.CASES['archives'][case['archive']]['url'].rsplit('/', 1)[-1]}, read from .cache/reference (not redistributed)",
        "variants": out,
    }


def matpower_variants(entry, variants):
    path = matpower.CACHE / matpower.CASES["archives"][entry["archive"]]["file"]
    case = matpower.read_m(path)
    out = {}
    for name in variants:
        controls = VARIANTS[name]
        with tempfile.TemporaryDirectory() as tmp:
            mat = Path(tmp) / "case.mat"
            scipy.io.savemat(mat, {"mpc": {"version": "2", "baseMVA": case["baseMVA"], "bus": case["bus"], "gen": case["gen"], "branch": case["branch"]}})
            n = pp.network.load(str(mat))
        slack = sorted(n.get_extensions("slackTerminal")["bus_id"])
        params, status = solve(n, slack, "previous" if entry["start"] == "case" else "dc", controls)
        buses = n.get_bus_breaker_view_buses(all_attributes=True)
        vls = n.get_voltage_levels()
        gens = n.get_generators()
        queue = matpower.by_row(gens.index, "GEN", 1)
        rows = [queue[(int(g[matpower.GEN_BUS]),)].pop(0) for g in case["gen"]]

        def vm(b):
            r = buses.loc[f"BUS-{int(b)}"]
            return r12(num(r["v_mag"] / vls.loc[r["voltage_level_id"], "nominal_v"]))

        out[name] = {
            "controls": list(controls),
            "stress": STRESS if "stress" in name else None,
            "parameters": str(params),
            "status": status,
            "vm": [vm(b[matpower.BUS_I]) for b in case["bus"]],
            "va": [r12(num(buses.loc[f"BUS-{int(b[matpower.BUS_I])}", "v_angle"])) for b in case["bus"]],
            "p": [r12(num(gens.loc[i, "p"])) for i in rows],
            "q": [r12(num(gens.loc[i, "q"])) for i in rows],
        }
    return {
        "source": f"pypowsybl {version('pypowsybl')} OpenLoadFlow; the parameters of each variant are recorded with it",
        "case": entry["name"],
        "data": f"MATPOWER {entry['archive']}.m, read from .cache/reference (not redistributed)",
        "bus": [int(b[matpower.BUS_I]) for b in case["bus"]],
        "variants": out,
    }


def write(name, out):
    path = GOLDEN / f"controls-{name}.json"
    path.write_text(json.dumps(out, separators=(",", ":"), sort_keys=True) + "\n")
    print(f"{path.name}: " + ", ".join(f"{k} {v['status']}" for k, v in out["variants"].items()))


if __name__ == "__main__":
    wanted = set(sys.argv[1:])
    for case in psse.CASES["cases"]:
        if case.get("loadflow", True) and (not wanted or case["name"] in wanted):
            write(case["name"], psse_variants(case))
    for entry in matpower.CASES["cases"]:
        if entry["name"] in MATPOWER and (not wanted or entry["name"] in wanted):
            write(entry["name"], matpower_variants(entry, MATPOWER[entry["name"]]))
