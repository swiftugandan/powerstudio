"""Reference trajectories for PowerStudio's stability simulation, computed by ANDES.

Reads tests/oracle/dyn-cases.json. For each case it loads the PSS/E RAW and DYR files from .cache/reference (ANDES's
own published cases, fetched by scripts/fetch-reference.mjs at a pinned commit), removes the events the DYR file
carries (ANDES's `Toggle` records), adds the case's events, runs ANDES's time-domain simulation with a fixed step and a
tight Newton tolerance, and writes tests/oracle/golden/dyn-<case>.json with:

- `powerflow`: every bus's voltage magnitude and angle after ANDES's load flow;
- `init`: every dynamic model's variables after initialisation, per generator (an initialisation that differs is a
  parameter or equation difference; a trajectory that differs after an identical start is the integration or the
  events);
- `traces`: per generator the rotor angle, speed, electrical and reactive power, field voltage and mechanical torque,
  and per bus the voltage magnitude (every bus of a case up to 50 buses, else the generators' and the faulted buses),
  at the steps nearest the case's sample times, to ten significant digits.

Names are PowerStudio's: busbar `B<number>`, generator `B<number>-G<id>`, line `L-<from>-<to>-<circuit>`. Run with the
ANDES venv's Python (docs/TESTING.md):

    python scripts/oracle/andes_dyn.py            # every case
    python scripts/oracle/andes_dyn.py kundur-gencls
    python scripts/oracle/andes_dyn.py --tstep 0.0005 --out /tmp/half   # ANDES at another step, elsewhere

The last form measures ANDES against itself: the differences between its trajectories at two steps are the scale of
the numerical uncertainty the engine's tolerances must allow (docs/TESTING.md).

Two kinds of change make ANDES compute the models as the PSS/E library defines them:

- `overrides` in a case change a parameter in both programs. ESDC2A's TR is set to zero because ANDES 2.0.0 computes
  ESDC2A's voltage transducer but leaves it out of the loop (the summing junction reads the terminal voltage
  directly); with TR = 0 both read the same model.
- Corrections, here only, put on the machine's base two quantities ANDES leaves on the system base: ESST3A's terminal
  current in VE (IEEE 421.5 and PSS/E use the machine's base; ANDES's Id and Iq are on the system base, so KI and XL
  are scaled by Sb/Sn), and IEEEG1's valve rate limits UO and UC (ANDES converts the governor's power quantities to
  the system base except these, so they are scaled by Sn/Sb). On a machine rated at the system base nothing changes.

It writes only the goldens.
"""

import json
import sys
import tempfile
from pathlib import Path

import andes
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
CASES = ROOT / "tests" / "oracle" / "dyn-cases.json"
GOLDEN = ROOT / "tests" / "oracle" / "golden"
REFERENCE = ROOT / ".cache" / "reference"

# The variables recorded per generator, by ANDES name. `delta` rad, `omega` p.u., `Pe` and `Qe` p.u. on the system
# base, `vf` p.u., `tm` p.u.
TRACED = ["delta", "omega", "Pe", "Qe", "vf", "tm"]
# Groups of controllers, and the parameter naming the generator (or the exciter) each one belongs to.
CONTROLLERS = {"Exciter": "syn", "TurbineGov": "syn", "PSS": "avr"}


# The control models of each slot, to find the record a replacement takes the place of.
SLOTS = {
    "exciter": {"SEXS", "IEEET1", "EXDC2", "ESDC2A", "EXST1", "ESST1A", "ESST3A"},
    "governor": {"TGOV1", "IEEEG1", "HYGOV"},
    "stabiliser": {"IEEEST", "ST2CUT"},
}


def without_events(dyr_text):
    """The DYR text without ANDES's `Toggle` records, which are not PSS/E data."""
    records = dyr_text.split("/")
    return "/".join(r for r in records if "Toggle" not in r)


def replaced(dyr_text, replace):
    """The DYR text with each replacement's record in place of the machine's record of the same slot."""
    records = [r for r in dyr_text.split("/") if r.strip()]
    for rep in replace:
        bus = int(rep["generator"].split("-")[0][1:])
        slot = next(k for k, v in SLOTS.items() if rep["model"] in v)

        def same(r):
            words = r.split()
            return len(words) > 1 and int(words[0]) == bus and words[1].strip("'").strip() in SLOTS[slot]

        records = [r for r in records if not same(r)]
        records.append(f"\n  {bus} '{rep['model']}' 1 " + " ".join(repr(float(v)) for v in rep["values"]) + " ")
    return "/".join(records) + "/\n"


