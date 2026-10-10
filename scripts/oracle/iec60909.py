"""Short-circuit references from IEC TR 60909-4, as pandapower's test suite encodes them.

Reads tests/oracle/sc-cases.json. pandapower's `test_iec60909_4.py` (BSD-3, downloaded at a pinned commit into
.cache/reference by scripts/fetch-reference.mjs) builds the report's example network and its reductions and lists
the currents the report gives. For each case this script builds the network with the test's own function, applies
the changes the test makes, runs pandapower's calc_sc, and writes tests/oracle/golden/sc-<name>.json with:

- `network`: the network's data in pandapower's terms (buses, feeders, generators with their power station
  transformers, two- and three-winding transformers, lines, motors), which the engine test turns into a model;
- `pandapower`: pandapower's results at every bus;
- `expected`: the values the test asserts, with the result column, the number of buses and the tolerance, read from
  the test's source with Python's parser, so no value is typed by hand;
- `listed`: lists the test names but does not assert (the breaking currents Ib, peak currents by method B).

    python scripts/oracle/iec60909.py           # every case
    python scripts/oracle/iec60909.py tr60909-4-3ph-max

It writes only the goldens.
"""

import ast
import importlib.util
import re
import json
import sys
import types
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import pandapower as pp
from pandapower.shortcircuit.calc_sc import calc_sc

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[2]
CASES = ROOT / "tests" / "oracle" / "sc-cases.json"
GOLDEN = ROOT / "tests" / "oracle" / "golden"
REFERENCE = ROOT / ".cache" / "reference"


def load_test_module(path):
    """The test module, with pytest stubbed when it is not installed (only its decorators are used)."""
    if "pytest" not in sys.modules:
        try:
            import pytest  # noqa: F401
        except ImportError:
            stub = types.ModuleType("pytest")
            stub.mark = types.SimpleNamespace(skip=lambda *a, **k: (lambda f: f))
            stub.main = lambda *a, **k: None
            sys.modules["pytest"] = stub
    spec = importlib.util.spec_from_file_location("pp_test_iec60909_4", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod, Path(path).read_text()


def expected_values(source, test_name):
    """The lists a test function assigns, and the comparisons it asserts: (column, buses, list name, tolerance)."""
    tree = ast.parse(source)
    fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == test_name)
    lists = {}
    for node in ast.walk(fn):
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.List) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Name):
                try:
                    lists[target.id] = [float(ast.literal_eval(e)) for e in node.value.elts]
                except ValueError:
                    pass
    asserted = []
    for node in ast.walk(fn):
        if not (isinstance(node, ast.Call) and getattr(node.func, "attr", "") == "allclose"):
            continue
        actual, wanted = node.args[0], node.args[1]
        text = ast.unparse(actual)
        column = re.search(r"res_bus_sc\.(\w+_(?:ka|mw))", text).group(1)
        count = None
        for sub in ast.walk(actual):
            if isinstance(sub, ast.Slice) and sub.upper is not None:
                count = int(ast.literal_eval(sub.upper))
        name = next(n.id for n in ast.walk(wanted) if isinstance(n, ast.Name) and n.id in lists)
        atol = next(float(ast.literal_eval(k.value)) for k in node.keywords if k.arg == "atol")
        asserted.append({"column": column, "buses": count, "list": name, "atol": atol, "values": lists[name][:count]})
    listed = {k: v for k, v in lists.items() if k not in {a["list"] for a in asserted}}
    return asserted, listed


def records(df, columns):
    out = []
    for idx, row in df.iterrows():
        rec = {"index": int(idx)}
        for c in columns:
            if c in df.columns:
                v = row[c]
                if v is None or v is pd.NA or (isinstance(v, float) and np.isnan(v)):
                    v = None
                elif isinstance(v, (np.bool_, bool)):
                    v = bool(v)
                elif isinstance(v, (np.integer,)):
                    v = int(v)
                elif isinstance(v, (float, np.floating)):
                    v = None if np.isnan(v) else float(v)
                elif v is None or (isinstance(v, float) and np.isnan(v)):
                    v = None
                rec[c] = v
        out.append(rec)
    return out


