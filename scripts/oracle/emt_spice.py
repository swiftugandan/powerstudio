"""Writes the EMT goldens: three-phase transients of PowerStudio documents simulated by ngspice.

For each case in tests/oracle/emt-cases.json the script

1. solves the document's load flow with pandapower, built field by field as scripts/oracle/oracle.py builds it;
2. writes the network as a SPICE circuit in volts, amperes, ohms, henries and farads, from the document's own data
   (line constants per kilometre, transformer short-circuit voltages and vector groups, machine reactances, the
   external grid's short-circuit power), with each source's EMF set from pandapower's operating point and each load
   an R ∥ L at pandapower's voltage;
3. has ngspice find the circuit's AC steady state and checks it against pandapower's voltages;
4. runs ngspice's transient analysis from that steady state (every inductor current and capacitor voltage given as
   an initial condition) through the case's events, with a step far shorter than the engine's;
5. writes the phase voltages of every busbar and the phase currents at every branch's from end, every source and the
   fault, resampled at the case's interval, to tests/oracle/golden/emt-<case>.json.

Nothing of PowerStudio's engine is used: no per-unit conversion, no winding model, no integration. What the engine and
this circuit share by design is stated in the case file: the breaker pole resistance and the conductance to earth of
every node (`engine`), and the switches act at the event times (the engine's `instantSwitching` option), as SPICE
switches are time-controlled; each moves over one engine step, as the engine's switching acts over its step.

SPICE has no coupled resistance and no ideal transformer element; a line's or source's zero-sequence resistance is a
current-controlled voltage source driven by the three phase currents, and an ideal transformer is a voltage-controlled
voltage source on its LV side, in series with the leakage impedance, with a current-controlled current source on its HV
side.

Run with the oracle environment (docs/TESTING.md) and ngspice on the path:

    .venv/bin/python scripts/oracle/emt_spice.py            # every case
    .venv/bin/python scripts/oracle/emt_spice.py ieee14-2phg  # one case
"""

import cmath
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import warnings
from pathlib import Path

import numpy as np
import pandapower as pp

sys.path.insert(0, str(Path(__file__).resolve().parent))
from oracle import build_net  # noqa: E402

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[2]
ORACLE = ROOT / "tests" / "oracle"
GOLDEN = ORACLE / "golden"
SQ3 = math.sqrt(3.0)
A = cmath.exp(2j * math.pi / 3)


def ngspice_version():
    out = subprocess.run(["ngspice", "-v"], capture_output=True, text=True).stdout
    m = re.search(r"ngspice-(\S+)", out)
    return m.group(1) if m else "unknown"


