"""Checks PowerStudio's CGMES steady-state hypothesis (SSH) export against PowSyBl.

The engine test engine/crates/ps-study/tests/cgmes_ssh.rs edits each configuration's operating point as a user would
(a load's active and reactive power, a machine's voltage target, a transformer's tap, a line switched out) and
exports it. With PS_SSH_DIR set it writes, per configuration, the files with the exported SSH and SV in place of the
input's, and what they should say (`expected.json`). This script has PowSyBl read those files and checks that it
finds the edited values: so the SSH uses the CGMES properties another importer reads, not only PowerStudio's.

    (cd engine && PS_SSH_DIR=/tmp/ssh cargo test --release -p ps-study --test cgmes_ssh)
    python scripts/oracle/ssh_check.py /tmp/ssh

It writes nothing into the repository.
"""

import io
import json
import sys
import warnings
import zipfile
from pathlib import Path

import pypowsybl as pp

warnings.filterwarnings("ignore")
TOL = 1e-9


def network(folder):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for f in sorted(folder.glob("*.xml")):
            z.writestr(f.name, f.read_bytes())
    return pp.network.load_from_binary_buffer(io.BytesIO(buf.getvalue()))


def check(folder):
    want = json.loads((folder / "expected.json").read_text())
    n = network(folder)
    found, problems = [], []

    load = want.get("load")
    if load:
        # PowSyBl keeps an equivalent injection inside the network as a generator (producer sign), and one at a
        # boundary inside the dangling line of its boundary line, under the line's identifier.
        loads, gens = n.get_loads(), n.get_generators()
        if load["id"] in loads.index:
            got = {"p": loads.loc[load["id"], "p0"], "q": loads.loc[load["id"], "q0"]}
        elif load["id"] in gens.index:
            got = {"p": -gens.loc[load["id"], "target_p"], "q": -gens.loc[load["id"], "target_q"]}
        else:
            got = None
            found.append("(a boundary injection, which PowSyBl folds into a dangling line, not checked)")
        if got is not None:
            for k in ("p", "q"):
                if abs(got[k] - load[k]) > TOL * max(1.0, abs(load[k])):
                    problems.append(f"load {load['id']} {k} {got[k]} is not {load[k]}")
            found.append("load P and Q")

    gen = want.get("generator")
    if gen:
        gens = n.get_generators()
        if gen["id"] not in gens.index:
            problems.append(f"generator {gen['id']} is not in PowSyBl's network")
        elif abs(gens.loc[gen["id"], "target_v"] - gen["kv"]) > 1e-6 * gen["kv"]:
            problems.append(f"generator {gen['id']} target {gens.loc[gen['id'], 'target_v']} kV is not {gen['kv']} kV")
        else:
            found.append("voltage target")

    tap = want.get("tap")
    if tap:
        table = n.get_phase_tap_changers() if tap["phase"] else n.get_ratio_tap_changers()
        if tap["id"] not in table.index:
            problems.append(f"transformer {tap['id']} has no {'phase' if tap['phase'] else 'ratio'} tap changer in PowSyBl")
        elif int(table.loc[tap["id"], "tap"]) != tap["position"]:
            problems.append(f"transformer {tap['id']} is at tap {table.loc[tap['id'], 'tap']}, not {tap['position']}")
        else:
            found.append("tap position")

    line = want.get("line")
    if line:
        # A line to a boundary is a dangling line in PowSyBl.
        lines, dangling = n.get_lines(), n.get_dangling_lines()
        if line in lines.index:
            connected = lines.loc[line, "connected1"] or lines.loc[line, "connected2"]
        elif line in dangling.index:
            connected = dangling.loc[line, "connected"]
        else:
            connected = None
            problems.append(f"line {line} is not in PowSyBl's network")
        if connected:
            problems.append(f"line {line} is still connected in PowSyBl")
        elif connected is not None:
            found.append("line out of service")
    return found, problems


def main():
    root = Path(sys.argv[1])
    failures = 0
    for folder in sorted(p for p in root.iterdir() if (p / "expected.json").exists()):
        found, problems = check(folder)
        status = "ok" if not problems else "FAILED"
        print(f"{folder.name}: {status}; PowSyBl reads {', '.join(found) or 'nothing checked'}")
        for p in problems:
            print(f"  {p}")
        failures += bool(problems)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
