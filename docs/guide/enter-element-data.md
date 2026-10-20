# Enter element data

Every element in your network carries data: a line has its impedance, a transformer its ratings, a machine its set points and reactances. This chapter shows you where to enter that data, how to change many elements at once, and which data each study reads.

A new element starts with typical values, so you can run a study straight away. The results are only as good as the data, so replace the typical values with your own before you rely on a result. Data you [import](import-a-model.md) comes from the source model. PowerStudio fills any gap with typical values and lists them in the import notes.

## Before you start

Draw or import your network first. [Build your network](build-your-network.md) shows you how.

Keep your data sheets to hand. Each field in PowerStudio shows its unit, so check that your values use the same one. For example, a line's impedance is in Ω/km and a transformer's short-circuit voltage is in %.

## Open an element's data

1. Select the element on the diagram, in the model tree, or from the command palette (Ctrl+K).
2. Look at the inspector on the right. If you cannot see it, select **Inspector** on the **View** tab.

The inspector shows the data in up to 5 groups. Each group opens and closes when you select its heading.

| Group | What it holds |
| --- | --- |
| **Basic data** | Name, connections, whether the element is in service, ratings and the impedance in the positive sequence |
| **Load flow** | Set points, limits, loads, taps and controls |
| **Short circuit** | Data for fault currents: subtransient reactances, zero-sequence impedances, earthing and source type |
| **Stability** | Rotor model, inertia, and the exciter, governor and stabiliser of a machine |
| **Diagram** | Position, bar length, side, route and labels |

A group appears only if the element has fields in it. A field appears only when it applies. For example, **Voltage target** shows only when **Automatic tap control** is on.

To see what a field means, hover over its name.

## Enter a value

1. Select the field.
2. Type the value.
3. Press Enter.

If the value is outside its allowed range, PowerStudio refuses it. It tells you why below the field and keeps the old value.

Every change is 1 step you can undo with Ctrl+Z. With **Recalculate on edit** on, the load flow runs again after each change, once you have run it.

To check your changes, select an empty part of the diagram. The inspector then shows the network's **Name**, **Base power**, **Frequency** and **Description**. Set the **Frequency** to 50 Hz or 60 Hz to match your system. The EMT simulation uses it.

## Enter data for each kind of element

### Busbars

