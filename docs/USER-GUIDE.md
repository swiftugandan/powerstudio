# PowerStudio user guide

PowerStudio is a power system workbench that runs in a browser tab: draw or import a network, then run load flows,
IEC 60909-style short circuits, contingency analysis and stability simulations on it. Everything happens on your
device; nothing is uploaded. This guide walks through the work in the order you will meet it. docs/ENGINE.md describes
exactly what each calculation computes; the README lists what PowerStudio does not do.

## Starting

Open `PowerStudio.html` (the single file from a release, or the hosted app). The first time, it opens the IEEE
14-bus sample (a 132/33/11 kV transmission benchmark), ready to calculate; after that, the network you last worked on.
The File tab's page starts something else: an empty network, the IEEE 14-bus sample again, or the Riverside sample (a
110/20/0.4 kV distribution network with a cable ring and a CHP unit), with your recent networks below them.

Your work is saved in this browser as you go; the title bar shows "Saved". To keep a copy elsewhere or move it to
another machine, export it (see [Saving, exporting and printing](#saving-exporting-and-printing)).

The workspace has, from top to bottom: the title bar with the network's name, the study case chip and the command
search; the ribbon; the model tree (left), the diagram (centre) and the inspector (right); the results panel; and the
status bar. Every command is in the command palette (Ctrl+K, or ⌘K on a Mac), which also finds elements by name.

## Drawing a network

Choose a tool on the Insert tab, or press its key:

| Tool | Key | Places |
| --- | --- | --- |
| Busbar | B | A busbar; drag its ends to lengthen it |
| Line | L | A line between two busbars of the same voltage: click one busbar, then the other |
| Transformer | T | A two-winding transformer between two voltage levels |
| Machine | G | A synchronous machine (or, by its short-circuit source, a network feeder or a converter-fed unit) |
| External grid | E | The equivalent of the upstream network, which holds the voltage and balances the system |
| Load | D | A load |
| Shunt | C | A capacitor bank or reactor |

Select (V) moves and selects; Pan (H), or holding Space, moves the view. Escape ends a tool. Drag a connection along
its busbar to move it; drag a branch's middle to route it. Arrange (Home tab) lays the whole diagram out again from
the network's topology, as one undoable step.

Selected elements can be cut, copied, pasted, duplicated, deleted, nudged with the arrow keys and switched in or out of
service (Shift+O). Every change can be undone (Ctrl+Z) and redone (Ctrl+Shift+Z).

## Element data

The inspector shows the selected element's data in groups: basic data, load flow, short circuit, stability and
diagram. Each field says its unit; hover a label for what the value means. A value outside its allowed range is
refused with the reason below the field, and the old value stays.

A few fields deserve a note:

- **Transformers** take their rated voltages, rated power, short-circuit voltage uk and copper losses uR, vector
  group, magnetising branch and tap changer. Automatic tap control holds a busbar voltage (ratio) or a flow (phase)
  when the study case lets tap changers regulate. The short-circuit group holds the zero-sequence impedance, the
  neutral earthing of an earthed star winding, and whether the tap changer works on load (for power station units).
- **Machines** have a control mode (PV, PQ or reference), limits, ratings, and the data for the other calculations.
  Their short-circuit source is a choice: a synchronous machine (subtransient reactance, voltage regulation range, and
  a unit transformer that makes the two a power station unit), a network feeder (short-circuit power and R/X, for the
  equivalent of a neighbouring network that regulates like a machine) or a converter (k times the rated current, for
  wind and solar parks and batteries). Stability data cover the rotor model (classical or round rotor) and the
  exciter, governor and stabiliser, each with its parameters under the model's name.
- **Loads** have constant impedance and constant current shares of their power; a load that is an asynchronous motor
  feeds maximum short-circuit currents through its own data.

The Data tab of the results panel shows every element of a class as a table: select cells across rows and type to
change them all, paste a block from a spreadsheet, and undo it as one step.

## The study case

A study case holds the settings of every calculation: the load-flow tolerance and controls, the short-circuit fault
type, case, voltage factor tolerance, breaking time, fault duration, line temperature and fault impedance, the
contingency list and remedial actions, and the simulation's time, step and events. Open it with Ctrl+, (Calculate,
Study case). The ribbon's Calculate tab holds the common switches (fault type, maximum or minimum, reactive limits).

A project can hold several study cases, scenarios (the operating values: switching states, set points, loads,
generation, taps) and variants (planned changes recorded as a sequence of edits, switched on per study case). Manage
them from the study case chip in the title bar or File, Project. While a variant records, edits go into it instead of
the base network.

## Calculating

| Calculation | Key | What it gives |
| --- | --- | --- |
| Load flow | Alt+L (or Ctrl+Enter) | Bus voltages and angles, branch flows, losses and loadings, machine outputs |
| Short circuit | Alt+S | Ik″, ip, Ib, Ith and Sk″ at every busbar, or at one with the branch contributions |
| Contingency | Alt+N | Each branch (and optionally machine and busbar) out in turn, and the study case's contingencies, with the violations each causes |
| Simulation | Alt+R | Rotor angles, speeds, powers, field voltages and bus voltages over time, for the study case's events |

Ctrl+. cancels a running calculation. With "Recalculate on edit" on, the load flow runs again after every change.

Results appear on the diagram (coloured by loading or voltage, with result boxes) and in the results panel's tab for
the calculation. Click a row to select the element; sort by any column; export the table as CSV. A result that no
longer matches the network after an edit is marked as old.

**Short circuit.** Choose a fault type (three-phase, line-to-line, line-to-earth) and maximum or minimum currents. With
no location the fault is applied at every busbar in turn; select a busbar and choose "Short circuit at selected
busbar" for one location, which also lists the current in every branch. Ib is shown for maximum three-phase currents,
the case IEC 60909 defines it for. The calculation follows the method of IEC 60909-0 and is checked against the
standard's TR 60909-4 example; it is not certified (docs/ENGINE.md).

**Contingency.** The contingency editor (Calculate, Contingencies) defines outages of several elements together and
remedial actions with conditions. The results list each contingency with whether it solved and the violations it
brings beyond the base case.

**Simulation.** Events are faults (with an impedance), their clearing, trips, reclosures and load steps, at given times.
The plot shows the chosen quantity for every machine; click legend entries to hide traces. The run says whether every
machine stays in synchronism.

**Comparing with an earlier run.** Each calculation you start is recorded in the project's run log with hashes of the
model, the settings and the results. The load-flow table can show the difference from a recorded run ("Compare with a
recorded run…") and filter to what changed.

## Importing networks

File, Import (Ctrl+Shift+O), or drop the files on the window:

- **CGMES** 2.4.15 or 3.0: select the EQ, TP, SSH and SV files and the boundary set together, as XML files or ZIP
  archives.
- **PSS/E RAW** version 32, 33 or 35, bus-branch or node-breaker; select a DYR file with it to bring the machines'
  dynamic models.
- **MATPOWER** version 2 case files.
- **PowerStudio** files and projects, including encrypted ones (you are asked for the passphrase).

Before the network opens, a dialog shows what was read, what the diagram simplifies (a three-winding transformer
becomes a star busbar with three transformers, closed switches join their busbars) and how closely the result matches
the source's solution. The diagram is laid out automatically. A project imported from CGMES can export its operating
point back as SSH and SV into the same files (File, Export).

## Saving, exporting and printing

From the File page's Export section:

| Export | What you get |
| --- | --- |
| Study report | The study case's results, settings and run records, laid out for print or saving as PDF |
| Project | Every study case, scenario and variant with the run log, in one file |
| Encrypted project | The same file locked with a passphrase (AES-256-GCM, key by Argon2id); only PowerStudio with the passphrase opens it, and a lost passphrase cannot be recovered |
| PowerStudio file | The network as the active study case composes it, with its settings |
| CGMES SSH and SV | The operating point, for a project imported from CGMES |
| Diagram as SVG or PNG | The whole diagram |
| Results table as CSV | The table shown in the results panel |

## Keyboard

Press ? (or open Help, Keyboard shortcuts) for the full list. The ones used most:

| Keys | Command |
| --- | --- |
| Ctrl+K | Command palette |
| Alt+L, Alt+S, Alt+N, Alt+R | Load flow, short circuit, contingency, simulation |
| Ctrl+, | Study case |
| Ctrl+Z, Ctrl+Shift+Z | Undo, redo |
| Ctrl+O, Ctrl+Shift+O, Ctrl+Shift+S | Open, import, export |
| F | Fit the diagram |
| Shift+T | Switch light and dark |

On a Mac, ⌘ stands for Ctrl. Tab moves through the panels; in the results tabs, the arrow keys move between tabs.

## Your data and security

Networks, projects and results stay in this browser's storage on this device, and the page cannot send them anywhere.
They are as safe as the device and your account on it; use the encrypted export to move a model between machines.
docs/SECURITY.md describes the protections and their limits.

## Checking PowerStudio against your own tool

docs/BENCHMARK-KIT.md is the procedure for comparing PowerStudio with your tool on your own model, with the `ps compare`
command and a report of every difference.
