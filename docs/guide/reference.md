# Reference

This page lists the keyboard shortcuts and explains the terms the guide uses. Other chapters link here the first time they use a term.

## Use keyboard shortcuts

Press ? in the app, or select the **Help** tab and then **Keyboard shortcuts**, to see the full list for your version. These are the shortcuts you will use most.

On a Mac, use ⌘ for Ctrl and ⌥ for Alt.

| Keys | What it does |
| --- | --- |
| Ctrl+K | Opens the command palette, which finds every command and element by name |
| Alt+L or Ctrl+Enter | Runs a load flow |
| Alt+S | Runs a short circuit |
| Alt+N | Runs a contingency analysis |
| Alt+R | Runs a stability simulation |
| Alt+W | Runs an EMT simulation |
| Ctrl+. | Cancels a running calculation |
| Ctrl+, | Opens the study case settings |
| Ctrl+Z | Undoes the last change |
| Ctrl+Shift+Z | Redoes a change you undid |
| Ctrl+S | Saves now (the app also saves as you work) |
| Ctrl+O | Opens a saved network |
| Ctrl+Shift+O | Imports a file |
| Ctrl+Shift+S | Exports a PowerStudio file |
| Ctrl+J | Shows or hides the results panel |
| Ctrl+Shift+M | Shows or hides the model panel |
| Ctrl+Shift+I | Shows or hides the inspector |
| F | Fits the whole diagram in the window |
| Shift+F | Zooms to the selection |
| M | Shows or hides the overview map |
| Shift+R | Shows or hides result boxes |
| Shift+N | Shows or hides names |
| Shift+L | Switches **Disentangle labels** on or off |
| Shift+T | Switches between light and dark |
| Shift+O | Switches the selected elements in or out of service |
| R | Rotates the selected busbars |
| X | Moves the selected elements to the other side of their busbar |
| V, H | Select tool, pan tool |
| B, L, T, G, E, D, C | Busbar, line, transformer, machine, external grid, load and shunt tools |
| Alt (while dragging) | Places an element freely, without snapping |
| ? | Shows the keyboard shortcuts |

In the results panel, Tab moves through the panels and the arrow keys move between tabs.

## Look up a term

Terms are in alphabetical order. For how the engine calculates each one, see [the engine description](../ENGINE.md).

### Bolted fault

A fault with no impedance in the fault itself. It gives the largest fault current at a busbar. A fault resistance or reactance, such as an arc, lowers the current.

### Breaking current (Ib)

The current the circuit breaker has to interrupt when its contacts part. It is smaller than Ik″ because the current from machines decays.

PowerStudio shows Ib for maximum three-phase currents, the case IEC 60909 defines it for. It depends on the **Minimum time delay** setting.

### Busbar

A node in the diagram where lines, transformers, machines and loads connect. Other tools call it a bus or a node.

### Contingency

A planned outage you test the network against, such as the loss of one line. A contingency can take out one element or several together. See [Check the network survives outages](check-outages.md).

### Crest

The highest instantaneous value of a sinusoidal waveform. For a phase-to-earth voltage, the crest is the RMS value times the square root of 2.

The EMT results show peak voltages as a share of the nominal crest. A value of 1.00 p.u. of crest means the peak equals the normal peak.

### Current zero

The instant an alternating current crosses zero. A breaker interrupts a current at a current zero, as the arc goes out. The EMT simulation opens each pole at its next current zero.

### DC offset

