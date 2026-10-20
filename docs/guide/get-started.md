# Get started

This chapter takes you through a first session with PowerStudio, from opening a network to running every kind of study on it. It takes about 30 minutes. You do not need to read the other chapters first. Each step points to the chapter that explains more.

You will work on the IEEE 14-bus sample, a 132/33/11 kV transmission network that comes with the app. A busbar is a point where lines, transformers, machines and loads connect. The sample has 14 of them. A branch is a line or a transformer.

You will:

1. [Open the sample](#open-the-sample)
2. [Run a load flow](#run-a-load-flow)
3. [Change element data](#change-element-data)
4. [Set up winter and summer study cases](#set-up-winter-and-summer-study-cases)
5. [Calculate short-circuit currents](#calculate-short-circuit-currents)
6. [Check the network for single outages](#check-the-network-for-single-outages)
7. [Simulate a fault and its clearing](#simulate-a-fault-and-its-clearing)
8. [Look at the first cycles of the fault](#look-at-the-first-cycles-of-the-fault)
9. [Export and compare results](#export-and-compare-results)

At the end, a table shows [where to start each study](#find-where-to-start-each-study).

## Before you start

Open the app at https://swiftugandan.github.io/powerstudio/app/. To work offline, open `PowerStudio.html` from the [latest release](https://github.com/swiftugandan/powerstudio/releases/latest). Use a recent desktop browser. PowerStudio is tested in Chromium, Firefox and WebKit, the engines behind Chrome, Edge, Firefox and Safari.

The guide gives keyboard shortcuts for Windows and Linux. On a Mac, use ⌘ for Ctrl and ⌥ for Alt.

You do not need an account. Your networks and results stay on your device, and PowerStudio saves your work as you go.

## Open the sample

The first time you open PowerStudio, it opens the IEEE 14-bus sample for you. If you have used it before, or you want to start again, open a fresh copy:

1. Go to the **Help** tab.
2. Select **IEEE 14-bus system**.

A fresh copy means you cannot break anything. The **Help** tab also has **Getting started**, which opens this chapter, and **Guide**, which opens the contents page. The second sample, **Riverside distribution**, is a 110/20/0.4 kV network with a cable ring and a combined heat and power (CHP) unit.

The screen has 5 parts:

- the title bar, with the network's name, the study case you are working in and a search box
- the ribbon, with the commands in tabs: **File**, **Home**, **Insert**, **Calculate**, **Arrange**, **View** and **Help**
- the model tree on the left, the diagram in the centre and the inspector on the right
- the results panel below the diagram
- the status bar at the bottom

To find any command or element by name, press Ctrl+K and start typing.

Read more in [Build your network](build-your-network.md).

## Run a load flow

A load flow calculates the voltage at every busbar and the power through every branch, for one operating point.

1. Go to the **Home** tab.
2. Select **Load flow**, or press Alt+L.

PowerStudio shows the results in 2 places:

- on the diagram, where busbars and branches are coloured by voltage and loading, and result boxes show the values
- in the results panel's **Load flow** tab, which says **Converged in 2 iterations** and gives the total generation, load and losses

The sample has 259.00 MW of load, so the tab shows **Load 259.00 MW**.

The **Load flow** tab has 3 views: **Busbars**, **Branches** and **Machines and loads**. Select a column heading to sort by it. Select a row to find the element on the diagram.

To show only the rows that need attention:

- for busbars, select **Near limits** or **Outside band**
- for branches, select **Above 90 %** or **Above 100 %**

**Show a chart.** The **Busbars** and **Branches** views have a **Table** / **Chart** switch. Select **Chart** to see the same rows as bars. The busbar chart shows each voltage around 1 [per unit](reference.md#per-unit), with the allowed band shaded. The branch chart ranks the loadings against 90 % and 100 %. Select a bar to select its element. Select **Table** to go back. The **Short circuit** and **Contingency** tabs have the same switch.

Read more in [Run a load flow](run-a-load-flow.md) and [Work with results](work-with-results.md).

## Change element data

1. On the diagram, select **Load 3**, the load on **Bus 3**. You can also press Ctrl+K and type `Load 3`.
2. In the inspector, change **Active power** from 94.2 to 120 MW.
3. Press Enter.

The load flow runs again by itself, because **Recalculate on edit** is on. The total load is now **Load 284.80 MW**.

To undo the change:

1. Select an empty part of the diagram.
2. Press Ctrl+Z.

The total load goes back to 259.00 MW.

If you switch off **Recalculate on edit**, PowerStudio marks results that no longer match the network as **Calculated before the last edit**. They stay marked until you run the calculation again. You find the switch on the **Calculate** tab, under **Steady state**.

Every field shows its unit. Hover over a field's name to see what it means. If you type a value that is out of range, PowerStudio refuses it, tells you why and keeps the old value.

To change many elements at once, open the **Data** tab in the results panel. It shows every element of one kind as a table. You can change several cells together, or paste a block of cells from a spreadsheet.

Read more in [Enter element data](enter-element-data.md).

## Set up winter and summer study cases

A study case is one set of conditions to study the network under. It has:

- the settings of every calculation
- a scenario: the operating values, such as loads, generation, set points and which elements are in service
- any variants: planned changes to the equipment, such as a new line

You will keep the sample's values as a winter peak. Then you will add a summer minimum, with less load and one generator switched off.

First, create the 2 study cases:

1. Select the study case in the title bar. It says **Base case**.
2. Select **Manage project…**.
3. Under **Study cases**, rename **Base case** to `Winter peak`.
4. Under **Scenarios**, select **New scenario**.
5. Rename the new scenario to `Summer minimum`.
6. Under **Study cases**, select **New study case**. It starts as a copy of **Winter peak**.
7. Rename the new study case to `Summer minimum`.
8. Choose **Summer minimum** as its **Scenario**.
9. Select the radio button beside **Summer minimum** to make it the active study case.
10. Select **Back to diagram**. The title bar now says **Summer minimum**.

Then change the summer conditions:

1. Press Ctrl+, to open the study case settings.
2. Under **Load flow**, set **Load scaling** to 60 %.
3. Select **Apply**.
4. Select **Generator 2**, on **Bus 2**.
5. Press Shift+O to switch it out of service. It is greyed out on the diagram.
6. Run the load flow (Alt+L). The total load is now **Load 155.40 MW**.

With less load, the voltages on the 33 kV network rise. Several busbars are now above their upper limit and show red on the diagram. Select **Outside band** in the **Busbars** view to list them.

PowerStudio keeps the load scaling in the summer study case, and the generator's state in the summer scenario. **Winter peak** still has all its load and every generator. To switch between the 2, select the study case in the title bar and choose the one you want.

Read more in [Set up study cases, scenarios and variants](set-up-study-cases.md).

## Calculate short-circuit currents

A short circuit study calculates the current that flows into a fault at each busbar. You use it to check switchgear ratings. The calculation is IEC 60909-style: it follows the method of IEC 60909-0 but is not certified against the standard.

1. Switch back to the **Winter peak** study case.
2. Go to the **Calculate** tab.
3. Under **Faults**, select **Three-phase**.
4. Under **Faults**, select **Maximum currents**.
5. Select **Short circuit**, or press Alt+S.

PowerStudio applies a fault at every busbar in turn. The **Short circuit** tab lists these currents at each busbar:

- the initial short-circuit current [Ik″](reference.md#initial-short-circuit-current-ik)
- the peak current [ip](reference.md#peak-short-circuit-current-ip)
- the breaking current Ib
- the thermal current Ith
- the short-circuit power Sk″

To see where the current at one busbar comes from:

1. Right-click **Bus 4** on the diagram.
2. Select **Short circuit at this busbar**.
3. In the **Short circuit** tab, select **Contributions**.

The table lists the current in every line and transformer, at each end. You can also select a busbar and run **Short circuit at selected busbar** from the command palette (Ctrl+K). **Contributions** appears only for a three-phase fault at 1 busbar.

To go back to a fault at every busbar, select **Every busbar** under **Faults**.

Read more in [Find fault levels](find-fault-levels.md). The method is in the [short circuit section of the engine reference](../ENGINE.md#short-circuit).

## Check the network for single outages

An [N-1](reference.md#n-1) analysis takes each line and transformer out of service in turn. It then checks the network still works.

On the **Calculate** tab, select **Contingency**, or press Alt+N.

PowerStudio runs a load flow for each outage. The **Contingency** tab lists every outage, whether its load flow solved, and the violations it causes. A violation is a branch loaded above its limit or a busbar voltage outside its band. The tab only counts violations that the base case does not already have.

On the sample, the tab says **10 contingencies with new violations**. The diagram shows the worst result for each element.

To include generator outages, select **Generator outages** under **Security** before you run it. To study several elements out at once, or to add remedial actions, select **Contingencies**.

Read more in [Check the network survives outages](check-outages.md).

## Simulate a fault and its clearing

A stability simulation shows whether the machines stay in step with each other after a disturbance. It follows the swings over a few seconds.

The sample already has a disturbance set up: a three-phase fault on **Bus 4** at 0.1 seconds. The fault clears at 0.18 seconds when **Line 4-5** is switched out. To see it:

1. On the **Calculate** tab, under **Dynamics**, select **Events**.
2. Read the 3 events: **Three-phase fault at**, **Clear fault at** and **Switch out**.
3. Select **Cancel** to close the dialog without changing anything.

Now run it:

1. On the **Calculate** tab, select **Simulation**, or press Alt+R.
2. In the results panel's **Stability** tab, read the result. It says **All machines stay in synchronism**.
3. To plot something else, choose it from the list at the top right of the tab, such as **Speed** or **Active power**.
4. Select a machine in the legend to hide or show it.

To see how much margin there is:

1. Open **Events** again.
2. Change the time of the **Clear fault at** and **Switch out** events so the fault lasts longer.
3. Run the simulation again.

Read more in [Check machines stay in step](check-stability.md).

## Look at the first cycles of the fault

The stability simulation follows swings over seconds. An electromagnetic transient (EMT) simulation shows the first cycles instead. A cycle is 1 period of the supply frequency: 20 ms at 50 Hz. The simulation gives the voltage and current of each phase, sample by sample.

The sample has an EMT disturbance too: a three-phase fault on **Bus 4** at 20 ms. It clears at 100 ms, when **Line 4-5** trips. To see it:

1. On the **Calculate** tab, under **Dynamics**, select **EMT events**.
2. Read the 3 events: **Fault at**, **Clear fault at** and **Trip**.
3. Select **Cancel** to close the dialog.

Now run it:

1. On the **Calculate** tab, select **EMT**, or press Alt+W.
2. Read the **EMT** tab in the results panel. It says **200 ms simulated**.
3. In the **Waveforms** view, select **Bus 4** on the diagram. The plot shows its 3 phase voltages.
4. Drag across the plot to zoom in on a time range. Double-click to show the whole run.

The voltage of **Bus 4** falls when the fault starts at 20 ms. Look at the other views for the numbers:

- **Busbars** gives each busbar's peak voltage as a share of its nominal [crest](reference.md#crest), and its **Lowest RMS** and **Highest RMS** voltage. The [RMS](reference.md#rms-value) value is the steady value with the same heating effect as the wave, taken over 1 cycle.
- **Faults** gives the peak fault current and the RMS current over the last cycle of the fault.

To try a fault at another busbar, right-click it and select **Add fault to EMT simulation**. This adds a line-to-earth fault that you can edit under **EMT events**.

**Warning:** EMT is not a grid code compliance tool. It holds every source's voltage at its load-flow value, so use it for the first few hundred milliseconds only. Use the stability simulation for anything longer.

Read more in [Look at the first cycles of a fault or switching](look-at-emt.md). The method is in the [EMT section of the engine reference](../ENGINE.md#electromagnetic-transients-emt).

## Export and compare results

**Export a table.** You can save every table in the results panel as a CSV file to open in a spreadsheet. Show the table you want, then select **Export table as CSV**. The button is at the top right of the results panel. The command is also on the **Calculate** tab.

**Compare 2 runs.** PowerStudio records every calculation you start in the project's run log. To compare the summer load flow with the winter one:

1. Switch to the **Winter peak** study case.
2. Run the load flow (Alt+L).
3. Switch to the **Summer minimum** study case.
4. Run the load flow again.
5. In the **Load flow** tab, open **Compare with a recorded run…**.
6. Choose the latest run marked **Winter peak**.

The table now shows the difference from that run beside each value, such as **ΔLoading** for branches. Select **Changed** to show only the rows that differ.

The run log records only the calculations you start yourself. It does not record the ones that **Recalculate on edit** runs.

**Keep a copy.** PowerStudio saves your work in this browser. To keep a copy somewhere else, or to move it to another computer:

1. Go to **File**, then **Export**.
2. Choose **Project**.

**Study report** gives you a report to print or save as a PDF. **Encrypted project** locks the copy with a passphrase.

Read more in [Work with results](work-with-results.md) and [Save, share and protect your work](save-share-protect.md).

## Find where to start each study

| If you want to | Start here | Read more |
| --- | --- | --- |
| Check voltages and loadings at one operating point | **Load flow** (Alt+L) | [Run a load flow](run-a-load-flow.md) |
| Check the fault level against switchgear ratings | **Short circuit** with **Maximum currents** | [Find fault levels](find-fault-levels.md) |
| Find the lowest fault currents, for protection | **Short circuit** with **Minimum currents** | [Find fault levels](find-fault-levels.md) |
| Check the network survives the loss of any 1 circuit | **Contingency** (Alt+N) | [Check the network survives outages](check-outages.md) |
| Check machines stay in step after a fault | **Events**, then **Simulation** (Alt+R) | [Check machines stay in step](check-stability.md) |
| Look at the first cycles of a fault or switching | **EMT events**, then **EMT** (Alt+W) | [Look at the first cycles of a fault or switching](look-at-emt.md) |
| Compare seasons or operating conditions | A scenario and a study case for each | [Set up study cases, scenarios and variants](set-up-study-cases.md) |
| Study a planned reinforcement, such as a new line | A variant, switched on in a study case | [Set up study cases, scenarios and variants](set-up-study-cases.md) |
| Change the data of many elements | The **Data** tab in the results panel | [Enter element data](enter-element-data.md) |
| Draw your own network | The **Insert** tab | [Build your network](build-your-network.md) |
| Use a model from another tool (CGMES, PSS/E, MATPOWER) | **File**, then **Import** | [Import a model from another tool](import-a-model.md) |
| Share results | **File**, then **Export** | [Save, share and protect your work](save-share-protect.md) |
| Compare PowerStudio's results with your own tool's | The `ps compare` command | [Check PowerStudio against your own tool](check-against-your-tool.md) |

## Read more

- [Reference](reference.md) lists the keyboard shortcuts and defines the terms in this guide. You can also press ? in the app.
- [The calculation engine](../ENGINE.md) explains what each calculation computes and how it is checked.
- The [README](../../README.md#scope-and-boundaries) lists what PowerStudio does not do.