class Netlist:
    """A SPICE netlist with named nodes, every node given the case's conductance to earth."""

    def __init__(self, stray_pu, sb):
        self.lines = []
        self.nodes = {}
        self.count = 0
        self.stray_pu = stray_pu
        self.sb = sb
        self.inductors = {}  # name -> (node+, node-)
        self.capacitors = {}

    def node(self, name, kv, stray=False):
        """A node; `stray` gives it the conductance to earth the engine gives each of its own nodes (busbar phases,
        element terminals, star points), p.u. on the system base at the node's voltage. Nodes the engine has no
        counterpart for (inside an ideal transformer, a sense source's far side) get none: a conductance there would
        leak a delta winding's circulating zero sequence into an unearthed network."""
        if name not in self.nodes:
            self.nodes[name] = kv
            if stray:
                r = (kv * 1e3) ** 2 / (self.sb * 1e6) / self.stray_pu
                self.add(f"R{self.uid()} {name} 0 {r:.12g}")
        return name

    def uid(self):
        self.count += 1
        return f"x{self.count}"

    def add(self, text):
        self.lines.append(text)

    def r(self, a, b, ohm):
        self.add(f"R{self.uid()} {a} {b} {ohm:.12g}")

    def l(self, a, b, henry):
        name = f"L{self.uid()}"
        self.add(f"{name} {a} {b} {henry:.12g}")
        self.inductors[name] = (a, b)
        return name

    def c(self, a, b, farad):
        name = f"C{self.uid()}"
        self.add(f"{name} {a} {b} {farad:.12g}")
        self.capacitors[name] = (a, b)
        return name

    def sense(self, a, b):
        name = f"V{self.uid()}"
        self.add(f"{name} {a} {b} 0")
        return name

    def shunt(self, a, b, g, bsus, w, kv, tag):
        """A conductance and a susceptance between two nodes, siemens: R ∥ (C or L)."""
        if g > 0:
            self.r(a, b, 1.0 / g)
        if bsus > 0:
            self.c(a, b, bsus / w)
        elif bsus < 0:
            # A micro-ohm in series: a delta winding's magnetising inductances close a loop that has no DC solution
            # for SPICE's operating point (1e-10 of their reactance, nothing in the transient).
            mid = self.node(f"{a}_{b}_m{self.uid()}", kv)
            self.r(a, mid, 1e-6)
            self.l(mid, b, -1.0 / (w * bsus))

    def coupled(self, frm, to, r1, r0, l1, l0, kv, tag):
        """Three coupled series branches with sequence resistances and inductances: per phase r1, a source
        r_m·(ia + ib + ic) for the mutual resistance, and the self inductance l_s coupled to the others by
        K = l_m/l_s. Returns the sense sources of the phase currents."""
        rm, lm, ls = (r0 - r1) / 3.0, (l0 - l1) / 3.0, (l0 + 2 * l1) / 3.0
        start = [self.node(f"{tag}_s{k}", kv) for k in range(3)]
        senses = [self.sense(frm[k], start[k]) for k in range(3)]
        inductors = []
        for k in range(3):
            a = start[k]
            if r1 > 0:
                b = self.node(f"{tag}_r{k}", kv)
                self.r(a, b, r1)
                a = b
            if abs(rm) > 0:
                b = self.node(f"{tag}_h{k}", kv)
                self.add(f"H{self.uid()} {a} {b} POLY(3) {' '.join(senses)} 0 {rm:.15g} {rm:.15g} {rm:.15g}")
                a = b
            inductors.append(self.l(a, to[k], ls))
        if abs(lm) > 0:
            for i in range(3):
                for j in range(i + 1, 3):
                    self.add(f"K{self.uid()} {inductors[i]} {inductors[j]} {lm / ls:.15g}")
        return senses


def lead_of(conn_h, conn_l, oh, ol, rot, pol):
    """The LV side's lead over the HV side, degrees, at no load, for a winding arrangement: legs on the HV phases
    (a delta's leg k across phases k and k + oh), each feeding the LV winding on phase k + rot with polarity pol.
    The LV terminal voltages are solved from the winding voltages."""
    vh = [cmath.exp(-2j * math.pi * k / 3) for k in range(3)]
    w = []
    for k in range(3):
        w.append(vh[k] - vh[(k + oh) % 3] if conn_h == "D" else vh[k])
    wl = [None] * 3
    for k in range(3):
        wl[(k + rot) % 3] = pol * w[k]
    if conn_l == "D":
        # V_j − V_{j+ol} = wl_j, with the zero-sequence gauge ΣV = 0.
        m = np.zeros((4, 3), dtype=complex)
        rhs = np.zeros(4, dtype=complex)
        for j in range(3):
            m[j, j] += 1
            m[j, (j + ol) % 3] -= 1
            rhs[j] = wl[j]
        m[3, :] = 1
        v = np.linalg.lstsq(m, rhs, rcond=None)[0]
    else:
        v = wl
    return math.degrees(cmath.phase(v[0] / vh[0]))


