"""Writes the CGMES goldens: PowSyBl's import and load flow of each configuration in tests/oracle/cgmes-cases.json.

PowSyBl (pypowsybl, with OpenLoadFlow) is the reference for CGMES. For each configuration this records, by element
identifier, what PowSyBl imported (impedances, ratings, set points, tap steps, switch states) and its load flow
results (voltages at every element's terminals, flows and outputs), with the load flow settings in olf.py.

PowSyBl 1.16.1 does not read the CGMES 3.0 attribute Equipment.inService ("false means that the equipment is treated
by network applications as if it is not in the model"); it keeps such equipment connected. To solve the network the
files describe, this script removes those elements before the load flow, as PowerStudio's import leaves them out of service.

The slack is chosen by PowerStudio's rule: per synchronous component, the machine with the lowest positive
referencePriority in the files, otherwise the one with the largest rated power.

The archives are read in place from .cache/reference (run node scripts/fetch-reference.mjs first):

    python scripts/oracle/cgmes.py            # every case
    python scripts/oracle/cgmes.py minigrid-3 # one case
"""

import io
import json
import re
import sys
import warnings
import zipfile
from importlib.metadata import version
from pathlib import Path

import pypowsybl as pp
import pypowsybl.loadflow as lf

from olf import num, parameters

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[2]
CASES = json.loads((ROOT / "tests" / "oracle" / "cgmes-cases.json").read_text())
GOLDEN = ROOT / "tests" / "oracle" / "golden"
CACHE = ROOT / ".cache" / "reference"

def xml_files(case):
    """The case's XML files, read from the archive (nested archives expanded)."""
    archive = CASES["archives"][case["archive"]]
    out = []
    with zipfile.ZipFile(CACHE / archive["file"]) as z:
        for info in z.infolist():
            if info.is_dir() or not any(info.filename.startswith(p) for p in case["entries"]):
                continue
            data = z.read(info)
            if data[:4] == b"PK\x03\x04":
                with zipfile.ZipFile(io.BytesIO(data)) as inner:
                    out += [(n, inner.read(n)) for n in inner.namelist() if n.lower().endswith(".xml")]
            elif info.filename.lower().endswith(".xml"):
                out.append((info.filename.rsplit("/", 1)[-1], data))
    return out


def priorities(files):
    """referencePriority of every machine, from the SSH files."""
    found = {}
    for _, data in files:
        text = data.decode("utf-8", "replace")
        for m in re.finditer(r'<cim:(SynchronousMachine|ExternalNetworkInjection) rdf:(?:about|ID)="#?_?([^"]+)">(.*?)</cim:\1>', text, re.S):
            p = re.search(r"referencePriority>(\d+)<", m.group(3))
            if p:
                found[m.group(2)] = int(p.group(1))
    return found


def out_of_service(files):
    """Identifiers whose SSH description sets Equipment.inService to false."""
    found = set()
    for _, data in files:
        text = data.decode("utf-8", "replace")
        for m in re.finditer(r'<cim:(\w+) rdf:about="#?_?([^"]+)">(.*?)</cim:\1>', text, re.S):
            if re.search(r"Equipment\.inService>\s*false\s*<", m.group(3)):
                found.add(m.group(2))
    return found


def remove(n, i):
    """Removes an element, the CGMES 3.0 meaning of Equipment.inService = false; identifiers PowSyBl does not hold as
    network elements (generating units) are skipped."""
    try:
        n.remove_elements([i])
        return True
    except pp.PyPowsyblError:
        return False


