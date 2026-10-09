"""Writes the PSS/E RAW goldens: PowSyBl's import and load flow of each case in tests/oracle/psse-cases.json.

PowSyBl (pypowsybl, with OpenLoadFlow and the settings in olf.py) is the reference for RAW files. For each case this
records, by element identifier, what PowSyBl imported (set points, shunt admittances, line impedances, tap changers)
and its load flow results (voltages at every bus and equipment terminal, flows, outputs).

Four corrections bring PowSyBl's network in line with the PSS/E definitions before the load flow:

* Identifiers lose their blanks. PowSyBl keeps the padding of quoted RAW identifiers ("B1-G1 "); PowerStudio trims it.
* Loads with a constant-admittance part get Q0 = QL + IQ - YQ. The PSS/E data format defines YQ as negative for an
  inductive load (MATPOWER's psse_convert.m subtracts it too); PowSyBl 1.16.1 adds it.
* Generators on type 2 and 3 buses whose reactive range is empty (QB = QT) keep their voltage control. PowSyBl turns it
  off ("we consider < but psse accepts bus type 2 with Qmin == Qmax", GeneratorConverter); with reactive limits
  ignored, as here, PSS/E holds the set point.
* Transformers keep their stated winding ratio. PowSyBl replaces it with a tap step that lies within 1e-5 of it
  (snapped_ratios below); the RAW file's WINDV is the ratio PSS/E solves with.

The slack is the bus of type 3 (PowSyBl's slack terminal).

The files are read in place from .cache/reference (run node scripts/fetch-reference.mjs first):

    python scripts/oracle/psse.py            # every case
    python scripts/oracle/psse.py ieee14-33  # one case
"""

import json
import re
import sys
import warnings
from importlib.metadata import version
from pathlib import Path

import pypowsybl as pp
import pypowsybl.loadflow as lf

from olf import num, parameters

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[2]
CASES = json.loads((ROOT / "tests" / "oracle" / "psse-cases.json").read_text())
GOLDEN = ROOT / "tests" / "oracle" / "golden"
CACHE = ROOT / ".cache" / "reference"


def ident(i):
    return re.sub(r"\s+", "", i)


def fields(line):
    """The fields of a RAW record, as PowerStudio's reader splits them: commas or blanks separate, quotes group, '/'
    outside quotes starts a comment, and an empty field between two commas is kept as ''."""
    out, cur, have, closed_by_blank = [], "", False, False
    chars = iter(line)
    for c in chars:
        if c in "'\"":
            for q in chars:
                if q == c:
                    break
                cur += q
            have, closed_by_blank = True, False
        elif c == "/":
            break
        elif c == ",":
            if have:
                out.append(cur)
            elif not closed_by_blank:
                out.append("")
            cur, have, closed_by_blank = "", False, False
        elif c.isspace():
            if have:
                out.append(cur)
                cur, have, closed_by_blank = "", False, True
        else:
            cur, have, closed_by_blank = cur + c, True, False
    if have:
        out.append(cur)
    return [f.strip() for f in out]


def sections(path):
    """The records of a RAW file up to the transformers, as lists of fields (a transformer's four or five lines are
    joined into one list of lines)."""
    lines = [line for line in path.read_text(encoding="latin-1").splitlines() if not line.lstrip().startswith("@!")]
    rev = int(float(fields(lines[0])[2]))
    names = ["bus", "load", "fixed_shunt", "generator", "branch", "transformer"]
    if rev >= 35:
        names = ["system", *names[:5], "switching_device", "transformer"]
    out, i = {"rev": rev}, 3
    for name in names:
        out[name] = []
        while fields(lines[i]) != ["0"]:
            if name == "transformer":
                n = 4 if int(fields(lines[i])[2] or 0) == 0 else 5
                out[name].append([fields(line) for line in lines[i:i + n]])
                i += n
                continue
            out[name].append(fields(lines[i]))
            i += 1
        i += 1
    return out


