"""Writes the contingency goldens: PowSyBl's security analysis (OpenLoadFlow, AC) of every single-element outage of
the PSS/E reference cases and of the 2,000-bus ACTIVSg grid.

Outages are every line, two- and three-winding transformer and generator in service, except generators at a slack
bus (PowSyBl keeps the slack where olf.py puts it). An outage that cuts the slack bus off from most of the network is
marked "slack_cut": PowSyBl then picks another slack bus by its own rule and PowerStudio promotes a machine by its
own, so the comparison leaves those out. Each is solved by OpenLoadFlow from the base case with the
plain settings of olf.py and contingency propagation off (an outage takes out its element only). The goldens hold
physics, not violation rules: per outage its status, the ten branches whose active power changes most (P and Q at
both ends, MW and Mvar into the branch) and the five buses whose voltage magnitude changes most (p.u.). The base
case's flows and voltages are recorded for the same elements.

The files are read in place from .cache/reference (run node scripts/fetch-reference.mjs first):

    python scripts/oracle/security.py              # every case
    python scripts/oracle/security.py ieee14-33    # one case
"""

import json
import re
import sys
import tempfile
import warnings
from importlib.metadata import version
from pathlib import Path

import networkx as nx
import pypowsybl as pp
import pypowsybl.security as sec
import scipy.io

import matpower
import psse
from olf import num, parameters

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[2]
GOLDEN = ROOT / "tests" / "oracle" / "golden"
TOP_BRANCHES, TOP_BUSES = 10, 5


def r9(x):
    return None if x is None else float(f"{x:.9g}")


def slack_cut(n, slack_bus):
    """Branch outages after which the slack bus (bus view) is not in the larger part of the network. Only a bridge of
    the network's graph splits it; a three-winding transformer is a star of three edges, all taken out together."""
    lines, t2, t3 = n.get_lines(), n.get_2_windings_transformers(), n.get_3_windings_transformers()
    g = nx.MultiGraph()
    for t in (lines, t2):
        for i, r in t.iterrows():
            if r["bus1_id"] and r["bus2_id"]:
                g.add_edge(r["bus1_id"], r["bus2_id"], key=i)
    for i, r in t3.iterrows():
        for b in ("bus1_id", "bus2_id", "bus3_id"):
            if r[b]:
                g.add_edge(f"star:{i}", r[b], key=i)
    if slack_bus not in g:
        return set()
    simple = nx.Graph(g)
    out = set()
    for a, b in nx.bridges(simple):
        keys = list(g.get_edge_data(a, b).keys())
        if len(keys) != 1:
            continue
        h = g.copy()
        h.remove_edge(a, b, key=keys[0])
        part = nx.node_connected_component(h, slack_bus)
        if len(part) * 2 < len(nx.node_connected_component(g, slack_bus)):
            out.add(keys[0])
    for i in t3.index:
        h = g.copy()
        h.remove_node(f"star:{i}") if f"star:{i}" in h else None
        part = nx.node_connected_component(h, slack_bus)
        if len(part) * 2 < len(nx.node_connected_component(g, slack_bus)):
            out.add(i)
    return out


def analyse(n, slack, start, ident):
    """Runs every single-element outage; returns the golden's contingencies and base."""
    lines, t2, t3 = n.get_lines(), n.get_2_windings_transformers(), n.get_3_windings_transformers()
    gens = n.get_generators(all_attributes=True)
    # The slack bus in the bus view, where the generators' bus_id lives.
    terminals = n.get_extensions("slackTerminal")
    slack_view = set(terminals["bus_id"])
    outages = [*lines.index[lines["connected1"] & lines["connected2"]], *t2.index[t2["connected1"] & t2["connected2"]],
               *t3.index, *[g for g, r in gens.iterrows() if r["connected"] and r["bus_id"] not in slack_view]]
    cut = set().union(*(slack_cut(n, b) for b in slack_view))
    branches = [*lines.index, *t2.index]
    sa = sec.create_analysis()
    sa.add_single_element_contingencies(outages)
    sa.add_monitored_elements(branch_ids=branches, voltage_level_ids=list(n.get_voltage_levels().index))
    params = parameters(slack, start)
    res = sa.run_ac(n, parameters=sec.Parameters(load_flow_parameters=params, provider_parameters={"contingencyPropagation": "false"}))
    br = res.branch_results.reset_index()
    bus = res.bus_results.reset_index()
    vls = n.get_voltage_levels()
    bus["v"] = bus["v_mag"] / bus["voltage_level_id"].map(vls["nominal_v"])
    bus = bus[bus["bus_id"].astype(str).str.fullmatch(r"(B|BUS-)\d+")]
    base_br = br[br["contingency_id"] == ""].set_index("branch_id")
    base_bus = bus[bus["contingency_id"] == ""].set_index("bus_id")
    br_by = {k: g.set_index("branch_id") for k, g in br.groupby("contingency_id")}
    bus_by = {k: g.set_index("bus_id") for k, g in bus.groupby("contingency_id")}
    out = {}
    for cid, post in res.post_contingency_results.items():
        status = post.status.name
        entry = {"status": status}
        if cid in cut:
            entry["slack_cut"] = True
        if status == "CONVERGED" and cid in br_by:
            b = br_by[cid]
            dp = (b["p1"] - base_br["p1"].reindex(b.index)).abs().dropna().sort_values(ascending=False)
            entry["branches"] = {ident(i): [r9(num(b.loc[i, k])) for k in ("p1", "q1", "p2", "q2")] for i in dp.index[:TOP_BRANCHES]}
            u = bus_by.get(cid)
            if u is not None:
                dv = (u["v"] - base_bus["v"].reindex(u.index)).abs().dropna().sort_values(ascending=False)
                entry["buses"] = {i: r9(num(u.loc[i, "v"])) for i in dv.index[:TOP_BUSES]}
        out[ident(cid)] = entry
    return params, out