def network(case, files):
    """PowSyBl's network of a case's files, prepared as the goldens solve it: equipment whose SSH inService is false
    removed, and load flow parameters with PowerStudio's slack. Returns the network, the parameters, the removed
    identifiers and the slack machines."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files:
            z.writestr(name, data)
    n = pp.network.load_from_binary_buffer(io.BytesIO(buf.getvalue()))
    removed = sorted(i for i in out_of_service(files) if remove(n, i))
    buses = n.get_buses()
    gens = n.get_generators(all_attributes=True)

    # The slack: per synchronous component, best reference priority, then largest rating.
    prio = priorities(files)
    slack = {}
    for gid, g in gens.iterrows():
        if not g["connected"] or not g["bus_id"]:
            continue
        comp = buses.loc[g["bus_id"], "synchronous_component"]
        rank = (prio.get(gid, 0) or 10**9, -(num(g["rated_s"]) or 0.0))
        if comp not in slack or rank < slack[comp][0]:
            slack[comp] = (rank, gid, g["bus_id"])
    params = parameters([s[2] for s in slack.values()], "previous" if case["start"] == "sv" else "dc")
    return n, params, removed, sorted(s[1] for s in slack.values())


def golden(case):
    files = xml_files(case)
    n, params, removed, slack = network(case, files)
    vls = n.get_voltage_levels()
    gens = n.get_generators(all_attributes=True)
    tables = {
        "lines": n.get_lines(all_attributes=True),
        "transformers2": n.get_2_windings_transformers(all_attributes=True),
        "transformers3": n.get_3_windings_transformers(all_attributes=True),
        "dangling": n.get_dangling_lines(all_attributes=True),
        "loads": n.get_loads(all_attributes=True),
        "shunts": n.get_shunt_compensators(all_attributes=True),
        "svcs": n.get_static_var_compensators(all_attributes=True),
        "switches": n.get_switches(all_attributes=True),
        "ratio_taps": n.get_ratio_tap_changers(all_attributes=True),
        "phase_taps": n.get_phase_tap_changers(all_attributes=True),
    }
    imported = {
        "lines": {i: {k: num(r[k]) for k in ("r", "x", "g1", "b1", "g2", "b2")} for i, r in tables["lines"].iterrows()},
        "transformers2": {
            i: {k: num(r[k]) for k in ("r", "x", "g", "b", "rated_u1", "rated_u2", "rated_s", "rho", "alpha", "r_at_current_tap", "x_at_current_tap", "g_at_current_tap", "b_at_current_tap")}
            for i, r in tables["transformers2"].iterrows()
        },
        "dangling": {i: {k: num(r[k]) for k in ("r", "x", "g", "b", "p0", "q0")} | {"paired": bool(r["paired"])} for i, r in tables["dangling"].iterrows()},
        "generators": {i: {"target_p": num(r["target_p"]), "target_q": num(r["target_q"]), "target_v": num(r["target_v"]), "regulating": bool(r["voltage_regulator_on"])} for i, r in gens.iterrows()},
        "loads": {i: {"p0": num(r["p0"]), "q0": num(r["q0"])} for i, r in tables["loads"].iterrows()},
        "shunts": {i: {"sections": int(r["section_count"]), "g": num(r["g"]), "b": num(r["b"])} for i, r in tables["shunts"].iterrows()},
        "switches": {i: bool(r["open"]) for i, r in tables["switches"].iterrows()},
        "ratio_taps": {i: {"tap": int(r["tap"]), "side": str(r["side"])} for i, r in tables["ratio_taps"].iterrows()},
        "phase_taps": {i: {"tap": int(r["tap"]), "side": str(r["side"])} for i, r in tables["phase_taps"].iterrows()},
        "svcs": {i: {k: num(r[k]) for k in ("b_min", "b_max", "target_v", "target_q")} | {"mode": str(r["regulation_mode"]), "regulating": bool(r["regulating"])} for i, r in tables["svcs"].iterrows()},
    }
    out = {
        "source": f"pypowsybl {version('pypowsybl')} OpenLoadFlow; parameters {params}",
        "case": case["name"],
        "data": "ENTSO-E CGMES test configuration, read from the archive (not redistributed)",
        "slack": slack,
        "removed": removed,
        "imported": imported,
    }
    if case.get("loadflow", True):
        results = lf.run_ac(n, parameters=params)
        out["status"] = [r.status.name for r in results]
        buses = n.get_buses()

        def v(bus):
            if not isinstance(bus, str) or not bus:
                return None
            b = buses.loc[bus]
            return [num(b["v_mag"]) / vls.loc[b["voltage_level_id"], "nominal_v"], num(b["v_angle"])]

        def flows(table, sides):
            t = getattr(n, table)(all_attributes=True)
            return {
                i: {f"v{s}": v(r[f"bus{s}_id"]) for s in sides} | {f"{k}{s}": num(r[f"{k}{s}"]) for s in sides for k in ("p", "q")}
                for i, r in t.iterrows()
            }

        out["loadflow"] = {
            "lines": flows("get_lines", (1, 2)),
            "transformers2": flows("get_2_windings_transformers", (1, 2)),
            "transformers3": flows("get_3_windings_transformers", (1, 2, 3)),
            "dangling": {i: {"v": v(r["bus_id"]), "p": num(r["p"]), "q": num(r["q"])} for i, r in n.get_dangling_lines(all_attributes=True).iterrows()},
            "generators": {i: {"v": v(r["bus_id"]), "p": num(r["p"]), "q": num(r["q"])} for i, r in n.get_generators(all_attributes=True).iterrows()},
            "loads": {i: {"v": v(r["bus_id"]), "p": num(r["p"]), "q": num(r["q"])} for i, r in n.get_loads(all_attributes=True).iterrows()},
            "shunts": {i: {"v": v(r["bus_id"]), "q": num(r["q"])} for i, r in n.get_shunt_compensators(all_attributes=True).iterrows()},
            "svcs": {i: {"v": v(r["bus_id"]), "q": num(r["q"])} for i, r in n.get_static_var_compensators(all_attributes=True).iterrows()},
        }
    path = GOLDEN / f"cgmes-{case['name']}.json"
    path.write_text(json.dumps(out, indent=1, sort_keys=True) + "\n")
    print(f"{path.name}: {len(files)} files, slack {out['slack']}, status {out.get('status', 'import only')}")


if __name__ == "__main__":
    wanted = set(sys.argv[1:])
    for case in CASES["cases"]:
        if not wanted or case["name"] in wanted:
            golden(case)