def snapped_ratios(raw):
    """Two-winding transformers whose winding 1 ratio PowSyBl moves onto a tap step: {id: (step ratio, stated ratio)}.

    PowSyBl builds the steps of a voltage or reactive power controlling winding from RMI to RMA and puts the stated
    ratio in as a step of its own, unless a step lies within 1e-5 of it (TransformerConverter.TOLERANCE); then it
    uses that step instead.
    """
    v35 = raw["rev"] >= 35
    cod_at, rma_at, ntp_at = (15, 18, 22) if v35 else (6, 8, 12)
    baskv = {int(b[0]): float(b[2]) or 1.0 for b in raw["bus"]}
    out = {}
    for t in raw["transformer"]:
        head, w1 = t[0], t[2]
        if int(head[2] or 0) != 0:
            continue
        cw = int(head[4] or 1)
        windv, ang = float(w1[0] or 1), float(w1[2] or 0)
        nomv = float(w1[1] or 0) or baskv[int(head[0])]
        cod, ntp = abs(int(w1[cod_at] or 0)), int(w1[ntp_at] or 33)
        rma, rmi = float(w1[rma_at] or 1.1), float(w1[rma_at + 1] or 0.9)
        if ntp <= 1 or ang != 0 or cod not in (1, 2):
            continue
        kv = baskv[int(head[0])]

        def ratio(w):
            return {1: w, 2: w / kv, 3: w * nomv / kv}[cw]

        stated = ratio(windv)
        for k in range(ntp):
            step = ratio(rmi + (rma - rmi) / (ntp - 1) * k)
            d = step - stated
            if abs(d) <= 1e-5:
                if d != 0:
                    out[ident(f"T-{head[0]}-{head[1]}-{head[3]}")] = (step, stated)
                break
            if d > 0:
                break
    return out


def corrections(n, path):
    """Brings PowSyBl's network in line with the PSS/E definitions (see the module docstring); returns what changed."""
    raw = sections(path)
    ide = {int(b[0]): int(b[3]) for b in raw["bus"]}
    loads = {ident(i): i for i in n.get_loads().index}
    q0 = {}
    for f in raw["load"]:
        yq = float(f[10] or 0)
        if yq != 0:
            lid = ident(f"B{f[0]}-L{f[1]}")
            q0[lid] = float(f[6] or 0) + float(f[8] or 0) - yq
            n.update_loads(id=loads[lid], q0=q0[lid])
    taps = n.get_ratio_tap_changers()
    steps = n.get_ratio_tap_changer_steps()
    ratio = {}
    for tid, (step, stated) in snapped_ratios(raw).items():
        raw_id = next(i for i in taps.index if ident(i) == tid)
        tap = int(taps.loc[raw_id, "tap"])
        rho = float(steps.loc[(raw_id, tap), "rho"]) * step / stated
        shunt = 100 * (1 / rho**2 - 1)
        n.update_ratio_tap_changer_steps(id=raw_id, position=tap, rho=rho, g=shunt, b=shunt)
        ratio[tid] = stated
    gens = n.get_generators(all_attributes=True)
    by_id = {ident(i): i for i in gens.index}
    regulating = []
    for f in raw["generator"]:
        gid = ident(f"B{f[0]}-G{f[1]}")
        g = gens.loc[by_id[gid]]
        if ide[int(f[0])] in (2, 3) and not g["voltage_regulator_on"] and g["target_v"] > 0 and g["min_q"] >= g["max_q"]:
            n.update_generators(id=by_id[gid], voltage_regulator_on=True)
            regulating.append(gid)
    return {"q0": q0, "voltage_regulator_on": regulating, "winding_1_ratio": ratio}