def network(net):
    """The network's data in pandapower's terms."""
    return {
        "sn_mva": float(net.sn_mva),
        "f_hz": float(net.f_hz),
        "bus": records(net.bus, ["vn_kv", "in_service"]),
        "ext_grid": records(net.ext_grid, ["bus", "s_sc_max_mva", "s_sc_min_mva", "rx_max", "rx_min", "x0x_max", "r0x0_max", "in_service"]),
        "gen": records(net.gen, ["bus", "p_mw", "vn_kv", "sn_mva", "xdss_pu", "rdss_ohm", "cos_phi", "pg_percent", "power_station_trafo", "in_service"]),
        "trafo": records(net.trafo, ["hv_bus", "lv_bus", "sn_mva", "vn_hv_kv", "vn_lv_kv", "vk_percent", "vkr_percent", "pfe_kw", "i0_percent", "shift_degree", "tap_side", "tap_neutral", "tap_pos", "tap_step_percent", "oltc", "pt_percent", "power_station_unit", "vector_group", "in_service"]),
        "trafo3w": records(net.trafo3w, ["hv_bus", "mv_bus", "lv_bus", "vn_hv_kv", "vn_mv_kv", "vn_lv_kv", "sn_hv_mva", "sn_mv_mva", "sn_lv_mva", "vk_hv_percent", "vkr_hv_percent", "vk_mv_percent", "vkr_mv_percent", "vk_lv_percent", "vkr_lv_percent", "pfe_kw", "i0_percent", "tap_side", "tap_neutral", "tap_pos", "tap_step_percent", "vector_group", "in_service"]),
        "line": records(net.line, ["from_bus", "to_bus", "length_km", "r_ohm_per_km", "x_ohm_per_km", "c_nf_per_km", "parallel", "endtemp_degree", "in_service"]),
        "motor": records(net.motor, ["bus", "pn_mech_mw", "cos_phi_n", "efficiency_n_percent", "vn_kv", "rx", "lrc_pu", "in_service"]),
        "xward": records(net.xward, ["bus", "pz_mw", "qz_mvar", "in_service"]),
    }


def run(mod, source, case):
    net = getattr(mod, case["network"])()
    changes = case.get("changes", {})
    if "line_endtemp_degree" in changes:
        net.line["endtemp_degree"] = changes["line_endtemp_degree"]
    if "ext_grid_min_from_max" in changes:
        net.ext_grid["s_sc_min_mva"] = net.ext_grid["s_sc_max_mva"] / changes["ext_grid_min_from_max"]
        net.ext_grid["rx_min"] = net.ext_grid["rx_max"]
    if changes.get("no_motors"):
        net.motor = net.motor.iloc[0:0, :]
    if changes.get("no_gens"):
        net.gen = net.gen.iloc[0:0, :]
    calc_sc(net, fault=case["fault"], case=case["case"], ip=True, ith=True, tk_s=0.1, kappa_method="C")
    asserted, listed = expected_values(source, case["test"])
    res = net.res_bus_sc
    results = {int(b): {c: (None if np.isnan(res.at[b, c]) else float(res.at[b, c])) for c in res.columns} for b in res.index}
    return {
        "about": f"IEC TR 60909-4 case '{case['name']}' of tests/oracle/sc-cases.json, from pandapower {pp.__version__}'s "
        f"{case['test']} (BSD-3); written by scripts/oracle/iec60909.py. Do not edit by hand.",
        "pandapower": pp.__version__,
        "settings": {"fault": case["fault"], "case": case["case"], "kappa": "C", "tk_s": 0.1},
        "network": network(net),
        "results": results,
        "expected": asserted,
        "listed": listed,
    }


def main():
    spec = json.loads(CASES.read_text())
    archive = spec["archives"]["pandapower-iec60909-4"]["file"]
    mod, source = load_test_module(REFERENCE / archive)
    wanted = set(sys.argv[1:])
    for case in spec["cases"]:
        if wanted and case["name"] not in wanted:
            continue
        golden = run(mod, source, case)
        out = GOLDEN / f"sc-{case['name']}.json"
        out.write_text(json.dumps(golden, indent=None, separators=(",", ":")) + "\n")
        checks = ", ".join(f"{a['column']}[:{a['buses']}] ±{a['atol']}" for a in golden["expected"])
        print(f"{case['name']}: {len(golden['network']['bus'])} buses; asserts {checks}; lists {sorted(golden['listed'])}")


if __name__ == "__main__":
    main()