A part of a fault current that does not alternate and dies away over a few cycles. It depends on where in the voltage cycle the fault starts. It raises the first peak of the current. See [point on the wave](#point-on-the-wave).

### Dommel's method

The numerical method the EMT simulation uses. It turns each element into a small model that depends on the previous time step, then solves the whole network at every step. H. W. Dommel published it in 1969. See [the engine description](../ENGINE.md#electromagnetic-transients-emt).

### Earth fault

A fault between one or more phases and earth. See [Find fault levels](find-fault-levels.md). Earth faults need [zero-sequence data](#zero-sequence-data).

### Electromagnetic transient (EMT) simulation

A study of voltages and currents as waveforms, sample by sample, over a few cycles. It shows effects that the other studies cannot, such as the DC offset of a fault current.

The EMT simulation is not a grid code compliance tool. See [Look at the first cycles of a fault or switching](look-at-emt.md).

### Initial short-circuit current (Ik″)

The RMS current in the first instant after a fault, before it starts to decay. Switchgear ratings are usually compared with this value. It is shown as **Ik″** in the results, in kA.

### Load flow

A calculation of the steady state of the network: the voltage at every busbar and the power flowing in every line and transformer. See [Run a load flow](run-a-load-flow.md).

### Loading

How much of its rating a line or transformer carries, as a percentage. For a line it is current against its **Rated current**. For a transformer it is apparent power against its **Rated power**.

### N-1

A security standard: the network must stay within its limits after the loss of any one element. The contingency analysis checks it.

### Peak short-circuit current (ip)

The highest instantaneous current of the first cycle of a fault, in kA. Equipment must withstand the mechanical force this current causes. It is shown as **ip** in the results.

### Per unit

A way of writing a quantity as a fraction of a base value. A voltage of 1.00 p.u. is the nominal voltage. The base power is set under **Base power** in the network's data.

### Point on the wave

Where in the voltage cycle an event happens, such as a fault starting or a breaker closing. It decides the size of the DC offset and of the switching transient.

### Remedial action

An action the analysis applies after an outage, such as switching an element or shedding load, before it judges the result.

### RMS value

The root mean square of a waveform: the steady value that gives the same heating. For a sinusoid it is the crest divided by the square root of 2.

The stability simulation is also called an RMS simulation, because it follows these steady values rather than the waveforms.

### Rotor angle

The angle of a machine's rotor against a reference, in degrees. If it grows without limit, the machine has lost synchronism.

### Scenario

A named set of operating values: switching states, set points, loads, generation and tap positions. A study case uses one scenario. See [Set up study cases, scenarios and variants](set-up-study-cases.md).

### Screening

A quick first check of each outage in the contingency analysis. An outage that is clearly within its limits is cleared without a full load flow. Every other outage gets one. See [Check the network survives outages](check-outages.md).

### Short-circuit power (Sk″)

A measure of the fault level, in MVA: the initial short-circuit current times the nominal voltage and the square root of 3. It is shown as **Sk″** in the results.

### Study case

One saved set of conditions to study the network under. It holds the settings of every calculation, a scenario and any variants. See [Set up study cases, scenarios and variants](set-up-study-cases.md).

### Synchronism

The state in which every machine in the network runs at the same average speed. Their rotor angles then stay within a limited range of each other. PowerStudio reports a loss of synchronism when a machine is more than 180° from another. See [Check machines stay in step](check-stability.md).

### Thermal equivalent current (Ith)

The steady current that would heat the equipment as much as the real fault current does over the fault's duration. It is shown as **Ith**, and depends on the **Short-circuit duration** setting.

### Travelling wave

A wave of voltage and current that takes time to cross a line and reflects at its ends. The EMT simulation models a line this way when the crossing time is at least 1 time step. It models shorter lines as π sections.

### Variant

A planned change to the network, recorded as a sequence of edits, such as a new line. You switch a variant on in a study case.

### Vector group

The code that describes how a transformer's windings are connected and the phase shift between its two sides. The number is the shift in steps of 30°.

For example, **Dyn11** is a delta winding on the high-voltage side and a star winding with an earthed neutral on the low-voltage side.

The vector group decides whether a transformer passes zero-sequence current, which matters for earth faults.

### Voltage band

The lowest and highest voltage a busbar may have, in per unit. You set them in the busbar's **Lower voltage limit** and **Upper voltage limit**.

### Voltage factor (c)

A factor that the short-circuit calculation applies to the nominal voltage at the fault. Above 1 kV it is 1.10 for maximum currents and 1.00 for minimum currents. Below 1 kV it depends on the **LV voltage tolerance** setting. It is shown as **c** in the results.

### Zero-sequence data

Data that describe how current flows through earth in an unbalanced fault. For lines, it is **Zero-sequence R0′**, **Zero-sequence X0′** and **Zero-sequence B0′**. For transformers, it is **Zero-sequence uk0**, **Zero-sequence uR0**, the **Vector group** and the neutral earthing. For external grids, it is the **X0/X1 ratio** and **R0/X0 ratio**. Machines are unearthed.
