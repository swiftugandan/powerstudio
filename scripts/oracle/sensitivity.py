"""Writes the DC sensitivity goldens: PowSyBl's DC sensitivity analysis (OpenLoadFlow) of every branch's active power
flow to every generator's injection, on PSS/E reference cases. With the slack where olf.py puts it and distributed
slack off, a generator's sensitivity is the power transfer distribution factor (PTDF) of a transfer from its bus to
the slack bus. Transformer ratios are left out of the DC model (dc_use_transformer_ratio false), as PowerStudio's DC
model leaves them out.

    python scripts/oracle/sensitivity.py
"""

import json
import warnings
from importlib.metadata import version
from pathlib import Path

import pypowsybl as pp
import pypowsybl.sensitivity as sens

import psse
from olf import num, parameters

warnings.filterwarnings("ignore")
GOLDEN = Path(__file__).resolve().parents[2] / "tests" / "oracle" / "golden"
CASES = ["ieee14-33", "ieee39", "ieee118-33"]


def golden(case):
    path = psse.CACHE / psse.CASES["archives"][case["archive"]]["file"]
    n = pp.network.load(str(path))
    psse.corrections(n, path, case)
    gens = n.get_generators(all_attributes=True)
    gens = gens[gens["connected"]]
    branches = [*n.get_lines().index, *n.get_2_windings_transformers().index]
    sa = sens.create_dc_analysis()
    sa.add_branch_flow_factor_matrix(branches_ids=branches, variables_ids=list(gens.index))
    slack = sorted(n.get_extensions("slackTerminal")["bus_id"])
    params = parameters(slack, "dc")
    params.dc_use_transformer_ratio = False
    m = sens_matrix = sa.run(n, parameters=sens.Parameters(load_flow_parameters=params)).get_sensitivity_matrix()
    out = {
        "source": f"pypowsybl {version('pypowsybl')} OpenLoadFlow DC sensitivity analysis; parameters {params}",
        "case": case["name"],
        "branches": [psse.ident(b) for b in branches],
        "generators": {psse.ident(g): [float(f"{num(m.loc[g, b]):.10g}") for b in branches] for g in sens_matrix.index},
    }
    p = GOLDEN / f"sensitivity-{case['name']}.json"
    p.write_text(json.dumps(out, separators=(",", ":"), sort_keys=True) + "\n")
    print(f"{p.name}: {len(gens)} generators × {len(branches)} branches")


if __name__ == "__main__":
    for case in psse.CASES["cases"]:
        if case["name"] in CASES:
            golden(case)