def gen_id(ss, static_idx):
    """PowerStudio's identifier of a static generator, B<bus>-G<id>. ANDES keeps no machine identifier, so the cases
    have one machine per bus, with identifier 1."""
    for model in (ss.PV, ss.Slack):
        if static_idx in model.idx.v:
            bus = model.bus.v[model.idx.v.index(static_idx)]
            assert list(ss.PV.bus.v).count(bus) + list(ss.Slack.bus.v).count(bus) == 1, f"two machines at bus {bus}"
            return f"B{bus}-G1"
    raise KeyError(static_idx)


def line_idx(ss, target):
    """ANDES's line for PowerStudio's L-<from>-<to>-<circuit>. ANDES keeps no circuit identifier; parallel circuits
    are taken in file order, circuit 1 first."""
    _, i, j, ckt = target.split("-")
    matches = [ss.Line.idx.v[k] for k, (a, b) in enumerate(zip(ss.Line.bus1.v, ss.Line.bus2.v)) if {str(a), str(b)} == {i, j}]
    return matches[int(ckt) - 1]


def correct(ss):
    """The corrections described above; returns what was changed."""
    sb, done = ss.config.mva, []

    def sn_of(syn):
        return float(ss.SynGen.get(src="Sn", idx=syn, attr="v"))

    for k, idx in enumerate(ss.ESST3A.idx.v):
        f = sb / sn_of(ss.ESST3A.syn.v[k])
        if f != 1.0:
            for name in ("KI", "XL"):
                ss.ESST3A.set(name, idx, ss.ESST3A.__dict__[name].v[k] * f, base="device")
            done.append(f"ESST3A {idx}: KI and XL times Sb/Sn = {f:.6g}")
    for k, idx in enumerate(ss.IEEEG1.idx.v):
        f = sn_of(ss.IEEEG1.syn.v[k]) / sb
        if f != 1.0:
            for name in ("UO", "UC"):
                ss.IEEEG1.set(name, idx, ss.IEEEG1.__dict__[name].v[k] * f, base="device")
            done.append(f"IEEEG1 {idx}: UO and UC times Sn/Sb = {f:.6g}")
    return done


def override(ss, case):
    """The case's parameter overrides, in both programs."""
    for o in case.get("overrides", []):
        model = ss.models[o["model"]]
        for idx in model.idx.v:
            model.set(o["param"], idx, o["value"], base="device")