def golden(case):
    path = CACHE / CASES["archives"][case["archive"]]["file"]
    n = pp.network.load(str(path))
    corrected = corrections(n, path)
    slack = n.get_extensions("slackTerminal")
    params = parameters(sorted(slack["bus_id"]), "previous" if case["start"] == "raw" else "dc")

    def table(get):
        t = get(all_attributes=True)
        t.index = [ident(i) for i in t.index]
        return t

    gens = table(n.get_generators)
    imported = {
        "lines": {i: {k: num(r[k]) for k in ("r", "x", "g1", "b1", "g2", "b2")} for i, r in table(n.get_lines).iterrows()},
        "generators": {
            i: {"target_p": num(r["target_p"]), "target_q": num(r["target_q"]), "target_v": num(r["target_v"]), "regulating": bool(r["voltage_regulator_on"]), "min_q": num(r["min_q"]), "max_q": num(r["max_q"])}
            for i, r in gens.iterrows()
        },
        "loads": {i: {"p0": num(r["p0"]), "q0": num(r["q0"])} for i, r in table(n.get_loads).iterrows()},
        "shunts": {i: {"sections": int(r["section_count"]), "max_sections": int(r["max_section_count"]), "g": num(r["g"]), "b": num(r["b"])} for i, r in table(n.get_shunt_compensators).iterrows()},
        # Tap changers by transformer and side ("T-4-7-1#ONE"): steps, present step from the lowest, control.
        "ratio_taps": {
            f"{i}#{r['side'] or 'ONE'}": {"steps": int(r["step_count"]), "tap": int(r["tap"] - r["low_tap"]), "regulating": bool(r["regulating"]), "target_v": num(r["target_v"]), "deadband": num(r["target_deadband"])}
            for i, r in table(n.get_ratio_tap_changers).iterrows()
        },
        "phase_taps": {
            f"{i}#{r['side'] or 'ONE'}": {"steps": int(r["step_count"]), "tap": int(r["tap"] - r["low_tap"]), "regulating": bool(r["regulating"]), "target": num(r["regulation_value"]), "deadband": num(r["target_deadband"])}
            for i, r in table(n.get_phase_tap_changers).iterrows()
        },
    }
    out = {
        "source": f"pypowsybl {version('pypowsybl')} OpenLoadFlow; parameters {params}",
        "case": case["name"],
        "data": f"powsybl-core test resource {CASES['archives'][case['archive']]['url'].rsplit('/', 1)[-1]}, read from .cache/reference (not redistributed)",
        "slack": sorted(f"B{b[0]}" for b in sections(path)["bus"] if int(b[3]) == 3),
        "corrected": corrected,
        "imported": imported,
    }
    if case.get("loadflow", True):
        results = lf.run_ac(n, parameters=params)
        out["status"] = [r.status.name for r in results]
        buses = n.get_buses()
        vls = n.get_voltage_levels()

        def v(bus):
            """Voltage of a bus of the bus view, p.u. of its voltage level, and angle; None when not solved."""
            if not isinstance(bus, str) or not bus or num(buses.loc[bus, "v_mag"]) is None:
                return None
            b = buses.loc[bus]
            return [num(b["v_mag"]) / vls.loc[b["voltage_level_id"], "nominal_v"], num(b["v_angle"])]

        def branches(get, sides):
            return {
                i: {f"v{s}": v(r[f"bus{s}_id"]) for s in sides} | {f"{k}{s}": num(r[f"{k}{s}"]) for s in sides for k in ("p", "q")}
                for i, r in table(get).iterrows()
            }

        def injections(get, keys):
            return {i: {"v": v(r["bus_id"])} | {k: num(r[k]) for k in keys} for i, r in table(get).iterrows()}

        # Buses of the bus-breaker view by RAW number ("B12"); node-breaker buses are compared at equipment terminals.
        bb = n.get_bus_breaker_view_buses(all_attributes=True)
        out["loadflow"] = {
            "buses": {i: v(r["bus_id"]) for i, r in bb.iterrows() if re.fullmatch(r"B\d+", i) and v(r["bus_id"])},
            "lines": branches(n.get_lines, (1, 2)),
            "transformers2": branches(n.get_2_windings_transformers, (1, 2)),
            "transformers3": branches(n.get_3_windings_transformers, (1, 2, 3)),
            "generators": injections(n.get_generators, ("p", "q")),
            "loads": injections(n.get_loads, ("p", "q")),
            "shunts": injections(n.get_shunt_compensators, ("q",)),
        }
    golden_path = GOLDEN / f"psse-{case['name']}.json"
    golden_path.write_text(json.dumps(out, indent=1, sort_keys=True) + "\n")
    print(f"{golden_path.name}: {len(n.get_bus_breaker_view_buses())} buses, slack {out['slack']}, status {out.get('status', 'import only')}")


if __name__ == "__main__":
    wanted = set(sys.argv[1:])
    for case in CASES["cases"]:
        if not wanted or case["name"] in wanted:
            golden(case)
