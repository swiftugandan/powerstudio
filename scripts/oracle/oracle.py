"""Writes the golden results PowerStudio's engine tests compare against.

Two independent references are used:

* PYPOWER (the Python port of MATPOWER) solves the MATPOWER fixtures in tests/fixtures
  directly from their per-unit data, so the MATPOWER import and the load flow are checked against MATPOWER's own
  algorithm and conventions.
* pandapower solves the bundled sample networks, exported by scripts/export-oracle-inputs.mjs, for load flow and
  IEC 60909 short circuits. Its network is built from the exported document field by field.

Run with a Python that has pandapower installed (see docs/TESTING.md):

    python scripts/oracle/oracle.py
"""

import json
import math
import re
import sys
import warnings
from pathlib import Path

import numpy as np
import pandapower as pp
import pandapower.shortcircuit as sc
from pypower.api import ppoption, runpf
from importlib.metadata import version

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"
INPUTS = ROOT / "tests" / "oracle" / "inputs"
GOLDEN = ROOT / "tests" / "oracle" / "golden"


def parse_matpower(text):
    """Reads the numeric matrices of a MATPOWER version 2 case file."""
    clean = re.sub(r"%[^\n]*", "", text)
    ppc = {"version": "2", "baseMVA": float(re.search(r"mpc\.baseMVA\s*=\s*([-+0-9.eE]+)", clean).group(1))}
    for key in ("bus", "gen", "branch"):
        body = re.search(r"mpc\.%s\s*=\s*\[(.*?)\]\s*;" % key, clean, re.S).group(1)
        rows = [r.split() for r in re.split(r";|\n", body) if r.strip()]
        ppc[key] = np.array([[float(v) for v in r] for r in rows])
    return ppc


def matpower_goldens():
    for case in ("case14", "case30", "case118"):
        ppc = parse_matpower((FIXTURES / f"{case}.m").read_text())
        # PYPOWER's reactive limit loop fails under numpy 2, so limits are checked through pandapower instead.
        opt = ppoption(PF_TOL=1e-10, PF_MAX_IT=50, VERBOSE=0, OUT_ALL=0)
        result, ok = runpf(ppc, opt)[:2]
        assert ok, f"PYPOWER did not converge on {case}"
        bus = result["bus"]
        out = {
            "source": f"PYPOWER {version('pypower')} runpf, PF_TOL=1e-10",
            "bus": [int(b) for b in bus[:, 0]],
            "vm": bus[:, 7].tolist(),
            "va": bus[:, 8].tolist(),
            "pg": result["gen"][:, 1].tolist(),
            "qg": result["gen"][:, 2].tolist(),
        }
        name = f"matpower-{case}.json"
        (GOLDEN / name).write_text(json.dumps(out, indent=1) + "\n")
        print("wrote", name)


def build_net(doc):
    """Builds a pandapower network from an exported PowerStudio document, field by field."""
    net = pp.create_empty_network(sn_mva=doc["baseMVA"], f_hz=doc["frequency"])
    els = doc["elements"]
    bus = {}
    for e in els:
        if e["cls"] == "bus":
            bus[e["id"]] = pp.create_bus(net, vn_kv=e["vn"], name=e["id"])
    for e in els:
        on = e.get("inService", True)
        c = e["cls"]
        if c == "line":
            pp.create_line_from_parameters(
                net, bus[e["from"]], bus[e["to"]], length_km=e["length"], parallel=e["parallel"],
                r_ohm_per_km=e["r1"], x_ohm_per_km=e["x1"], c_nf_per_km=e["b1"] / (2 * math.pi * doc["frequency"]) * 1e3,
                max_i_ka=e["ratedA"] or 1.0, r0_ohm_per_km=e["r0"], x0_ohm_per_km=e["x0"],
                c0_nf_per_km=e["b0"] / (2 * math.pi * doc["frequency"]) * 1e3, endtemp_degree=20, in_service=on, name=e["id"])
        elif c == "trafo":
            clock = int(re.search(r"(\d+)$", e["vectorGroup"]).group(1))
            pp.create_transformer_from_parameters(
                net, bus[e["hv"]], bus[e["lv"]], sn_mva=e["sn"], vn_hv_kv=e["vnHV"], vn_lv_kv=e["vnLV"],
                vk_percent=e["uk"], vkr_percent=e["ur"], pfe_kw=e["pfe"], i0_percent=e["i0"], shift_degree=clock * 30,
                tap_side="hv", tap_neutral=e["tapNeutral"], tap_pos=e["tapPos"], tap_step_percent=e["tapStep"],
                tap_min=e["tapMin"], tap_max=e["tapMax"], tap_changer_type="Ratio",
                vector_group=re.sub(r"\d+$", "", e["vectorGroup"]), vk0_percent=e["uk0"], vkr0_percent=e["ur0"],
                mag0_percent=1e12, mag0_rx=0, si0_hv_partial=0.5, in_service=on, name=e["id"])
        elif c == "gen":
            pp.create_gen(
                net, bus[e["bus"]], p_mw=e["p"], vm_pu=e["vset"], sn_mva=e["sn"], vn_kv=e["vn"],
                min_q_mvar=e["qmin"], max_q_mvar=e["qmax"], slack=e["mode"] == "Reference",
                xdss_pu=e["xdss"], rdss_ohm=e["rs"] * e["vn"] ** 2 / e["sn"], cos_phi=e["cosphi"],
                in_service=on, name=e["id"])
        elif c == "extgrid":
            pp.create_ext_grid(
                net, bus[e["bus"]], vm_pu=e["vset"], va_degree=e["angle"], s_sc_max_mva=e["skMax"],
                s_sc_min_mva=e["skMin"], rx_max=e["rxMax"], rx_min=e["rxMin"], x0x_max=e["x0x1"], r0x0_max=e["r0x0"],
                x0x_min=e["x0x1"], r0x0_min=e["r0x0"], in_service=on, name=e["id"])
        elif c == "load":
            pp.create_load(net, bus[e["bus"]], p_mw=e["p"], q_mvar=e["q"], in_service=on, name=e["id"])
        elif c == "shunt":
            # pandapower counts reactive power positive when absorbed; PowerStudio counts a capacitor positive.
            pp.create_shunt(net, bus[e["bus"]], q_mvar=-e["q"], p_mw=e["p"], vn_kv=e["vn"], in_service=on, name=e["id"])
    return net


