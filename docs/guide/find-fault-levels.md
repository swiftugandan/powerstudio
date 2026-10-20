# Find fault levels

**What it tells you.** A short circuit study shows how much current flows into a fault, how large its first peak is and how much heat it causes. Use it to check switchgear ratings and to set protection. The calculation is [IEC 60909-style](reference.md#initial-short-circuit-current-ik).

**Warning.** The short-circuit calculation is IEC 60909-style. It is not certified. Do not use it alone to release equipment or protection settings.

## Before you start

Check that the network has the data below. Select an element to see its data in the inspector.

| Data | Where to enter it |
| --- | --- |
| Busbar **Nominal voltage** | Inspector, **Basic data** |
| External grid **Short-circuit power max** and **R/X ratio max** | Inspector, **Short circuit** |
| External grid **Short-circuit power min** and **R/X ratio min**, for minimum currents | Inspector, **Short circuit** |
| Machine **Subtransient reactance xd″**, with **Short-circuit source** set to **Synchronous machine** | Inspector, **Short circuit** |
| Transformer **Short-circuit voltage**, **Copper losses (resistive part)** and **Vector group** | Inspector, **Basic data** |
| Line **Resistance R′** and **Reactance X′** | Inspector, **Basic data** |
| Motors: select a load, then switch on **Asynchronous motor** and enter its data | Inspector, **Short circuit** |

A load flow is not needed first. The short-circuit calculation ignores loads and the load flow's voltages.

## Set up the study

Choose the task that matches your question. Each task ends with the results open.

### Find fault levels at every busbar

This shows the largest fault current at each busbar, so you can compare it with the ratings of the switchgear there.

**Before you start.** Enter the data in the table above for the whole network.

1. Select the **Calculate** tab.
2. Under **Faults**, select **Three-phase**.
3. Select **Maximum currents**.
4. Select **Every busbar**.
5. Select **Short circuit**, or press Alt+S.
6. In the **Short circuit** tab, read the **Busbars** table.

Compare **Ik″**, **ip**, **Ib** and **Ith** with the ratings on the equipment's datasheet. Use **Ik″** for the initial current, **ip** for the peak withstand, **Ib** for the breaking capacity and **Ith** for the short-time withstand.

### Find the fault current at one busbar

This shows how much current flows into a fault at one busbar, and how much each line and transformer feeds into it.

**Before you start.** Check the **Short circuit** group in the inspector for the sources near that busbar. That means the external grid **Short-circuit power max** and **R/X ratio max**, and the machine **Subtransient reactance xd″**. Check each transformer's **Short-circuit voltage** and **Vector group** under **Basic data**.

1. Select the **Calculate** tab.
2. Under **Faults**, select **Three-phase**.
3. Select **Maximum currents**.
4. Right-click the busbar on the diagram.
5. Select **Short circuit at this busbar**.
6. In the **Short circuit** tab, select **Contributions**.

You can also select the busbar, then select **Short circuit at selected busbar** from the command palette (Ctrl+K). To go back to every busbar, select **Every busbar** under **Faults**.

### Find minimum fault currents

This shows the smallest current a fault can drive. Protection must still detect that current.

**Before you start.** Enter the minimum data for each external grid: **Short-circuit power min** and **R/X ratio min**. Check that **Line temperature at fault end** in the study case suits your lines.

1. Select the **Calculate** tab.
2. Under **Faults**, select **Minimum currents**.
3. Select the fault type your protection must detect: **Three-phase**, **Line to line** or **Line to earth**.
4. Select **Every busbar**, or right-click one busbar and select **Short circuit at this busbar**.
5. Select **Short circuit**, or press Alt+S.

Minimum currents use the grid's minimum short-circuit power and a lower [voltage factor](reference.md#voltage-factor-c). They also use line resistance at the temperature you set. The study case's default is 80 °C.

### Study earth faults

This shows the current when one or more phases touch earth. Use it to set earth-fault protection and to check earthing.

**Before you start.** Earth faults need zero-sequence data. [Zero-sequence data](reference.md#zero-sequence-data) describes how the network carries current through earth. Enter it in the **Short circuit** group of the inspector:

- Line: **Zero-sequence R0′**, **Zero-sequence X0′** and **Zero-sequence B0′**.
- Transformer: **Zero-sequence uk0**, **Zero-sequence uR0** and the neutral earthing **resistance** and **reactance**. Also check its **Vector group** under **Basic data**.
- External grid: **X0/X1 ratio** and **R0/X0 ratio**.

Machines are unearthed in the zero sequence. An earth fault behind a delta winding reads about 0 kA.

1. Select the **Calculate** tab.
2. Under **Faults**, select **Line to earth**.
3. Select **Maximum currents** or **Minimum currents**.
4. Select **Every busbar**, or right-click one busbar and select **Short circuit at this busbar**.
5. Select **Short circuit**, or press Alt+S.
6. In the **Busbars** table, read **Ik″** and **|Z0|**.

**Line to earth** is the only earth fault in the short-circuit study. The EMT study also has **Two phases to earth**. See [Look at the first cycles of a fault or switching](look-at-emt.md).

## Run it

You can run the study from any of the tasks above, or from the **Calculate** tab.

1. Select **Short circuit**, or press Alt+S.
2. Wait for the progress bar in the status bar to finish.

The **Short circuit** tab opens in the results panel, and the diagram shows each busbar's current. The **Output** tab logs the highest **Ik″** and where it occurs.

To change the other settings, press Ctrl+, to open **Study case**, then scroll to **Short circuit**. The settings you may need are in this table.

| Setting | What it does |
| --- | --- |
| **Minimum time delay** | Sets the time from the fault to the first contacts parting, for **Ib**. The default is 0.1 s. |
| **Short-circuit duration** | Sets how long the current flows, for **Ith**. The default is 1 s. |
| **Peak factor method** | Chooses how **ip** is found. The default is **Method C (equivalent frequency)**. |
| **LV voltage tolerance** | Chooses 6 % or 10 % for networks at or below 1 kV. The default is 10 %. |
| **Fault resistance** and **Fault reactance** | Adds an impedance in each faulted phase, such as an arc. Zero means a bolted fault. |
| **Line temperature at fault end** | Raises line resistance for minimum currents. The default is 80 °C. |

Methods are described in [the engine description](../ENGINE.md#short-circuit).

## Read the results

The top of the **Short circuit** tab shows the fault type, **Maximum** or **Minimum**, the peak factor method and the location. The **Busbars** table has these columns.

| Column | What it shows |
| --- | --- |
| **Busbar** and **Un** | The busbar and its nominal voltage in kV |
| **Ik″** | The [initial short-circuit current](reference.md#initial-short-circuit-current-ik), in kA |
| **ip** | The [peak short-circuit current](reference.md#peak-short-circuit-current-ip), in kA |
| **Ib** | The [breaking current](reference.md#breaking-current-ib), in kA. It appears only for **Three-phase** and **Maximum currents**. |
| **Ith** | The [thermal equivalent current](reference.md#thermal-equivalent-current-ith) over the **Short-circuit duration**, in kA |
| **Sk″** | The [short-circuit power](reference.md#short-circuit-power-sk), in MVA |
| **κ**, **R/X** and **c** | The peak factor, the fault loop's resistance to reactance ratio and the voltage factor |

The columns **|Z1|** and **|Z0|** give the fault impedances in ohms. **|Z0|** appears for **Line to earth** only, and reads **open** when there is no path to earth.

Select **Contributions** to see the current each branch carries into a single fault. It lists **Branch**, **I from** and **I to**, the current at each end in kA. **I from** is at the from or HV end. The tab appears only for one busbar.

To sort, filter or chart the table, see [Work with results](work-with-results.md).

## Check your results

- **Power.** For a three-phase fault, **Sk″** equals √3 times **Un** times **Ik″**. Check one row with a calculator.
- **Near the source.** Fault levels fall as you move away from the external grid and the large machines.
- **Maximum against minimum.** The minimum **Ik″** at a busbar must be lower than the maximum. If it is not, check the minimum data.
- **Peak against initial.** **ip** equals **κ** times √2 times **Ik″**. At 20 kV in Riverside, 1.847 times 1.414 times 18.397 kA is 48.05 kA.
- **Contributions.** The currents of the branches that feed the fault should add up to a little more than **Ik″**. They do not add exactly, because their phases differ.
- **A known figure.** Compare with the utility's quoted fault level at the point of connection.

To compare with another tool, see [Check PowerStudio against your own tool](check-against-your-tool.md).

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| **Ik″** reads 0.000 kA for **Line to earth** | The busbar has no earth path in the model, for example behind a delta winding | Check the transformer's **Vector group**. Remember that machines are unearthed. |
| The zero-sequence impedance column reads **open** | The zero-sequence network has no path to earth | Add earth data, or an earthed transformer, near that busbar. |
| The message **No busbar could be faulted** | The study found no busbar it could fault | Read the warnings above the table. Check that the network has a source. |
| No **Ib** column | **Ib** is shown only for **Three-phase** with **Maximum currents** | Select those two options and run it again. |
| No **Contributions** tab | You faulted every busbar | Select one busbar with **Short circuit at this busbar**. |
| A warning pill about a converter or 2 units at a busbar | A source is left out of the contributions, or only the first unit is used | Read the warning. See [the engine description](../ENGINE.md#short-circuit). |
| The pill **Calculated before the last edit** | You changed the network after the calculation | Run **Short circuit** again. |

Two limits apply to every result. The study does not calculate the steady-state current **Ik**. It takes **Ith** with n equal to 1, as pandapower does.

## Try it on the Riverside sample

The Riverside sample is a 110/20/0.4 kV distribution network. It opens with a three-phase fault set at **Hilltop**, not at every busbar.

1. Select the **Help** tab.
2. Under **Samples**, select **Riverside distribution**.
3. Select the **Calculate** tab.
4. Under **Faults**, check that **Three-phase** and **Maximum currents** are on, then select **Every busbar**.
5. Select **Short circuit**.
6. Read the **Busbars** table. The highest **Ik″** is 18.397 kA at **Riverside 20 kV**. Its **ip** is 48.047 kA and its **Sk″** is 637.3 MVA.
7. Check the power. The square root of 3 times 20 kV times 18.397 kA is 637.3 MVA.
8. Look at **Riverside 110 kV**. Its **Sk″** is 3034.4 MVA, slightly above the grid's **Short-circuit power max** of 3000 MVA. The CHP unit adds the difference.
9. Right-click **Hilltop** on the diagram, then select **Short circuit at this busbar**.
10. Select **Contributions**. **Ik″** at **Hilltop** is 3.920 kA. The **Overhead line Riverside–Hilltop** carries 2.535 kA. The **CHP unit transformer** carries 1.541 kA at its HV end.

For minimum currents, return to the **Faults** group, select **Minimum currents** and **Every busbar**, and run it again. **Ik″** at **Brook Farm** falls from 2.068 kA to 1.729 kA.

For earth faults, select **Line to earth**, **Maximum currents** and **Every busbar**, and run it again. **Hilltop** reads 4.450 kA and **Mill Lane** reads 9.172 kA. **Hilltop CHP 6.3 kV** reads 0.000 kA. The **CHP unit transformer** has a delta winding on that side, so no earth current can flow there.

The IEEE 14-bus sample has few earth paths. Its earth-fault currents are small, and at **Bus 8** the result is 0.000 kA.

## Read more

- [Run a load flow](run-a-load-flow.md)
- [Look at the first cycles of a fault or switching](look-at-emt.md)
- [Work with results](work-with-results.md)
- [Check PowerStudio against your own tool](check-against-your-tool.md)
