# Set up study cases, scenarios and variants

A network rarely has only 1 set of conditions. You may want to study it in winter and in summer, with and without a planned new line, or with a different fault type. This chapter shows you how to keep each set of conditions in 1 project, and switch between them.

## Understand study cases, scenarios and variants

A project holds 1 network and any number of these 3 parts:

| Part | What it holds | Example |
| --- | --- | --- |
| **Study case** | The settings of every calculation, 1 scenario and the variants that apply | "Winter peak" |
| **Scenario** | The operating values: which elements are in service, set points, loads, generation and taps | Less load, 1 generator out |
| **Variant** | A planned change to the equipment, recorded as a list of edits | A new line |

The study case is what you work in. You always have an active study case, shown in the title bar. Every calculation you run uses it, and the run log records which one.

A new project has 1 study case, **Base case**. It has no scenario and no variants, so it uses the values in the base model. The base model is the network as you built or imported it.

A scenario changes values. A variant changes equipment. A scenario cannot add a line. A variant is not the place to record a different load.

## Open the project page

You manage all 3 parts on the project page.

1. Select the study case in the title bar.
2. Select **Manage project…**.

You can also go to **File**, then **Project**. The page has the sections **Study cases**, **Scenarios**, **Variants**, **Where changes go** and **Run log**. Select **Back to diagram** to return to the diagram.

## Choose where your changes go

Every edit goes to 1 part of the project.

| What you change | Where PowerStudio keeps it |
| --- | --- |
| A calculation setting, such as **Load scaling** | The active study case |
| An operating value, such as **In service**, **Active power** or **Tap position** | The active study case's scenario, if it has one. Otherwise the variant you are recording, or the base model. |
| Equipment, such as adding a line or changing a transformer's rating | The variant you are recording, or the base model |
| A move on the diagram | Wherever the element is kept |
| The network's own details, such as its name | The base model |

So with a scenario in the active study case, a change to a load's **Active power** goes into the scenario. The base model stays as it was.

## Create a scenario

1. Open the project page.
2. Under **Scenarios**, select **New scenario**.
3. Rename it. Select the name, type the new one and press Enter.

A new scenario holds no values yet, and its row says "0 values set". To fill it:

1. Under **Study cases**, choose the scenario in the **Scenario** list of a study case.
2. Make that study case the active one.
3. Change operating values, such as a load's **Active power**.

The row then counts the values the scenario sets.

## Create a study case

1. Open the project page.
2. Under **Study cases**, select **New study case**.
3. Rename it.
4. Under **Scenario**, choose the scenario it uses. **Base values** means no scenario.
5. Under **Variants**, tick the variants it includes.

A new study case starts as a copy of the active one: its scenario, its variants and its settings. After that, the 2 are independent. A change to the settings of one does not change the other.

## Switch between study cases

1. Select the study case in the title bar.
2. Choose the study case you want.

The one you chose gets a tick. You can also select the radio button beside a study case on the project page.

Switching loads that study case's network and clears the results on screen. It also clears the undo history. Run the calculation you need.

## Change a study case's settings

Press Ctrl+, to open the **Study case** dialog. You can also select **Study case** in the **Study case** group on the **Calculate** tab.

The dialog has a section for each calculation, plus **Area interchange**, **Simulation events** and **EMT events**. Change a value, then select **Apply**. Select **Cancel** to close it without changes.

| Section | What you set |
| --- | --- |
| **Load flow** | **Power mismatch tolerance**, **Maximum iterations**, **Respect reactive power limits**, **Start from a DC load flow**, **Load scaling**, and which controls act: **Tap changers regulate voltage**, **Phase shifters regulate flow**, **Switched shunts regulate voltage** and **Areas hold their interchange** |
| **Short circuit** | **Fault type**, **Calculation** (maximum or minimum currents), **Peak factor method**, **LV voltage tolerance**, **Fault location**, **Minimum time delay**, **Short-circuit duration**, **Line temperature at fault end**, **Fault resistance** and **Fault reactance** |
| **Contingency analysis** | **Line outages**, **Transformer outages**, **Generator outages**, **Busbar faults**, **Loading limit** and **Screen outages first**. Your own contingencies and remedial actions are under **Contingencies** on the **Calculate** tab. |
| **Stability simulation** | **Simulation time**, **Step size**, the load shares such as **Load P held as constant power**, and the **Simulation events** |
| **EMT simulation** | **Simulation time**, **Time step**, **Line model** and the **EMT events** |

The **Calculate** tab holds the switches you change most often:

- Under **Steady state**: **Recalculate on edit**, **Respect Q limits** and **DC start**.
- Under **Faults**: **Three-phase**, **Line to line**, **Line to earth**, **Maximum currents**, **Minimum currents** and **Every busbar**.
- Under **Security**: **Contingencies**, **Generator outages** and **Screen outages first**.
- Under **Dynamics**: **Events** and **EMT events**.

Each of these changes the active study case only.

## Set up winter and summer study cases

This pattern keeps a winter peak and a summer minimum side by side. [Get started](get-started.md) works it through on the IEEE 14-bus sample.

First, create the parts:

1. Open the project page.
2. Under **Study cases**, rename **Base case** to `Winter peak`.
3. Under **Scenarios**, select **New scenario**.
4. Rename the new scenario to `Summer minimum`.
5. Under **Study cases**, select **New study case**.
6. Rename it to `Summer minimum`.
7. Choose **Summer minimum** as its **Scenario**.
8. Select the radio button beside it to make it the active study case.
9. Select **Back to diagram**.

Then set the summer conditions:

1. Press Ctrl+, to open the **Study case** dialog.
2. Under **Load flow**, set **Load scaling** to a lower value, such as 60 %.
3. Select **Apply**.
4. Select an element, such as a generator, and press Shift+O to switch it out of service.

**Load scaling** is a setting, so it stays in the summer study case. The generator's **In service** state is an operating value, so it goes into the summer scenario. **Winter peak** keeps all its load and every generator.

Use **Load scaling** for a uniform change to every load. Change individual loads' **Active power** when the change is not uniform. Either way, the change stays in the summer parts.

## Study a planned new line with a variant

A variant records your edits to the equipment so that the base model stays as it was built.

1. Open the project page.
2. Under **Variants**, select **New variant**.
3. Rename it, for example to `New line`.
4. Select **Back to diagram**.

The new variant joins the active study case and starts recording at once. The title bar shows its name beside the study case, with a record mark. From now on, edits to the equipment go into the variant.

5. Draw the line with the **Line** tool and enter its data. [Build your network](build-your-network.md) shows you how.
6. Select the study case in the title bar.
7. Select **Changes go to the base model** to stop recording.

To compare with and without the line:

1. Open the project page.
2. Under **Study cases**, select **New study case**. It copies the active one, including the variant.
3. Rename the copy, for example to `Without new line`.
4. In its **Variants** row, clear the **New line** checkbox.
5. Switch between the 2 study cases and run the same study in each.

A variant applies to a study case only if its checkbox is ticked. Variants apply in project order, whatever order you ticked them in. The **In service** date on a variant records the date the change is planned for. It does not switch the variant on or off.

## Choose where equipment changes are recorded

The **Where changes go** section lists the active study case's variants. Choose between:

- **The base model (the network as built)**
- **Variant:** and the variant's name

The list is dimmed until the active study case has a variant. The title bar menu offers the same choice as **Changes go to the base model** and **Changes go to** the variant's name.

**Warning:** while a variant is recording, edits to the equipment do not change the base model. Switch recording off before you edit the network as built.

## Check which runs you made

PowerStudio records every calculation you start in the **Run log** section. Each row gives the time, the calculation, the study case with its scenario and variants, and the outcome. It also gives the duration and short hashes of the model and the results.

The hashes show whether 2 runs used the same model and gave the same results. Use a run with **Compare with a recorded run…** in the **Load flow** tab to see what changed. [Work with results](work-with-results.md) shows you how.

The log records only calculations you start. It does not record those that **Recalculate on edit** runs. To remove a run and its stored results, select its delete button.

## Delete a part

- To delete a study case, select its delete button. You cannot delete the last one. Its scenario and variants stay in the project.
- To delete a scenario, select its delete button. Study cases that used it go back to the base values.
- To delete a variant, select its delete button. It takes its recorded changes with it.

Each deletion asks you to confirm.

## If something goes wrong

| Problem | What to do |
| --- | --- |
| A change affected the wrong study case | Press Ctrl+Z at once. Switching study cases clears the undo history, so after a switch make the change again by hand. |
| An edit changed the base model when you meant a variant | Press Ctrl+Z. Choose the variant in **Where changes go**, then edit again. |
| **Where changes go** is dimmed | The active study case has no variant. Select **New variant**, or tick an existing one in the study case's **Variants** row. |
| A scenario value does nothing | Check the active study case uses the scenario. Its **Scenario** must not be **Base values**. |
| Results look old | A result marked **Calculated before the last edit** needs the calculation run again. |
