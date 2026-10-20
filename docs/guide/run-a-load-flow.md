# Run a load flow

**What it tells you.** A [load flow](reference.md#load-flow) finds the steady state of your network. It gives the voltage at every [busbar](reference.md#busbar) and the power in every line and transformer. Use it to check that voltages stay in their [band](reference.md#voltage-band), that nothing is overloaded and how much power the network loses.

## Before you start

Check that the network has the data below. Select an element to see its data in the inspector on the right. The inspector groups data under **Basic data**, **Load flow**, **Short circuit**, **Stability** and **Diagram**.

| Data | Where to enter it |
| --- | --- |
| Busbar **Nominal voltage** | Inspector, **Basic data** |
| Busbar **Lower voltage limit** and **Upper voltage limit**, in [per unit](reference.md#per-unit) | Inspector, **Load flow** |
| Line **Length**, **Resistance R′**, **Reactance X′**, **Susceptance B′** and **Rated current** | Inspector, **Basic data** |
| Transformer **Rated power**, **Rated voltage HV**, **Rated voltage LV**, **Short-circuit voltage** and **Copper losses (resistive part)** | Inspector, **Basic data** |
| Transformer **No-load current**, **Iron losses** and tap changer settings | Inspector, **Load flow** |
| Machine **Control mode**, **Active power**, **Voltage setpoint**, **Reactive power minimum** and **Reactive power maximum** | Inspector, **Load flow** |
| External grid **Voltage setpoint** and **Voltage angle** | Inspector, **Load flow** |
| Load **Active power** and **Reactive power** | Inspector, **Load flow** |
| Shunt **Reactive power per section** and **Sections in service** | Inspector, **Load flow** |

Each connected part of the network needs a source. That is an external grid, or a machine whose **Control mode** is **Reference**.

A machine's **Control mode** sets what it holds. **PV** holds active power and voltage. **PQ** holds active and reactive power. **Reference** sets the angle and balances the system.

## Set up the study

1. Select the **Calculate** tab.
2. Under **Steady state**, switch on the options you want: **Recalculate on edit**, **Respect Q limits** and **DC start**.
3. To change other settings, press Ctrl+, to open **Study case**.
4. Scroll to the **Load flow** heading and change the settings you need.
5. Select **Apply**.

The settings you will use most are in this table.

| Setting | What it does |
| --- | --- |
| **Power mismatch tolerance** | Sets how small the power imbalance must be before the solution is accepted. The default is 0.001 MVA. |
| **Maximum iterations** | Sets how many steps the solver may take. The default is 30. |
| **Respect reactive power limits** | Holds a machine at its reactive limit, instead of its voltage setpoint, when it reaches that limit. Off by default. |
| **Start from a DC load flow** | Takes the starting angles from a DC load flow. It helps meshed networks with phase-shifting transformers to converge. On by default. |
| **Load scaling** | Scales every load, as a percentage. The default is 100 %. |
| **Tap changers regulate voltage** | Lets transformer tap changers move to hold a busbar voltage. Off by default. |
| **Phase shifters regulate flow** | Lets phase-shifting transformers move to hold a power flow. Off by default. |
| **Switched shunts regulate voltage** | Lets switched shunts add or remove sections to hold a voltage. Off by default. |
| **Share each island's imbalance among** | Chooses which machines take up the difference between generation and load. |

The ribbon switch **Respect Q limits** is the setting **Respect reactive power limits**. **DC start** is **Start from a DC load flow**. For how the solver works, see [the engine description](../ENGINE.md#load-flow).

## Run it

1. On the **Calculate** tab, select **Load flow**. You can also press Alt+L or Ctrl+Enter.
2. Wait for the progress bar in the status bar to finish.

The **Load flow** tab opens in the results panel, and the diagram shows the results. The **Output** tab logs a summary, such as the iterations and the highest loading.

To stop a calculation that takes too long, press Ctrl+. or select **Cancel calculation** on the **Calculate** tab.

With **Recalculate on edit** on, the load flow runs again after each change you make. It starts only after you have run it once.

## Read the results

The top of the **Load flow** tab shows a summary:

- A pill that says **Converged in 2 iterations**, or the reason the solver did not converge.
- **Generation**, **Load** and **Losses**, in MW.
- **Shared imbalance**, if machines shared the imbalance of an island.
- **Mismatch**, the largest power imbalance left, in MVA.
- **Time**, how long the calculation took.

Use the buttons on the right of the tab to switch between its tables.

| Table | What it lists |
| --- | --- |
| **Busbars** | **Busbar**, **Type** (**Ref**, **PV** or **PQ**), **U** in kV, **u** in p.u., **Angle**, **P injected** and **Q injected** |
| **Branches** | **Branch**, **Type**, **Loading** in %, **P from**, **Q from**, **P to**, **Q to**, **I max** and **Losses** |
| **Machines and loads** | **Element**, **Type**, **P**, **Q** and a **Note** such as **At upper Q limit** |
| **Controls** | Each tap changer, phase shifter or switched shunt that moved: **Before**, **After**, **Moved** and **Range** |
| **Areas** | Each area's **Net export** against its **Target** |
| **Warnings** | Warnings and **De-energised busbar** rows |

The tables **Controls**, **Areas** and **Warnings** appear only when they have something to show. The first 3 short warnings show as pills instead of a table.

On the diagram, each busbar's result box shows its voltage and angle. Each branch shows the power at both ends and its loading. Colours show loading from 0 % to 100 % or more. Busbars outside their band have their own colours.

To show only the rows that need attention, use the filters above the table. See [Work with results](work-with-results.md).

## Check your results

Use these checks before you rely on a result.

- **Power balance.** **Generation** should equal **Load** plus **Losses**. If it does not, look for **Shared imbalance** or a warning.
- **Voltages.** Most busbars should be close to 1.00 p.u. A busbar far from 1.00 p.u. is a finding. Check the data around it before you trust it.
- **Reference.** The reference machine or external grid takes up the imbalance. If its **P** looks unrealistic, check your loads and **Load scaling**.
- **Reactive limits.** With **Respect reactive power limits** on, a machine marked **At upper Q limit** cannot hold its voltage setpoint.
- **A change you know.** Change one load, then check that the losses and the flows move the way you expect. Press Ctrl+Z to undo the change.

To check your results against another tool, see [Check PowerStudio against your own tool](check-against-your-tool.md).

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| A red pill, such as "No convergence after 30 iterations", that names a busbar | The solver stopped with a large mismatch near that busbar | Check the loads and data around that busbar. Try a lower **Load scaling**. Switch **Start from a DC load flow** on or off. |
| A **Load flow cannot run** message about a line that joins busbars with different nominal voltages | A line connects 2 voltage levels | Replace the line with a transformer. |
| A **Nothing to calculate** message | The network has no busbars | Draw a network or open a sample. |
| **De-energised busbars** in the **Output** tab | A part of the network has no external grid or reference machine | Connect it to a source, or set a machine in it to **Reference**. |
| A machine says **At upper Q limit** or **At lower Q limit** | It cannot hold its voltage with the reactive power it has | Change the setpoint, the limits or the network. |
| The pill **Calculated before the last edit**, and **old** on the tab | You changed the network after the calculation | Run the load flow again. |

A load flow starts from the last one that converged. If it does not converge from that start, PowerStudio tries again from the usual start before it reports a failure.

## Try it on the IEEE 14-bus sample

The IEEE 14-bus sample is a 132/33/11 kV transmission network with 5 machines.

1. Select the **Help** tab.
2. Under **Samples**, select **IEEE 14-bus system**.
3. Select the **Calculate** tab, then select **Load flow**.
4. Read the summary. The pill says **Converged in 2 iterations**. **Generation** is 272.39 MW, **Load** is 259.00 MW and **Losses** are 13.393 MW.
5. Check the balance. 259.00 MW plus 13.39 MW is 272.39 MW.
6. In the **Busbars** table, select **Outside band**. It lists 3 busbars: **Bus 6** at 1.0700 p.u., **Bus 7** at 1.0615 p.u. and **Bus 8** at 1.0900 p.u.
7. Select **Bus 8** to see its data. Its **Upper voltage limit** is 1.06 p.u., and the machine there holds 1.09 p.u.
8. In the **Branches** table, look at **Loading**. The highest is **Transformer 5-6** at 76.4 %, then **Line 1-2** at 72.5 %. No branch is above 90 %.

The Riverside sample is a 110/20/0.4 kV distribution network. Under **Samples**, select **Riverside distribution**. Its load flow also converges in 2 iterations. **Generation** is 26.61 MW, **Load** is 26.32 MW and **Losses** are 0.293 MW.

## Read more

- [Find fault levels](find-fault-levels.md)
- [Check the network survives outages](check-outages.md)
- [Work with results](work-with-results.md)