# The fault resistance and reactance, Ω, of the fault-impedance short circuits: enough to change every current.
ZFAULT = (2.0, 1.0)


def finite(v):
    """JSON has no NaN; results that pandapower leaves undefined (no fault current) become null."""
    return float(v) if math.isfinite(v) else None


def sample_goldens():
    for path in sorted(INPUTS.glob("*.json")):
        doc = json.loads(path.read_text())
        name = path.stem
        net = build_net(doc)
        out = {"source": f"pandapower {pp.__version__}", "loadflow": {}, "shortcircuit": {}}
        for enforce in (False, True):
            # A DC start, as PowerStudio uses by default; pandapower's flat start does not converge on Riverside.
            pp.runpp(net, algorithm="nr", init="dc", tolerance_mva=1e-9, trafo_model="pi",
                     calculate_voltage_angles=True, enforce_q_lims=enforce, max_iteration=50)
            out["loadflow"]["qlim" if enforce else "base"] = {
                "iterations": int(net._ppc["iterations"]),
                "bus": {net.bus.name[i]: [float(net.res_bus.vm_pu[i]), float(net.res_bus.va_degree[i])] for i in net.bus.index},
                "line": {net.line.name[i]: [float(v) for v in net.res_line.loc[i, ["p_from_mw", "q_from_mvar", "p_to_mw", "q_to_mvar", "i_ka"]]] for i in net.line.index},
                "trafo": {net.trafo.name[i]: [float(v) for v in net.res_trafo.loc[i, ["p_hv_mw", "q_hv_mvar", "p_lv_mw", "q_lv_mvar"]]] for i in net.trafo.index},
                "gen": {net.gen.name[i]: [float(net.res_gen.p_mw[i]), float(net.res_gen.q_mvar[i])] for i in net.gen.index},
            }
        for fault in ("3ph", "2ph", "1ph"):
            for case in ("max", "min"):
                sc.calc_sc(net, fault=fault, case=case, ip=True, ith=True, kappa_method="C", lv_tol_percent=10, tk_s=1.0)
                res = net.res_bus_sc
                out["shortcircuit"][f"{fault}-{case}"] = {
                    net.bus.name[i]: {"ikss": finite(res.ikss_ka[i]), "ip": finite(res.ip_ka[i]), "ith": finite(res.ith_ka[i])}
                    for i in res.index
                }
        # A fault impedance in each faulted phase (ZFAULT below), maximum currents.
        for fault in ("3ph", "2ph", "1ph"):
            sc.calc_sc(net, fault=fault, case="max", ip=True, ith=True, kappa_method="C", lv_tol_percent=10, tk_s=1.0,
                       r_fault_ohm=ZFAULT[0], x_fault_ohm=ZFAULT[1])
            res = net.res_bus_sc
            out["shortcircuit"][f"{fault}-max-zf"] = {
                net.bus.name[i]: {"ikss": finite(res.ikss_ka[i]), "ip": finite(res.ip_ka[i]), "ith": finite(res.ith_ka[i])}
                for i in res.index
            }
        out["faultImpedance"] = {"r": ZFAULT[0], "x": ZFAULT[1]}
        (GOLDEN / f"{name}.json").write_text(json.dumps(out, indent=1, sort_keys=True) + "\n")
        print("wrote", f"{name}.json")


def main():
    GOLDEN.mkdir(parents=True, exist_ok=True)
    # PowerStudio models generator neutrals as unearthed. pandapower instead places a placeholder admittance of
    # 1/(1000 + 1000j) p.u. at generator buses in the zero sequence; the oracle removes it so both model the same network.
    import pandapower.pd2ppc_zero as zero
    zero._add_gen_sc_impedance_zero = lambda net, ppc: None
    matpower_goldens()
    sample_goldens()


if __name__ == "__main__":
    sys.exit(main())
