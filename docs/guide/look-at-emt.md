# Look at the first cycles of a fault or switching

**What it tells you.** An [electromagnetic transient (EMT) simulation](reference.md#electromagnetic-transient-emt-simulation) shows the voltage and current of each phase, sample by sample. It covers the first cycles after a fault or a switching operation. Use it to see the peak of a fault current, the voltage peaks a switching operation causes, and how an unbalanced fault looks.

**Warning.** EMT is not a grid code compliance tool. Every source keeps the voltage it had in the load flow, no rotor moves and no control acts. The results mean something only for the first cycles. Use the [stability simulation](check-stability.md) for swings over seconds.

## Before you start

Check that the network has the data below. Select an element to see its data in the inspector.

| Data | Where to enter it |
| --- | --- |
| Complete load flow data, because the simulation starts from the load flow | See [Run a load flow](run-a-load-flow.md) |
| Machine **Subtransient reactance xd″** and **Stator resistance** | Inspector, **Short circuit** |
| External grid **Short-circuit power max**, **R/X ratio max**, **X0/X1 ratio** and **R0/X0 ratio** | Inspector, **Short circuit** |
| Line **Length**, **Reactance X′** and **Susceptance B′**, which set how a line behaves in time | Inspector, **Basic data** |
| For unbalanced faults: line **Zero-sequence R0′**, **Zero-sequence X0′** and **Zero-sequence B0′** | Inspector, **Short circuit** |
| For unbalanced faults: transformer **Vector group**, **Zero-sequence uk0** and neutral earthing | Inspector, **Basic data** and **Short circuit** |
| The events: faults, clearings and switching, with their times | **EMT events** dialog, described below |
| **Simulation time**, **Time step** and **Line model** | **Study case**, under **EMT simulation** |

A line without zero-sequence data takes its positive-sequence values, and the report says so. Machines are unearthed. An external grid is unearthed when its **X0/X1 ratio** is 0. See [zero-sequence data](reference.md#zero-sequence-data).

## Set up the study

Each event has a time in milliseconds, a type and an element.

1. Select the **Calculate** tab.
2. Under **Dynamics**, select **EMT events**. The **Study case** dialog opens at **EMT events**.
3. Select **Add EMT event**.
4. In **Time (ms)**, enter when the event happens.
5. In **Event**, choose **Fault at**, **Clear fault at**, **Trip** or **Close**.
6. In **Element**, choose a busbar for a fault or a clearing. Choose a line, transformer, machine, external grid, load or shunt for a trip or a close.
7. For a fault, choose its type in **Fault**. The types are **Three-phase**, **Line to line**, **Two phases to earth** and **Line to earth**. Enter a fault resistance in **R Ω**, or leave it empty for a bolted fault.
8. Repeat steps 3 to 7 for each event.
9. Select **Apply**.

Events act at the nearest time step. The 4 event types behave as follows.

- **Fault at** connects the phases of the busbar through the resistance you gave.
- **Clear fault at** puts each faulted phase out at its next [current zero](reference.md#current-zero).
- **Trip** opens each pole of the element's breakers at its next current zero. A branch opens at both ends.
- **Close** closes all 3 poles at the time you give. That time sets the [point on the wave](reference.md#point-on-the-wave). You can close in a line, transformer, load or shunt that is out of service.

To add a fault quickly, right-click a busbar and select **Add fault to EMT simulation**. This adds a line-to-earth fault after 1 cycle and clears it 5 cycles later.

To change the other settings, press Ctrl+, to open **Study case**, then scroll to **EMT simulation**.

| Setting | What it does |
| --- | --- |
| **Simulation time** | Sets how long to simulate. The default is 0.2 s. |
| **Time step** | Sets the step in microseconds. The default is 50 µs. Shorten it for [travelling waves](reference.md#travelling-wave) on short lines and cables. |
| **Line model** | Chooses **Travelling waves where they fit the step**, which is the default, or **π sections everywhere**. |

The method is Dommel's method. See [the engine description](../ENGINE.md#electromagnetic-transients-emt).

## Run it

1. On the **Calculate** tab, select **EMT**, or press Alt+W.
2. Wait for the progress bar in the status bar to finish.

The **EMT** tab opens in the results panel. The **Output** tab logs the highest voltage and the peak fault current. It also warns about any event that had no effect.

To stop a run, press Ctrl+.

## Read the results

The top of the **EMT** tab shows a pill and a summary. The pill gives the time simulated, such as **200 ms simulated**. The summary gives the **Step**, the **Highest voltage** in p.u. of crest, the **Peak fault current** and the **Time**.

Use the buttons on the right of the tab to switch between 6 views.

| View | What it shows |
| --- | --- |
| **Waveforms** | The 3 phases of a voltage or current against time |
| **Busbars** | **Busbar**, **Un**, **Peak voltage**, **Peak** as a share of the nominal crest, **At**, **Lowest RMS** and **Highest RMS** |
| **Branches** | **Branch**, **Model**, **Peak current** and **At**. The model is **Travelling wave**, **π section** or **Transformer**. |
| **Sources** | **Source**, **Peak current** and **At** |
| **Faults** | **Busbar**, **Fault**, **From**, **Out**, **Peak current**, **At** and **RMS, last cycle** |
| **Switching** | **Time**, **Kind** and **What happened**, for each event and each pole that opened |

Times in the tables are in milliseconds. The **Sources** and **Faults** buttons appear only when the run has sources or faults.

### Read a waveform

1. In **Waveforms**, select a busbar or branch on the diagram. Its phases are plotted.
2. To plot something else, choose a quantity in **Quantity plotted**. The choices are **Busbar voltage**, **Branch current**, **Source current** and **Fault current**.
3. To hide a phase, select its **Phase** button.
4. To zoom in, drag across a time range, or select **Zoom in on time**.
5. To see the whole run again, double-click the plot, or select **Show the whole run**.

### Read the numbers

The [crest](reference.md#crest) is the nominal peak of the phase-to-earth voltage. A **Peak** of 1.0 p.u. is the normal peak. The [RMS value](reference.md#rms-value) is taken over 1 cycle, after the first cycle.

The **Busbars** table highlights a **Peak** above 1.2 p.u. in amber and above 1.5 p.u. in red. Its filters are **Peak above 1.2 p.u.** and **RMS below 0.9 p.u.**

A fault current is the sum of a steady part and a decaying [DC offset](reference.md#dc-offset). The **Peak current** includes the offset. **RMS, last cycle** is the RMS of the largest phase over the last full cycle before the fault went out.

## Check your results

- **Flat before the first event.** Voltages should stay at their load-flow values until the first event.
- **Fault RMS.** Compare **RMS, last cycle** with **Ik″** from [the short circuit study](find-fault-levels.md). They should be close but not equal. The short circuit study uses a voltage factor, and the EMT study starts from the load-flow voltages.
- **Fault peak.** The peak should lie between 1.4 and 2.8 times the RMS current. The ratio depends on the DC offset.
- **Halve the time step.** Run it again with half the **Time step**. If a result moves a lot, it is not converged.
- **Line model.** A line whose travel time is below the step is a π section. The **Branches** view shows which model each line has.
- **Core saturation.** The model has none, so do not trust a transformer's behaviour near its saturation.

**Warning.** Switching overvoltages can depend on the step. Check them with a shorter **Time step** before you quote a peak.

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| **Event, no effect** in **Switching**, or a warning in **Output** | An event did nothing, for example a clearing with no fault | Check the element and time of the event in **EMT events**. |
| A warning that a pole did not reach a current zero | A DC offset kept the current from crossing zero, so the pole stayed closed | Raise **Simulation time**, or move the event. |
| **Out** shows **to the end** | The fault has no **Clear fault at** event | Add a clearing event. |
| **EMT simulation cannot run**, and a message about a line | A line joins busbars with different nominal voltages | Replace the line with a transformer. |
| **EMT simulation failed**, and a message about a zigzag winding | The EMT model does not support zigzag windings | Change the transformer's **Vector group** for this study. |
| An event never happens | Its time is after the **Simulation time** | Move the event, or raise **Simulation time** in **Study case**. |
| The pill **Calculated before the last edit** | You changed the network after the run | Run **EMT** again. |

## Try it on the IEEE 14-bus sample

1. Select the **Help** tab.
2. Under **Samples**, select **IEEE 14-bus system**.
3. Select **EMT events**. The sample has 3 events.
4. Read them. A three-phase **Fault at Bus 4** is at 20 ms. **Clear fault at Bus 4** and **Trip Line 4-5** are both at 100 ms.
5. Select **Cancel**, then select **EMT**.
6. Read the summary. The **Highest voltage** is 1.74 p.u. at **Bus 9**. The **Peak fault current** is 12.80 kA.
7. In **Waveforms**, select **Bus 4** on the diagram. The 3 voltages fall to 0 at 20 ms.
8. Select **Faults**. The fault lasts from 20.00 ms to 108.45 ms. The **Peak current** is 12.802 kA at 27.55 ms. **RMS, last cycle** is 5.865 kA.
9. Select **Switching**. The 12 rows show the 3 events and 9 poles opening. Each phase of the fault and of **Line 4-5** opens at its own current zero, between 102.65 ms and 108.45 ms.
10. Select **Busbars**. **Bus 9** has the highest **Peak** at 1.742 p.u., at 105.05 ms. That is after clearing starts, not during the fault.

Check the numbers against the short circuit study. For a three-phase fault at **Bus 4**, **Ik″** is 6.157 kA and **ip** is 13.650 kA. The EMT values are about 5 % and 6 % lower.

### Try other fault types

Change the **Fault** of the first event to see the peak current at **Bus 4**.

| Fault | Peak current | RMS, last cycle |
| --- | --- | --- |
| **Three-phase** | 12.802 kA | 5.865 kA |
| **Line to line** | 11.290 kA | 5.124 kA |
| **Two phases to earth** | 12.048 kA | 5.709 kA |
| **Line to earth** | 3.640 kA | 2.481 kA |

The earth fault is small because the sample's machines are unearthed.

## Try it on the Riverside sample

1. Under **Samples**, select **Riverside distribution**.
2. Select **EMT events**. The sample has a **Line to earth** fault at **Hilltop** at 20 ms and its clearing at 80 ms. It trips the **Capacitor bank** at 120 ms and closes it at 160.1 ms.
3. Select **Cancel**, then select **EMT**.
4. Select **Busbars**, then select **Peak above 1.2 p.u.** The list has one row: **Mill Lane** at 1.236 p.u., at 160.40 ms. That is 0.3 ms after the capacitor bank closes.
5. Select **Faults**. The **Peak current** is 6.210 kA at 33.75 ms. **RMS, last cycle** is 4.222 kA.

The RMS value lies between the minimum and maximum **Ik″** of a line-to-earth fault at **Hilltop**: 3.823 kA and 4.450 kA.

Now check the step. Open **Study case** and set **Time step** to 25 µs, then run it again. The fault peak stays at 6.210 kA. The highest voltage rises to 1.38 p.u. at **Station Road**. At 10 µs it is 1.63 p.u.

The cables here are short, so a coarse step treats them as π sections. A shorter step models them as travelling waves, and the switching peak changes. This is why you should check a switching overvoltage against a shorter step.

## Read more

- [Check machines stay in step](check-stability.md)
- [Find fault levels](find-fault-levels.md)
- [Work with results](work-with-results.md)
- [The engine description of EMT](../ENGINE.md#electromagnetic-transients-emt)