def psse_golden(case):
    path = psse.CACHE / psse.CASES["archives"][case["archive"]]["file"]
    n = pp.network.load(str(path))
    psse.corrections(n, path, case)
    slack = sorted(n.get_extensions("slackTerminal")["bus_id"])
    params, out = analyse(n, slack, "previous" if case["start"] == "raw" else "dc", psse.ident)
    return {
        "source": f"pypowsybl {version('pypowsybl')} OpenLoadFlow security analysis; parameters {params}; contingencyPropagation false",
        "case": case["name"],
        "data": f"powsybl-core test resource {psse.CASES['archives'][case['archive']]['url'].rsplit('/', 1)[-1]}, read from .cache/reference (not redistributed)",
        "contingencies": out,
    }


def matpower_golden(entry):
    path = matpower.CACHE / matpower.CASES["archives"][entry["archive"]]["file"]
    case = matpower.read_m(path)
    with tempfile.TemporaryDirectory() as tmp:
        mat = Path(tmp) / "case.mat"
        scipy.io.savemat(mat, {"mpc": {"version": "2", "baseMVA": case["baseMVA"], "bus": case["bus"], "gen": case["gen"], "branch": case["branch"]}})
        n = pp.network.load(str(mat))
    slack = sorted(n.get_extensions("slackTerminal")["bus_id"])
    # PowSyBl's identifiers to PowerStudio's: branches by row (L<row>, T<row>, 1-based), generators G<row>.
    kv = {int(b[matpower.BUS_I]): b[matpower.BASE_KV] for b in case["bus"]}
    queues = {"LINE": matpower.by_row(n.get_lines().index, "LINE", 2), "TWT": matpower.by_row(n.get_2_windings_transformers().index, "TWT", 2)}
    ours = {}
    for row, br in enumerate(case["branch"], start=1):
        kind = "TWT" if matpower.is_transformer(br, kv) else "LINE"
        ours[queues[kind][(int(br[matpower.F_BUS]), int(br[matpower.T_BUS]))].pop(0)] = f"{'T' if kind == 'TWT' else 'L'}{row}"
    gq = matpower.by_row(n.get_generators().index, "GEN", 1)
    for row, g in enumerate(case["gen"], start=1):
        ours[gq[(int(g[matpower.GEN_BUS]),)].pop(0)] = f"G{row}"
    params, out = analyse(n, slack, "previous" if entry["start"] == "case" else "dc", lambda i: ours.get(i, i))
    return {
        "source": f"pypowsybl {version('pypowsybl')} OpenLoadFlow security analysis; parameters {params}; contingencyPropagation false",
        "case": entry["name"],
        "data": f"MATPOWER {entry['archive']}.m, read from .cache/reference (not redistributed); branches and generators by PowerStudio's identifiers (L<row>, T<row>, G<row>), buses BUS-<number>",
        "contingencies": out,
    }


def write(name, out):
    path = GOLDEN / f"security-{name}.json"
    path.write_text(json.dumps(out, separators=(",", ":"), sort_keys=True) + "\n")
    statuses = {}
    for c in out["contingencies"].values():
        statuses[c["status"]] = statuses.get(c["status"], 0) + 1
    print(f"{path.name}: {len(out['contingencies'])} outages {statuses}, {path.stat().st_size / 1e3:.0f} kB")


if __name__ == "__main__":
    wanted = set(sys.argv[1:])
    for case in psse.CASES["cases"]:
        if case.get("loadflow", True) and (not wanted or case["name"] in wanted):
            write(case["name"], psse_golden(case))
    for entry in matpower.CASES["cases"]:
        if entry["name"] == "activsg2000" and (not wanted or entry["name"] in wanted):
            write(entry["name"], matpower_golden(entry))