def arrangement(conn_h, conn_l, clock):
    """The first winding arrangement whose LV side lags by clock × 30°."""
    for rot in range(3):
        for pol in (1, -1):
            for oh in ((1, 2) if conn_h == "D" else (0,)):
                for ol in ((1, 2) if conn_l == "D" else (0,)):
                    lag = (-lead_of(conn_h, conn_l, oh, ol, rot, pol)) % 360
                    if abs((lag - 30 * clock + 180) % 360 - 180) < 1e-6:
                        return oh, ol, rot, pol
    raise ValueError(f"no arrangement for {conn_h}{conn_l}{clock}")


def split_group(group):
    m = re.fullmatch(r"(YN|Y|D)(yn|y|d)(\d+)", group)
    if not m:
        raise ValueError(f"vector group {group} is not supported")
    return m.group(1).upper().replace("YN", "YN"), m.group(2).upper(), int(m.group(3)) % 12


def build(doc, case, lf):
    """The SPICE circuit of a document at pandapower's operating point."""
    f = doc["frequency"]
    w = 2 * math.pi * f
    sb = doc["baseMVA"]
    eng = case["engine"]
    nl = Netlist(eng["strayPu"], sb)
    els = doc["elements"]
    buses = {e["id"]: e for e in els if e["cls"] == "bus"}
    kv = {b: buses[b]["vn"] for b in buses}
    for b in buses:
        for k in range(3):
            nl.node(f"b_{b}_{k}", kv[b], stray=True)
    phase = lambda b: [f"b_{b}_{k}" for k in range(3)]
    ron = lambda kvv: eng["breakerPu"] * (kvv * 1e3) ** 2 / (sb * 1e6)
    switches = []  # (name, control node, closes at, opens at)
    probes = {"buses": {b: phase(b) for b in buses}, "branches": {}, "sources": {}, "faults": {}}
    closing = {e["target"]: e["t"] for e in case["events"] if e["kind"] == "close"}
    tripping = {e["target"]: e["t"] for e in case["events"] if e["kind"] == "trip"}

    def breaker(bus, eid, tag, closed):
        """A three-pole breaker from a bus to new terminal nodes, with sense sources; returns terminals and senses."""
        term, senses = [], []
        for k in range(3):
            t = nl.node(f"{tag}_t{k}", kv[bus], stray=True)
            x = nl.node(f"{tag}_q{k}", kv[bus])
            senses.append(nl.sense(phase(bus)[k], x))
            on = 0.0 if closed else closing.get(eid)
            off = tripping.get(eid)
            if closed and off is None:
                nl.r(x, t, ron(kv[bus]))
            else:
                switches.append((x, t, ron(kv[bus]), on, off))
            term.append(t)
        return term, senses

    for e in els:
        c, on = e["cls"], e.get("inService", True)
        if c == "line":
            par, ln = max(1, e["parallel"]), e["length"]
            r1, x1, b1 = e["r1"] * ln / par, e["x1"] * ln / par, e["b1"] * 1e-6 * ln * par
            if e["r0"] == 0 and e["x0"] == 0:
                r0, x0, b0 = r1, x1, b1
            else:
                r0, x0, b0 = e["r0"] * ln / par, e["x0"] * ln / par, e["b0"] * 1e-6 * ln * par
            kvl = kv[e["from"]]
            fterm, fs = breaker(e["from"], e["id"], f"{e['id']}_f", on)
            tterm, _ = breaker(e["to"], e["id"], f"{e['id']}_e", on)
            probes["branches"][e["id"]] = fs
            dt = case["dtUs"] * 1e-6
            tau1 = math.sqrt(x1 / w * b1 / w) if b1 > 0 else 0
            tau0 = math.sqrt(x0 / w * b0 / w) if b0 > 0 else 0
            travelling = case["lineModel"] == "auto" and tau1 >= dt and tau0 >= dt
            if travelling and on:
                raise ValueError(f"{e['id']}: SPICE's lossless lines start at rest, so a travelling-wave line must start out of service")
            if travelling:
                # Only lines whose sequences are equal decouple into three single-phase lines, which SPICE's lossless
                # line T models: R/4, half the line, R/2, half the line, R/4 (the engine's travelling-wave model).
                if not (abs(r0 - r1) < 1e-12 and abs(x0 - x1) < 1e-12 and abs(b0 - b1) < 1e-15):
                    raise ValueError(f"{e['id']}: a travelling-wave line needs equal sequences in the oracle")
                zc = math.sqrt((x1 / w) / (b1 / w))
                # SPICE's lossless line sets a breakpoint a travel time after every change of slope beyond REL and
                # ABS (1 and 1 V by default); at transmission voltages the reflections multiply them until the run
                # stalls. They are switched off: the maximum step bounds the error of interpolating the history.
                tline = f"Z0={zc:.12g} TD={tau1 / 2:.12g} REL=1e6 ABS=1e12"
                for k in range(3):
                    a1 = nl.node(f"{e['id']}_w1{k}", kvl)
                    a2 = nl.node(f"{e['id']}_w2{k}", kvl)
                    a3 = nl.node(f"{e['id']}_w3{k}", kvl)
                    a4 = nl.node(f"{e['id']}_w4{k}", kvl)
                    nl.r(fterm[k], a1, r1 / 4)
                    nl.add(f"T{nl.uid()} {a1} 0 {a2} 0 {tline}")
                    nl.r(a2, a3, r1 / 2)
                    nl.add(f"T{nl.uid()} {a3} 0 {a4} 0 {tline}")
                    nl.r(a4, tterm[k], r1 / 4)
            else:
                nl.coupled(fterm, tterm, r1, r0, x1 / w, x0 / w, kvl, f"{e['id']}_z")
                # Half the capacitances at each end: C0/2 to earth, (C1 − C0)/6 between phases.
                for term in (fterm, tterm):
                    cg, cpp = b0 / w / 2, (b1 - b0) / w / 6
                    for k in range(3):
                        if cg > 0:
                            nl.c(term[k], "0", cg)
                        if cpp > 0:
                            nl.c(term[k], term[(k + 1) % 3], cpp)
                        elif cpp < 0:
                            raise ValueError(f"{e['id']}: zero-sequence capacitance above the positive")
        elif c == "trafo":
            ch, cl, clock = split_group(e["vectorGroup"])
            oh, ol, rot, pol = arrangement(ch[0] if ch != "YN" else "Y", cl[0] if cl != "YN" else "Y", clock)
            sn, vh, vl = e["sn"], e["vnHV"], e["vnLV"]
            hv, lv = e["hv"], e["lv"]
            hterm, hs = breaker(hv, e["id"], f"{e['id']}_f", on)
            lterm, _ = breaker(lv, e["id"], f"{e['id']}_e", on)
            probes["branches"][e["id"]] = hs
            tap = 1 + (e["tapPos"] - e["tapNeutral"]) * e["tapStep"] / 100 if e.get("tapKind", "ratio") != "phase" else 1
            wh = 1.0 if ch == "D" else 1 / SQ3  # rated winding voltage per kV of line voltage
            wl = 1.0 if cl == "D" else 1 / SQ3
            n = (vh * tap * wh) / (vl * wl)
            # Short-circuit impedance referred to the LV side, Ω per phase of the star equivalent, then per LV winding.
            zl = vl ** 2 / sn
            rr = e["ur"] / 100 * zl
            xx = math.sqrt(max((e["uk"] / 100) ** 2 - (e["ur"] / 100) ** 2, 0)) * zl
            leg_scale = 3.0 if cl == "D" else 1.0
            # Magnetising admittance of the star equivalent, siemens at each side's rated voltage, by the document's split.
            g_pu, ym = e["pfe"] / 1000 / sn, e["i0"] / 100
            bm_pu = -math.sqrt(max(ym * ym - g_pu * g_pu, 0))
            at_hv = {"hv": 1.0, "lv": 0.0}.get(e.get("magnetising", "both"), 0.5)

            def neutral(conn, rn, xn, side):
                if conn == "D":
                    return None
                if conn == "Y":
                    return nl.node(f"{e['id']}_n{side}", kv[hv if side == 'h' else lv], stray=True)
                if rn == 0 and xn == 0:
                    return "0"
                nn = nl.node(f"{e['id']}_n{side}", kv[hv if side == 'h' else lv], stray=True)
                mid = nl.node(f"{e['id']}_m{side}", kv[hv if side == 'h' else lv])
                nl.r(nn, mid, rn) if rn > 0 else nl.add(f"V{nl.uid()} {nn} {mid} 0")
                nl.l(mid, "0", xn / w) if xn > 0 else nl.add(f"V{nl.uid()} {mid} 0 0")
                return nn

            nh = neutral(ch, e.get("rnHV", 0), e.get("xnHV", 0), "h")
            nlv = neutral(cl, e.get("rnLV", 0), e.get("xnLV", 0), "l")

            def winding(conn, term, k, o, nn):
                return (term[k], term[(k + o) % 3]) if conn == "D" else (term[k], nn)

            gh = g_pu * sn / vh ** 2 * at_hv
            bh = bm_pu * sn / vh ** 2 * at_hv
            gl = g_pu * sn / vl ** 2 * (1 - at_hv)
            bl = bm_pu * sn / vl ** 2 * (1 - at_hv)
            hscale = 3.0 if ch == "D" else 1.0
            for k in range(3):
                h1, h2 = winding(ch, hterm, k, oh, nh)
                j = (k + rot) % 3
                l1, l2 = winding(cl, lterm, j, ol, nlv)
                if pol < 0:
                    l1, l2 = l2, l1
                # The ideal transformer: the LV leg voltage follows the HV one (a voltage source in series with the
                # leakage, so no delta closes a loop of voltage sources) and the HV winding draws the LV current over
                # the ratio (a current source).
                m1 = nl.node(f"{e['id']}_m{k}", kv[lv])
                nl.add(f"E{nl.uid()} {m1} {l2} {h1} {h2} {1 / n:.15g}")
                p = nl.node(f"{e['id']}_p{k}", kv[lv])
                # A winding without resistance gets a micro-ohm: a delta's leakage inductances close a loop that has no
                # DC solution for SPICE's operating point.
                nl.r(m1, p, rr * leg_scale if rr > 0 else 1e-6)
                q = nl.node(f"{e['id']}_q{k}", kv[lv])
                nl.l(p, q, xx * leg_scale / w)
                vs = nl.sense(q, l1)
                nl.add(f"F{nl.uid()} {h1} {h2} {vs} {1 / n:.15g}")
                nl.shunt(h1, h2, gh / hscale, bh / hscale, w, kv[hv], e["id"])
                nl.shunt(l1, l2, gl / leg_scale, bl / leg_scale, w, kv[lv], e["id"])
        elif c in ("gen", "extgrid") and on:
            bus = e["bus"]
            vm, va = lf["bus"][bus]
            v = vm * kv[bus] * 1e3 / SQ3 * cmath.exp(1j * math.radians(va))
            p, q = lf["gen"][e["id"]] if c == "gen" else lf["ext_grid"][e["id"]]
            i = ((p + 1j * q) * 1e6 / (3 * v)).conjugate()
            if c == "gen":
                if e.get("scSource", "machine") != "machine":
                    raise ValueError(f"{e['id']}: only machine sources are in the EMT oracle")
                z = complex(e["rs"], e["xdss"]) * e["vn"] ** 2 / e["sn"]
                z0 = None  # PowerStudio's machines are unearthed
            else:
                x = kv[bus] ** 2 / e["skMax"] / math.sqrt(1 + e["rxMax"] ** 2)
                z = complex(e["rxMax"] * x, x)
                z0 = complex(e["r0x0"] * e["x0x1"] * x, e["x0x1"] * x) if e["x0x1"] > 0 else None
            emf = v + z * i
            term, senses = breaker(bus, e["id"], f"{e['id']}_g", True)
            probes["sources"][e["id"]] = senses
            if z0 is None:
                star = nl.node(f"{e['id']}_star", kv[bus], stray=True)
            else:
                star = "0"
            src = []
            for k in range(3):
                ek = emf * A ** (-k)
                s = nl.node(f"{e['id']}_e{k}", kv[bus])
                amp, ph = abs(ek) * math.sqrt(2), math.degrees(cmath.phase(ek))
                nl.add(f"V{nl.uid()} {s} {star} SIN(0 {amp:.15g} {f} 0 0 {ph + 90:.15g}) AC {amp:.15g} {ph:.15g}")
                src.append(s)
            if z0 is None:
                nl.coupled(src, term, z.real, z.real, z.imag / w, z.imag / w, kv[bus], f"{e['id']}_z")
            else:
                nl.coupled(src, term, z.real, z0.real, z.imag / w, z0.imag / w, kv[bus], f"{e['id']}_z")
        elif c == "load":
            bus = e["bus"]
            closed = on
            if not on and e["id"] not in closing:
                continue
            vm = lf["bus"][bus][0] if on else 1.0
            vll2 = (vm * kv[bus] * 1e3) ** 2
            term, _ = breaker(bus, e["id"], f"{e['id']}_d", closed)
            for k in range(3):
                nl.shunt(term[k], "0", e["p"] * 1e6 / vll2, -e["q"] * 1e6 / vll2, w, kv[bus], e["id"])
        elif c == "shunt":
            if not on and e["id"] not in closing:
                continue
            bus = e["bus"]
            term, _ = breaker(bus, e["id"], f"{e['id']}_c", on)
            vn2 = (e["vn"] * 1e3) ** 2
            for k in range(3):
                nl.shunt(term[k], "0", e["p"] * e["sections"] * 1e6 / vn2, e["q"] * e["sections"] * 1e6 / vn2, w, kv[bus], e["id"])
    # Faults.
    for ev in case["events"]:
        if ev["kind"] != "fault":
            continue
        bus, kind = ev["target"], ev.get("fault", "3ph")
        rf = max(ev.get("r", 0.0), ron(kv[bus]))
        clear = next((x["t"] for x in case["events"] if x["kind"] == "clear" and x["target"] == bus and x["t"] > ev["t"]), None)
        paths = {"3ph": [(0, "0"), (1, "0"), (2, "0")], "1ph": [(0, "0")], "2phg": [(1, "0"), (2, "0")], "2ph": [(1, 2)]}[kind]
        per = [[], [], []]
        for a, b in paths:
            x = nl.node(f"f_{bus}_{a}", kv[bus])
            s = nl.sense(phase(bus)[a], x)
            other = "0" if b == "0" else phase(bus)[b]
            switches.append((x, other, rf, ev["t"], clear))
            per[a].append([s, 1])
            if b != "0":
                per[b].append([s, -1])
        probes["faults"][bus] = per
    # Time-controlled switches: a control voltage ramps to 1 V over `switchRampUs` at closing and back to 0 at opening,
    # and XSPICE's switch moves its resistance between 1e12 Ω and its closed value logarithmically with it. (SPICE's
    # abrupt switch stalls its step control when it closes onto line capacitance; a ramp as long as the engine's step
    # delays the switching by most of a step, which shifts the phase of the ringing that follows.)
    ramp = case["switchRampUs"] * 1e-6
    for k, (a, b, ron_, t_on, t_off) in enumerate(switches):
        ctl = f"ctl{k}"
        pts = ["0 0"]
        if t_on is not None:
            pts += [f"{t_on:.12g} 0", f"{t_on + ramp:.12g} 1"]
        if t_off is not None:
            if t_on is None:
                pts = ["0 1", f"{t_off:.12g} 1", f"{t_off + ramp:.12g} 0"]
            else:
                pts += [f"{t_off:.12g} 1", f"{t_off + ramp:.12g} 0"]
        nl.add(f"V{ctl} {ctl} 0 PWL({' '.join(pts)})")
        nl.add(f"R{nl.uid()} {ctl} 0 1e6")
        nl.add(f"A{nl.uid()} %v({ctl}) %gd({a} {b}) sw{k}")
        nl.add(f".model sw{k} aswitch(cntl_off=0 cntl_on=1 r_off=1e12 r_on={ron_:.12g} log=TRUE)")
    return nl, probes


