# Get started with PowerStudio

This guide takes you through a first session with PowerStudio, from opening a network to running every kind of
study on it. It takes about 30 minutes. You do not need to read the [user guide](USER-GUIDE.md) first: each step links
to the part of it that explains more.

You will work on the IEEE 14-bus sample, a 132/33/11 kV transmission network that comes with the app. You will:

1. [Open the sample](#1-open-the-sample)
2. [Run a load flow](#2-run-a-load-flow)
3. [Change element data](#3-change-element-data)
4. [Set up winter and summer study cases](#4-set-up-winter-and-summer-study-cases)
5. [Calculate short-circuit currents](#5-calculate-short-circuit-currents)
6. [Check the network for single outages](#6-check-the-network-for-single-outages)
7. [Simulate a fault and its clearing](#7-simulate-a-fault-and-its-clearing)
8. [Export and compare results](#8-export-and-compare-results)

At the end there is a list of [common studies](#common-studies) and where to start each one.

## Before you start

Open the app at https://swiftugandan.github.io/powerstudio/app/, or open `PowerStudio.html` from the
[latest release](https://github.com/swiftugandan/powerstudio/releases/latest) to work offline. Use a recent desktop
browser: PowerStudio is tested in Chromium, Firefox and WebKit, the engines behind Chrome, Edge, Firefox and Safari.

The guide gives keyboard shortcuts for Windows and Linux. On a Mac, use ⌘ for Ctrl and ⌥ for Alt.

You do not need an account. Your networks and results stay on your device and PowerStudio saves your work as you go.

## 1. Open the sample

The first time you open PowerStudio, it opens the IEEE 14-bus sample for you. If you have used it before, or you want
to start again, go to the **Help** tab and select **IEEE 14-bus system**. This opens a fresh copy of the sample, so you
cannot break anything.

The screen has 5 parts:

- the title bar, with the network's name, the study case you are working in and a search box
- the ribbon, with the commands in tabs: **File**, **Home**, **Insert**, **Calculate**, **Arrange**, **View** and
  **Help**
- the model tree on the left, the diagram in the centre and the inspector on the right
- the results panel below the diagram
- the status bar at the bottom

To find any command or element by name, press Ctrl+K and start typing.

Read more in [Starting](USER-GUIDE.md#starting) and [Working on the diagram](USER-GUIDE.md#working-on-the-diagram).

## 2. Run a load flow

On the **Home** tab, select **Load flow**, or press Alt+L.

PowerStudio shows the results in 2 places:

- on the diagram, where busbars and branches are coloured by voltage and loading, and result boxes show the values
- in the results panel's **Load flow** tab, which says **Converged in 2 iterations** and gives the total generation,
  load and losses: the sample has 259.00 MW of load

The **Load flow** tab has a table for **Busbars**, **Branches**, and **Machines and loads**. Select a column heading to
sort by it. To show only the rows that need attention, select **Near limits** or **Outside band** for busbars, or
**Above 90 %** or **Above 100 %** for branches. Select a row to find the element on the diagram.

Read more in [Calculating](USER-GUIDE.md#calculating).

## 3. Change element data

1. On the diagram, select **Load 3**, the load on **Bus 3**. You can also press Ctrl+K and type `Load 3`.
2. The inspector shows the load's data. Change **Active power** from 94.2 to 120 MW and press Enter.
3. The load flow runs again by itself, because **Recalculate on edit** is on. The total load is now 284.80 MW.
4. Select an empty part of the diagram and press Ctrl+Z to undo the change. The total load goes back to 259.00 MW.

If you switch off **Recalculate on edit** (on the **Calculate** tab, under **Steady state**), results that no longer
match the network are marked **Calculated before the last edit** until you run the calculation again.

Every field shows its unit. Hover over a field's name to see what it means. If you type a value that is out of range,
PowerStudio refuses it, tells you why and keeps the old value.

To change many elements at once, open the **Data** tab in the results panel. It shows every element of one kind as a
table. You can change several cells together, or paste a block of cells from a spreadsheet.

Read more in [Element data](USER-GUIDE.md#element-data).

## 4. Set up winter and summer study cases

A study case is one set of conditions to study the network under. It has:

- the settings of every calculation
- a scenario: the operating values, such as loads, generation, set points and which elements are in service
- any variants: planned changes to the equipment, such as a new line

Here you will keep the sample's values as a winter peak and add a summer minimum, with less load and one generator
switched off.

1. Select the study case in the title bar (it says **Base case**), then select **Manage project…**.
2. Under **Study cases**, rename **Base case** to `Winter peak`.
3. Under **Scenarios**, select **New scenario** and rename it `Summer minimum`.
4. Under **Study cases**, select **New study case**. It starts as a copy of **Winter peak**. Rename it
   `Summer minimum` and choose **Summer minimum** as its **Scenario**.
5. Select the round button beside **Summer minimum** to make it the active study case, then select **Back to
   diagram**. The title bar now says **Summer minimum**.
6. Press Ctrl+, to open the study case settings. Under **Load flow**, set **Load scaling** to 60 % and select
   **Apply**.
7. Select **Generator 2**, on **Bus 2**, and press Shift+O to switch it out of service. It is greyed out on the
   diagram.
8. Run the load flow (Alt+L). The total load is now 155.40 MW.

With less load, the voltages on the 33 kV network rise: several busbars are now above their upper limit and show red
on the diagram. Select **Outside band** in the **Busbars** table to list them.

The load scaling is kept in the summer study case, and the generator's state in the summer scenario. **Winter peak**
still has all its load and every generator. To switch between the 2, select the study case in the title bar and
choose the one you want.

Read more in [The study case](USER-GUIDE.md#the-study-case).

## 5. Calculate short-circuit currents

1. Switch back to the **Winter peak** study case.
2. Go to the **Calculate** tab. Under **Faults**, select **Three-phase** and **Maximum currents**.
3. Select **Short circuit**, or press Alt+S.

PowerStudio applies a fault at every busbar in turn. The **Short circuit** tab lists the initial short-circuit
current Ik″, the peak current ip, the breaking current Ib, the thermal current Ith and the short-circuit power Sk″ at
each busbar.

To see where the current at one busbar comes from, right-click **Bus 4** on the diagram and select **Short circuit at
this busbar**. Then select **Contributions** in the **Short circuit** tab to see the current from every branch and
machine. To go back to a fault at every busbar, select **Every busbar** under **Faults**.

The calculation follows the method of IEC 60909-0. It is not certified against the standard.

Read more in [Calculating](USER-GUIDE.md#calculating) and, for the method, [ENGINE.md](ENGINE.md).

## 6. Check the network for single outages

On the **Calculate** tab, select **Contingency**, or press Alt+N.

PowerStudio takes each line and transformer out of service in turn and runs a load flow for each outage. The
**Contingency** tab lists every outage, whether its load flow solved, and the overloads and voltages outside their
limits that it causes. On the sample, 10 outages cause new violations. The diagram shows the worst result for each
element.

To include generator outages, select **Generator outages** under **Security** before you run it. To study several
elements out at once, or to add remedial actions, select **Contingencies**.

Read more in [Calculating](USER-GUIDE.md#calculating).

## 7. Simulate a fault and its clearing

The sample already has a disturbance set up: a three-phase fault on **Bus 4** at 0.1 seconds, cleared at 0.18 seconds
by switching out **Line 4-5**. To see it, select **Events** under **Dynamics** on the **Calculate** tab.

1. On the **Calculate** tab, select **Simulation**, or press Alt+R.
2. The **Stability** tab in the results panel shows each machine's rotor angle over time. It says **All machines
   stay in synchronism**.
3. To plot something else, choose it from the list at the top right of the tab, such as **Speed** or **Active
   power**. Select a machine in the legend to hide or show it.

To see how much margin there is, open **Events**, make the fault last longer by changing the time of the **Clear fault
at** and **Switch out** events, and run the simulation again.

Read more in [Calculating](USER-GUIDE.md#calculating).

## 8. Export and compare results

**Export a table.** Every table in the results panel can be saved as a CSV file to open in a spreadsheet. Show the
table you want, then select **Export table as CSV**: the button at the top right of the results panel, or the command
on the **Calculate** tab.

**Compare 2 runs.** PowerStudio records every calculation you run in the project's run log. To compare the summer
load flow with the winter one:

1. Switch to the **Winter peak** study case and run the load flow (Alt+L).
2. Switch to the **Summer minimum** study case and run the load flow again.
3. In the **Load flow** tab, open **Compare with a recorded run…** and choose the latest run marked **Winter peak**.
4. The table now shows the difference from that run beside each value, such as **ΔLoading** for branches. Select
   **Changed** to show only the rows that differ.

The run log only records the calculations you start yourself, not the ones **Recalculate on edit** runs.

**Keep a copy.** PowerStudio saves your work in this browser. To keep a copy somewhere else, or to move it to another
computer, go to **File**, then **Export**, and choose **Project**. **Study report** gives you a report to print or
save as a PDF.

Read more in [Calculating](USER-GUIDE.md#calculating) and
[Saving, exporting and printing](USER-GUIDE.md#saving-exporting-and-printing).

## Common studies

| If you want to | Start here | Read more |
| --- | --- | --- |
| Check voltages and loadings at one operating point | **Load flow** (Alt+L) | [Calculating](USER-GUIDE.md#calculating) |
| Check the fault level against switchgear ratings | **Short circuit** with **Maximum currents** | [Calculating](USER-GUIDE.md#calculating) |
| Find the lowest fault currents, for protection | **Short circuit** with **Minimum currents** | [Calculating](USER-GUIDE.md#calculating) |
| Check the network survives the loss of any one circuit | **Contingency** (Alt+N) | [Calculating](USER-GUIDE.md#calculating) |
| Check machines stay in step after a fault | **Events**, then **Simulation** (Alt+R) | [Calculating](USER-GUIDE.md#calculating) |
| Compare seasons or operating conditions | A scenario and a study case for each | [The study case](USER-GUIDE.md#the-study-case) |
| Study a planned reinforcement, such as a new line | A variant, switched on in a study case | [The study case](USER-GUIDE.md#the-study-case) |
| Change the data of many elements | The **Data** tab in the results panel | [Element data](USER-GUIDE.md#element-data) |
| Draw your own network | The **Insert** tab | [Drawing a network](USER-GUIDE.md#drawing-a-network) |
| Use a model from another tool (CGMES, PSS/E, MATPOWER) | **File**, then **Import** | [Importing networks](USER-GUIDE.md#importing-networks) |
| Share results | **File**, then **Export** | [Saving, exporting and printing](USER-GUIDE.md#saving-exporting-and-printing) |
| Compare PowerStudio's results with your own tool's | The `ps compare` command | [BENCHMARK-KIT.md](BENCHMARK-KIT.md) |

## What to read next

- The [user guide](USER-GUIDE.md) explains every part of the app.
- [ENGINE.md](ENGINE.md) explains what each calculation computes and how it is checked.
- The [README](../README.md#scope-and-boundaries) lists what PowerStudio does not do.
- Press ? in the app to see every keyboard shortcut.
