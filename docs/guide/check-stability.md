# Check machines stay in step

**What it tells you.** A stability simulation applies a disturbance, such as a fault, and follows your machines for a few seconds. It shows whether they stay in [synchronism](reference.md#synchronism) or whether one swings away from the rest. Use it to check that a fault cleared in a given time does not cost you a generator.

This study follows swings over seconds, using RMS values. To see waveforms in the first cycles, use [the EMT study](look-at-emt.md) instead.

## Before you start

You do not need to run a load flow first. The simulation solves its own starting point, so the load flow data must be complete. Check the data below. Select an element to see its data in the inspector.

| Data | Where to enter it |
| --- | --- |
| Machine **Rotor model**, **Inertia constant**, **Damping** and **Transient reactance xd′** | Inspector, **Stability** |
| Machine **Subtransient reactance xd″** and **Stator resistance**, for the **Round rotor** model | Inspector, **Short circuit** |
| Machine **Exciter**, **Governor** and **Stabiliser**, if you model them | Inspector, **Stability** |
| External grid **Short-circuit power max**, which sets how strong the grid is | Inspector, **Short circuit** |
| The events: faults, switching and load steps, with their times | **Events** dialog, described below |
| **Simulation time** and **Step size** | **Study case**, under **Stability simulation** |

The **Classical** rotor model needs only the inertia, damping and transient reactance. The **Round rotor** model adds the circuits of a real rotor. An exciter holds a machine's voltage. A governor holds its speed or power. A stabiliser damps swings through the exciter.

## Set up the study

Each event has a time, a type and an element.

1. Select the **Calculate** tab.
2. Under **Dynamics**, select **Events**. The **Study case** dialog opens at **Simulation events**.
3. Select **Add event**.
4. In **Time (s)**, enter when the event happens.
5. In **Event**, choose **Three-phase fault at**, **Clear fault at**, **Switch out**, **Switch in** or **Set load to (% of initial)**.
6. In **Element**, choose the busbar, branch, machine or load.
7. For a fault, enter the fault resistance in **R Ω** and reactance in **X Ω**. Leave them empty for a bolted fault. For a load step, enter the new level in **Value**.
8. Repeat steps 3 to 7 for each event.
9. Select **Apply**.

A bolted fault has no impedance in the fault itself. Give every fault a **Clear fault at** event, or it lasts to the end.

To add a fault quickly, right-click a busbar and select **Add fault to simulation**. This adds a fault at 0.1 s and its clearing at 0.2 s. Edit the times in **Events**.

To change the other settings, press Ctrl+, to open **Study case**, then scroll to **Stability simulation**.

| Setting | What it does |
| --- | --- |
| **Simulation time** | Sets how long to simulate. The default is 3 s. |
| **Step size** | Sets the integration step. The default is 0.005 s. Shorten it to resolve fast controls. |
| **Load P held as constant power** and **Load P held as constant current** | Set how each load's active power follows the voltage. The remainder is constant impedance. Both default to 0 %. |
| **Load Q held as constant power** and **Load Q held as constant current** | Set the same for reactive power. Both default to 0 %. |
| **Constant power and current below** | Turns those shares into constant impedance below this voltage. The default is 0.7 p.u. |

The method is described in [the engine description](../ENGINE.md#stability-rms-simulation).

## Run it

1. On the **Calculate** tab, select **Simulation**, or press Alt+R.
2. Wait for the progress bar in the status bar to finish.

The **Stability** tab opens in the results panel. The **Output** tab logs the result in one line. It also lists any event that was skipped.

To stop a run that takes too long, press Ctrl+.

## Read the results

The top of the **Stability** tab shows a pill and a summary.

- The pill says **All machines stay in synchronism**, or when synchronism was lost, such as **Loss of synchronism at 0.515 s**.
- **Angles against** says what the rotor angles are measured from. It is the external grid when the network has one. Otherwise it is the centre of inertia, the average angle of all machines weighted by their inertia.
- **Steps** is the number of time steps. **Time** is how long the calculation took.

The plot shows one quantity for every machine. Choose the quantity from the list at the top right. The list holds **Rotor angle**, **Speed**, **Active power**, **Reactive power**, **Field voltage**, **Mechanical power** and **Busbar voltage**.

The panel beside the plot has a checkbox for each trace, so you can hide or show it. It also lists the events with their times.

Drag the time cursor along the plot. The diagram shows each busbar's voltage and each machine's rotor angle and power at that time. Busbars below 0.8 p.u. are coloured.

To save the plotted traces, select **Export table as CSV**.

The [rotor angle](reference.md#rotor-angle) is how far a machine's rotor is ahead of the reference. A stable machine swings and then settles. An unstable one keeps moving away. PowerStudio reports a loss of synchronism when a machine is more than 180° from another.

## Check your results

- **Flat before the event.** Every trace should stay still until the first event. If not, the starting point is not in balance.
- **Starting power.** At time 0, each machine's **Active power** equals its **P** in the load flow. On the IEEE 14-bus sample, **Generator 1** starts at 232.39 MW.
- **Fault voltage.** A bolted fault takes the voltage at its busbar to 0.000 p.u. The voltage recovers after the fault clears.
- **Speed.** Speeds swing around 50 Hz, or your system frequency. A speed that keeps rising points to a machine that is running away.
- **Time simulated.** The pill judges only the time you simulated. If machines are still swinging at the end, raise **Simulation time** to look at later swings.
- **Shorter fault.** Halve the fault duration, and move any **Switch out** event with it. The swings in rotor angle should get smaller. On the IEEE 14-bus sample, **Generator 2** then swings by 4.2° instead of 8.0°.

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| A red pill, **Loss of synchronism at** a time | A machine moved more than 180° from another | This is a result, not an error. Clear the fault sooner, or check the inertia and the exciter. |
| **Event at** a time **skipped** in the **Output** tab | The event did nothing, for example a clearing with no fault | Check the event's element and time in **Events**. |
| **Stability simulation cannot run**, and a message about constant power and constant current shares | The shares for a load add up to more than 100 % | Lower them under **Stability simulation** in **Study case**. |
| **Stability simulation cannot run**, and a message about round-rotor data | A machine's **Round rotor** data is not consistent | Correct its data, or set its **Rotor model** to **Classical**. |
| All traces are flat | The study case has no events | Add events in **Events**. |
| Traces look jagged | The **Step size** is too long for the fast controls | Shorten the **Step size**. |
| The pill **Calculated before the last edit** | You changed the network after the run | Run **Simulation** again. |

## Try it on the IEEE 14-bus sample

1. Select the **Help** tab.
2. Under **Samples**, select **IEEE 14-bus system**.
3. On the **Calculate** tab, select **Events**. The sample has 3 events.
4. Read them. **Three-phase fault at Bus 4** is at 0.1 s. **Clear fault at Bus 4** and **Switch out Line 4-5** are both at 0.18 s.
5. Select **Cancel**, then select **Simulation**.
6. In the **Stability** tab, read the pill. It says **All machines stay in synchronism**. The summary says the angles are against the centre of inertia, with 600 steps.
7. Choose **Rotor angle**. **Generator 1** stays between 2.6° and 4.2°. **Condenser 8** swings furthest, to −23.5°.
8. Choose **Busbar voltage**. **Bus 4** falls to 0.000 p.u. at 0.1 s. It is 1.006 p.u. at 3 s.
9. Choose **Speed**. The speeds stay between 49.84 Hz and 50.20 Hz.

The speeds are still swinging at 3 s. The pill judges only the 3 s that you simulated. Raise **Simulation time** under **Stability simulation** to look further.

## Find the margin on the Riverside sample

The Riverside sample has a single generator, the CHP unit, against a strong grid. It shows how a longer fault ends in a loss of synchronism.

1. Select the **Help** tab, then select **Riverside distribution** under **Samples**.
2. Select **Events**. The sample has a **Three-phase fault at Hilltop** at 0.1 s and **Clear fault at Hilltop** at 0.25 s.
3. Select **Cancel**, then select **Simulation**.
4. The pill says **All machines stay in synchronism**. In **Rotor angle**, **Hilltop CHP** swings between −23.0° and 48.3°, measured against the grid.
5. Select **Events**, set the time of **Clear fault at Hilltop** to 0.45 s, then select **Apply**.
6. Select **Simulation**. The pill now says **Loss of synchronism at 0.515 s**.

A clearing time of 0.35 s still holds. The margin lies between 0.35 s and 0.45 s. Use that range to judge how fast the protection must be.

## Read more

- [Look at the first cycles of a fault or switching](look-at-emt.md)
- [Check the network survives outages](check-outages.md)
- [Work with results](work-with-results.md)