def run(netlist, control):
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "case.cir"
        path.write_text("* PowerStudio EMT oracle\n" + "\n".join(netlist) + "\n.control\n" + control.replace("@DIR", d) + "\n.endc\n.end\n")
        if os.environ.get("EMT_SPICE_KEEP"):
            Path(os.environ["EMT_SPICE_KEEP"]).write_text(path.read_text())
        out = subprocess.run(["ngspice", "-b", str(path)], capture_output=True, text=True, cwd=d)
        text = (out.stdout + out.stderr).lower()
        # ngspice reports a failed analysis and carries on with the commands after it, writing what it has.
        if any(x in text for x in ("aborted", "timestep too small", "singular matrix", "error")):
            raise RuntimeError(out.stdout[-3000:] + out.stderr[-3000:])
        files = {p.name: p.read_text() for p in Path(d).glob("*.txt")}
    if not files:
        raise RuntimeError(out.stdout[-3000:] + out.stderr[-3000:])
    return files


def table(text):
    rows = [l.split() for l in text.strip().splitlines()]
    head, body = rows[0], np.array([[float(x) for x in r] for r in rows[1:]])
    return head, body


def solve_case(case):
    doc = json.loads((ORACLE / case["input"]).read_text())
    net = build_net(doc)
    pp.runpp(net, algorithm="nr", init="dc", tolerance_mva=1e-9, trafo_model="pi", calculate_voltage_angles=True, max_iteration=50)
    lf = {
        "bus": {net.bus.name[i]: (float(net.res_bus.vm_pu[i]), float(net.res_bus.va_degree[i])) for i in net.bus.index},
        "gen": {net.gen.name[i]: (float(net.res_gen.p_mw[i]), float(net.res_gen.q_mvar[i])) for i in net.gen.index},
        "ext_grid": {net.ext_grid.name[i]: (float(net.res_ext_grid.p_mw[i]), float(net.res_ext_grid.q_mvar[i])) for i in net.ext_grid.index},
    }
    # pandapower returns a flat start, ignoring the grids' angles, for a network with no branch in service.
    for i in net.ext_grid.index[net.ext_grid.in_service]:
        va = float(net.res_bus.va_degree[net.ext_grid.bus[i]])
        if abs(va - float(net.ext_grid.va_degree[i])) > 1e-6:
            raise ValueError(f"{case['name']}: the load flow puts grid {net.ext_grid.name[i]}'s busbar at {va}°")
    nl, probes = build(doc, case, lf)
    f = doc["frequency"]
    w = 2 * math.pi * f
    # 1. The AC steady state: every node voltage and inductor current.
    nodes = sorted(nl.nodes)
    vecs = [f"v({n})" for n in nodes] + [f"{l.lower()}#branch" for l in nl.inductors]
    chunks = [vecs[i:i + 200] for i in range(0, len(vecs), 200)]
    control = "set wr_singlescale\nset wr_vecnames\noption numdgt=15\nac lin 1 {f} {f}\n".format(f=f)
    for k, ch in enumerate(chunks):
        control += f"wrdata @DIR/ac{k}.txt {' '.join(ch)}\n"
    files = run(nl.lines, control)
    phasor = {}
    for k, ch in enumerate(chunks):
        head, body = table(files[f"ac{k}.txt"])
        for j, name in enumerate(ch):
            phasor[name] = complex(body[0, 1 + 2 * j], body[0, 2 + 2 * j])
    worst = 0.0
    for bus, (vm, va) in lf["bus"].items():
        kvb = next(e["vn"] for e in doc["elements"] if e["id"] == bus)
        want = vm * kvb * 1e3 / SQ3 * math.sqrt(2) * cmath.exp(1j * math.radians(va))
        got = phasor[f"v(b_{bus}_0)"]
        worst = max(worst, abs(got - want) / abs(want))
    if worst > 1e-4:
        raise RuntimeError(f"{case['name']}: ngspice's steady state differs from pandapower's load flow by {worst:.2e}")
    # 2. The transient from that steady state.
    netlist = []
    for line in nl.lines:
        name = line.split()[0]
        if name in nl.inductors:
            netlist.append(f"{line} IC={phasor[name.lower() + '#branch'].real:.15g}")
        elif name in nl.capacitors:
            a, b = nl.capacitors[name]
            va = phasor[f"v({a})"] if a != "0" else 0
            vb = phasor[f"v({b})"] if b != "0" else 0
            netlist.append(f"{line} IC={(va - vb).real:.15g}")
        else:
            netlist.append(line)
    t_end, dt = case["tEnd"], case["dtUs"] * 1e-6
    every = case["sampleUs"] * 1e-6
    probe_vecs = []
    for b, ns in probes["buses"].items():
        probe_vecs += [f"v({n})" for n in ns]
    for group in ("branches", "sources"):
        for _, ss in probes[group].items():
            probe_vecs += [f"i({s})" for s in ss]
    for _, per in probes["faults"].items():
        for lst in per:
            probe_vecs += [f"i({s})" for s, _ in lst]
    probe_vecs = list(dict.fromkeys(probe_vecs))
    chunks = [probe_vecs[i:i + 150] for i in range(0, len(probe_vecs), 150)]
    control = (
        "set wr_singlescale\nset wr_vecnames\noption numdgt=12\n"
        + f"tran {every:.12g} {t_end:.12g} 0 {case['spiceMaxStepUs'] * 1e-6:.12g} uic\n"
        + f"linearize\n"
    )
    for k, ch in enumerate(chunks):
        control += f"wrdata @DIR/tr{k}.txt {' '.join(ch)}\n"
    files = run(netlist + [".options method=gear maxord=2 reltol=1e-6 abstol=1e-6 vntol=1e-4 itl4=200"], control)
    series = {}
    t = None
    for k, ch in enumerate(chunks):
        head, body = table(files[f"tr{k}.txt"])
        t = body[:, 0]
        for j, name in enumerate(ch):
            series[name] = body[:, 1 + j]
    kvs = {e["id"]: e["vn"] for e in doc["elements"] if e["cls"] == "bus"}
    r6 = lambda a: [float(f"{x:.6g}") for x in a]
    out = {
        "source": f"ngspice-{ngspice_version()} transient (second-order Gear, reltol=1e-6, step at most {case['spiceMaxStepUs']} µs) from its own AC steady state at pandapower {pp.__version__}'s load flow",
        "case": case,
        "steadyStateVsLoadFlow": worst,
        "t": r6(t),
        "buses": {b: [r6(series[f"v({n})"] / 1e3) for n in ns] for b, ns in probes["buses"].items()},
        "branches": {b: [r6(series[f"i({s})"] / 1e3) for s in ss] for b, ss in probes["branches"].items()},
        "sources": {b: [r6(-series[f"i({s})"] / 1e3) for s in ss] for b, ss in probes["sources"].items()},
        "faults": {
            b: [r6(sum((sign * series[f"i({s})"] for s, sign in lst), np.zeros_like(t)) / 1e3) for lst in per]
            for b, per in probes["faults"].items()
        },
    }
    path = GOLDEN / f"emt-{case['name']}.json"
    path.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(f"wrote {path.relative_to(ROOT)}: {len(t)} samples, steady state within {worst:.1e} of the load flow")


def main():
    cases = json.loads((ORACLE / "emt-cases.json").read_text())
    names = sys.argv[1:]
    for case in cases["cases"]:
        if names and case["name"] not in names:
            continue
        solve_case({**cases["defaults"], **case})


if __name__ == "__main__":
    sys.exit(main())