- **Nominal voltage** (kV) is the voltage the busbar is rated for.
- **Lower voltage limit** and **Upper voltage limit** (in [per unit](reference.md#per-unit)) set the band that the load flow and contingency checks use. They are under **Load flow**.
- **Zone** is optional. Zones group busbars into areas for interchange control.

### Lines

Enter the data per kilometre: **Resistance R′** (Ω/km), **Reactance X′** (Ω/km) and **Susceptance B′** (µS/km), with the **Length** (km) and the number of **Parallel systems**.

**Rated current** (kA) sets the line's loading. If you enter 0, the line has no rating and PowerStudio does not report its loading. The earth-fault data are under **Short circuit**: **Zero-sequence R0′**, **Zero-sequence X0′** and **Zero-sequence B0′**.

### Transformers

- **Basic data** holds the rated power, the rated voltages HV and LV, the **Short-circuit voltage** (uk), the **Copper losses (resistive part)** (uR) and the **Vector group**. If the rated power is only the base for the impedance data, clear **Rated power limits loading**.
- **Load flow** holds the no-load current, iron losses, magnetising branch, **Additional phase shift** and the tap changer. The **Tap changer** is either **Voltage ratio** or **Phase shift**.
- **Automatic tap control** holds a busbar voltage (for a voltage ratio changer) or a flow (for a phase shift changer). It acts only if the study case lets tap changers regulate: **Tap changers regulate voltage** or **Phase shifters regulate flow**.
- **Short circuit** holds the zero-sequence impedance (**Zero-sequence uk0**, **Zero-sequence uR0**) and the neutral earthing of an earthed star winding. It also holds **On-load tap changer**, which matters for power station units.

### Machines

- **Control mode** is **PV**, **PQ** or **Reference**. **PV** holds active power and voltage. **PQ** holds active and reactive power. **Reference** sets the angle and balances the system.
- **Active power**, **Voltage setpoint**, the reactive power limits and the ratings are under **Basic data** and **Load flow**.
- **Short-circuit source** under **Short circuit** says how the machine meets a fault. Choose **Synchronous machine**, **Network feeder** or **Converter**.
- A **Synchronous machine** needs **Subtransient reactance xd″**, **Stator resistance** and **Voltage regulation range**. Choose its **Unit transformer** if it forms a power station unit with one.
- A **Network feeder** needs **Short-circuit power max** and **R/X ratio max**, and the minimum values. Use it for the equivalent of a neighbouring network that regulates like a machine.
- A **Converter** needs **Short-circuit current**, as a multiple of its rated current. Use it for wind and solar parks and batteries. A converter has no rotor, so it has no **Stability** data.
- **Stability** holds the **Rotor model** (**Classical** or **Round rotor**), the **Inertia constant**, **Damping** and the reactances. The **Exciter**, **Governor** and **Stabiliser** each have their parameters under the model's name.

### External grids

Enter the **Voltage setpoint** and **Voltage angle** under **Load flow**. Under **Short circuit**, enter **Short-circuit power max** and **Short-circuit power min**, the R/X ratios, and the zero-sequence ratios **X0/X1 ratio** and **R0/X0 ratio**.

### Loads

Enter the **Active power** and **Reactive power** at nominal voltage. The constant impedance and constant current shares say how the power varies with voltage. A load that is an asynchronous motor feeds maximum short-circuit currents. Select **Asynchronous motor** under **Short circuit** and enter its motor data.

### Shunts

Enter the **Reactive power per section**: positive for a capacitor and negative for a reactor. Then enter the **Sections in service** and **Sections installed**.

## Enter data for many elements at once

The **Data** tab shows every element of 1 kind as a table, like a spreadsheet.

1. In the results panel, select the **Data** tab.
2. In the list at the left of the toolbar, choose the kind of element, such as **Busbars**.
3. To narrow the rows, type in **Filter by name or identifier**. You can also select **Selected on the diagram**.
4. Select a cell, then type a value and press Enter.

Each column is a field from the inspector, without the **Diagram** group. A dash means the field does not apply to that element.

To change several elements together:

1. Select the rows. Hold Shift or Ctrl to select more than 1, or press Ctrl+A to select all.
2. Select a cell in the column to change.
3. Type the value and press Enter.

To paste a block from a spreadsheet:

1. Select the first cell to fill.
2. Press Ctrl+V.

PowerStudio fills cells to the right and down. It pastes the whole block or none of it. If a value does not fit, a message names the element and the reason, and nothing changes. Ctrl+Z undoes a paste or a change to many rows as 1 step.

The machine's **Exciter**, **Governor** and **Stabiliser** are edited in the inspector, not in the sheet.

## Find out which data each study needs

Every study reads the network's connections and the in-service state of each element. The table shows the data it reads beyond that. To check the data for a study, open each group in the inspector and check the fields listed.

| Study | Element | Fields to check | Inspector group |
| --- | --- | --- | --- |
| Load flow | Busbars | **Nominal voltage**, **Lower voltage limit**, **Upper voltage limit** | **Basic data**, **Load flow** |
| Load flow | Lines | **Length**, **Resistance R′**, **Reactance X′**, **Susceptance B′** | **Basic data** |
| Load flow | Transformers | Rated power and voltages, **Short-circuit voltage**, **Copper losses (resistive part)**, **Vector group**, no-load current, iron losses, tap changer | **Basic data**, **Load flow** |
| Load flow | Machines | **Control mode**, **Active power**, **Voltage setpoint**, reactive power limits | **Load flow** |
| Load flow | External grids | **Voltage setpoint**, **Voltage angle** | **Load flow** |
| Load flow | Loads | **Active power**, **Reactive power** | **Load flow** |
| Load flow | Shunts | **Reactive power per section**, **Sections in service** | **Load flow** |
| Contingency | Lines | **Rated current** | **Basic data** |
| Contingency | Transformers | Rated power, **Rated power limits loading** | **Basic data** |
| Contingency | Busbars and machines | Voltage limits, and the reactive power limits if the study case respects them | **Load flow** |
| Short circuit | External grids | **Short-circuit power max** and **min**, **R/X ratio max** and **min** | **Short circuit** |
| Short circuit | Machines | **Short-circuit source**, **Subtransient reactance xd″**, **Stator resistance**, **Voltage regulation range**, **Unit transformer** | **Short circuit** |
| Short circuit | Transformers | Rated power and voltages, **Short-circuit voltage**, **Copper losses (resistive part)**, **Vector group** | **Basic data** |
| Short circuit | Lines | **Resistance R′**, **Reactance X′** | **Basic data** |
| Short circuit | Loads | **Asynchronous motor** and its data, for maximum currents | **Short circuit** |
| Short circuit, earth faults only | Lines | **Zero-sequence R0′**, **Zero-sequence X0′**, **Zero-sequence B0′** | **Short circuit** |
| Short circuit, earth faults only | Transformers | **Zero-sequence uk0**, **Zero-sequence uR0**, neutral earthing | **Short circuit** |
| Short circuit, earth faults only | External grids | **X0/X1 ratio**, **R0/X0 ratio** | **Short circuit** |
| Stability | Machines | **Rotor model**, **Inertia constant**, **Damping**, **Transient reactance xd′**, **Exciter**, **Governor**, **Stabiliser** | **Stability** |
| Stability | Machines, round rotor | The synchronous and transient reactances and time constants, and the saturation | **Stability** |
| Stability | Machines, round rotor | **Subtransient reactance xd″**, **Stator resistance** | **Short circuit** |
| Stability | Study case | **Load P held as constant power**, **Load P held as constant current** and the reactive power equivalents | **Stability simulation** section of the study case (Ctrl+,) |
| EMT | Network | **Frequency** | Network (nothing selected) |
| EMT | External grids | **Short-circuit power max**, **R/X ratio max**, and the zero-sequence ratios for unbalanced faults | **Short circuit** |
| EMT | Machines | **Subtransient reactance xd″**, **Stator resistance** | **Short circuit** |
| EMT | Lines | **Length**, **Resistance R′**, **Reactance X′**, **Susceptance B′**, and the zero-sequence values for unbalanced faults | **Basic data**, **Short circuit** |
| EMT | Transformers | **Vector group**, neutral earthing | **Basic data**, **Short circuit** |

The table does not repeat what an earlier study needs. These rules cover the rest:

- Contingency, stability and EMT all start from a load flow. They need every load flow field in the table.
- Short circuit does not use the load flow's set points, loads or taps. It uses loads only when they are motors.
- A stability simulation needs a machine's rotor and controls. An EMT simulation does not. It holds each source's voltage at its load-flow value and does not move the rotor.
- Zero-sequence data matter only for earth faults and unbalanced EMT faults. A three-phase fault does not read them.

For the formulas behind each field, see [the calculation engine](../ENGINE.md).

## Check your data

- Run a [load flow](run-a-load-flow.md) first. A bad value usually shows as a voltage far from 1 per unit or a branch loaded far above 100 %.
- Read the warnings in the **Load flow** tab. It lists busbars that PowerStudio left out as de-energised. The **Output** tab logs what PowerStudio did.
- Use the **Data** tab to scan a column for values that stand out.
- Compare a result with a result you trust from another tool. [Check PowerStudio against your own tool](check-against-your-tool.md) shows you how.