def run(case, tstep=None):
    raw = REFERENCE / case["raw"]
    dyr = REFERENCE / case["dyr"]
    with tempfile.TemporaryDirectory() as tmp:
        stripped = Path(tmp) / dyr.name
        stripped.write_text(replaced(without_events(dyr.read_text()), case.get("replace", [])))
        ss = andes.load(str(raw), addfile=str(stripped), setup=False, no_output=True, default_config=True)
        # Faults pair a fault event with its clearance at the same bus.
        events = sorted(case["events"], key=lambda e: e["t"])
        for e in events:
            if e["kind"] == "fault":
                clear = next(c for c in events if c["kind"] == "clear" and c["target"] == e["target"] and c["t"] > e["t"])
                ss.add("Fault", {"bus": int(e["target"][1:]), "tf": e["t"], "tc": clear["t"], "xf": e["xf"], "rf": e["rf"]})
            elif e["kind"] in ("trip", "close"):
                # A toggle switches a line out, and the next one back in.
                ss.add("Toggle", {"model": "Line", "dev": line_idx(ss, e["target"]), "t": e["t"]})
        ss.setup()
        override(ss, case)
        corrections = correct(ss)
        ss.PFlow.config.tol = 1e-12
        ss.PFlow.run()
        assert ss.PFlow.converged, case["name"]
        powerflow = {f"B{b}": {"v": float(ss.Bus.v.v[k]), "a": float(ss.Bus.a.v[k])} for k, b in enumerate(ss.Bus.idx.v)}
        ss.TDS.config.tf = case["tf"]
        ss.TDS.config.tstep = tstep or case["tstep"]
        ss.TDS.config.fixt = 1
        ss.TDS.config.shrinkt = 0
        ss.TDS.config.tol = 1e-10
        ss.TDS.config.max_iter = 50
        ss.TDS.config.no_tqdm = 1
        ss.TDS.init()

        # Generators: the dynamic model of each static generator.
        gens = []
        for name in ("GENCLS", "GENROU"):
            model = ss.models[name]
            for k in range(model.n):
                gens.append((name, k, gen_id(ss, model.gen.v[k]), model.idx.v[k]))
        syn_of = {idx: gid for _, _, gid, idx in gens}

        def variables(model, k):
            out = {}
            for vname, var in list(model.states.items()) + list(model.algebs.items()):
                out[vname] = float(var.v[k])
            return out

        init = {}
        for name, k, gid, _ in gens:
            init[gid] = {"machine": {"model": name, **variables(ss.models[name], k)}}
        exciter_of = {}
        for group, key in CONTROLLERS.items():
            for model in ss.groups[group].models.values():
                for k in range(model.n):
                    owner = model.__dict__[key].v[k]
                    gid = syn_of[owner] if key == "syn" else exciter_of[owner]
                    if group == "Exciter":
                        exciter_of[model.idx.v[k]] = gid
                    slot = {"Exciter": "exciter", "TurbineGov": "governor", "PSS": "stabiliser"}[group]
                    init[gid][slot] = {"model": model.class_name, **variables(model, k)}

        # The values at t = 0, which ANDES does not store with the steps.
        x0, y0 = np.array(ss.dae.x, copy=True), np.array(ss.dae.y, copy=True)
        ss.TDS.run()
        assert ss.exit_code == 0, f"{case['name']}: ANDES stopped with exit code {ss.exit_code}"
        ts = ss.dae.ts
        t = np.concatenate([[0.0], np.asarray(ts.t)])
        xs, ys = np.vstack([x0, ts.x]), np.vstack([y0, ts.y])
        # ANDES steps onto each event and takes a 0.1 ms step after it, so its grid moves after an event: the stored
        # samples are the steps nearest to each sample time, with their own times, and the engine test interpolates.
        rows = sorted({int(np.argmin(np.abs(t - s))) for s in np.arange(0.0, case["tf"] + 1e-9, case["sample"])})

        def series(var, k):
            arr = xs if var.v_code == "x" else ys
            return [float(f"{arr[r, var.a[k]]:.10g}") for r in rows]

        traces = {"t": [float(t[r]) for r in rows], "generators": {}, "buses": {}}
        for name, k, gid, _ in gens:
            model = ss.models[name]
            traces["generators"][gid] = {v: series(model.__dict__[v], k) for v in TRACED}
        # Every bus of a small case; of a large one, the generators' buses and the events' buses.
        kept = set(ss.Bus.idx.v) if ss.Bus.n <= 50 else (
            {b for m in (ss.PV, ss.Slack) for b in m.bus.v} | {int(e["target"][1:]) for e in events if e["kind"] == "fault"})
        for k, bus in enumerate(ss.Bus.idx.v):
            if bus in kept:
                traces["buses"][f"B{bus}"] = series(ss.Bus.v, k)

        return {
            "about": f"ANDES {andes.__version__} reference for case '{case['name']}' of tests/oracle/dyn-cases.json; "
            "written by scripts/oracle/andes_dyn.py. Do not edit by hand.",
            "andes": andes.__version__,
            "settings": {"tstep": tstep or case["tstep"], "tol": 1e-10, "method": "trapezoid, fixed step",
                         "loads": "constant impedance (PQ.p2z = PQ.q2z = 1)", "corrections": corrections,
                         "overrides": case.get("overrides", [])},
            "powerflow": powerflow,
            "init": init,
            "traces": traces,
        }


def main():
    andes.config_logger(stream_level=40)
    spec = json.loads(CASES.read_text())
    args = sys.argv[1:]
    tstep, out_dir = None, GOLDEN
    if "--tstep" in args:
        k = args.index("--tstep")
        tstep = float(args[k + 1])
        del args[k:k + 2]
    if "--out" in args:
        k = args.index("--out")
        out_dir = Path(args[k + 1])
        out_dir.mkdir(parents=True, exist_ok=True)
        del args[k:k + 2]
    wanted = set(args)
    for case in spec["cases"]:
        if wanted and case["name"] not in wanted:
            continue
        golden = run(case, tstep)
        out = out_dir / f"dyn-{case['name']}.json"
        out.write_text(json.dumps(golden, indent=None, separators=(",", ":")) + "\n")
        print(f"{case['name']}: {len(golden['traces']['generators'])} generators, "
              f"{len(golden['traces']['t'])} samples -> {out}")


if __name__ == "__main__":
    main()
