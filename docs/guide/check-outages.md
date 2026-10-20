# Check the network survives outages

**What it tells you.** An [N-1](reference.md#n-1) analysis takes each line and transformer out of service in turn and runs a load flow. It shows which outages overload a branch or push a voltage outside its [band](reference.md#voltage-band). Use it to see whether the network stays within its limits after losing any one element.

## Before you start

Check that the network has the data below. Select an element to see its data in the inspector.

| Data | Where to enter it |
| --- | --- |
| A load flow that converges in the base case | See [Run a load flow](run-a-load-flow.md) |
| Line **Rated current** and transformer **Rated power** | Inspector, **Basic data** |
| Busbar **Lower voltage limit** and **Upper voltage limit** | Inspector, **Load flow** |
| Contingencies of several elements, and remedial actions | **Contingencies** dialog, described below |

The analysis judges a branch by its loading, which is its current or power as a share of its rating. A line with a **Rated current** of 0 has no loading, so the analysis never finds it overloaded.

## Set up the study

1. Select the **Calculate** tab.
2. Under **Security**, select **Generator outages** to take each machine out in turn too. It is off by default.
3. To skip outages that are clearly safe, select **Screen outages first**.
4. To change the other settings, press Ctrl+, to open **Study case**.
5. Scroll to the **Contingency analysis** heading and change the settings you need.
6. Select **Apply**.

The settings are in this table.

| Setting | What it does |
| --- | --- |
| **Line outages** | Takes each line out in turn. On by default. |
| **Transformer outages** | Takes each transformer out in turn. On by default. |
| **Generator outages** | Takes each machine out in turn. Off by default. |
| **Busbar faults** | Applies a fault to each busbar, which takes out everything connected to it. Off by default. |
| **Loading limit** | Sets the loading above which a branch counts as overloaded. The default is 100 %. |
| **Time to act on an overload** | Sets how long an overload may last before someone acts. A branch is judged against its largest limit that holds for at least this long. The default is 0 s, which uses permanent limits only. |
| **Screen outages first** | Solves each branch outage with a quick method first. Only outages near a limit get a full load flow. Off by default. |
| **Screening loading margin** | Sets how close to the **Loading limit** an outage must come to get a full load flow. The default is 5 %. |
| **Screening voltage margin** | Sets how close to its band a voltage must come to get a full load flow. The default is 0.01 p.u. |

Screening saves time on large networks. It still solves in full every outage that [screening](reference.md#screening) cannot clear.

Most models drawn in PowerStudio have 1 rating for each branch. Leave **Time to act on an overload** at 0 s unless an imported model carries temporary limits.

### Add contingencies of several elements

Use this for elements that fail together, such as both circuits of a double line.

1. On the **Calculate** tab, under **Security**, select **Contingencies**.
2. Under **Contingencies**, select **Add contingency**.
3. In **Name**, enter a name for the contingency.
4. Select **Add line, transformer, machine or busbar**, then type or pick each element that fails together.
5. Select **Apply**.

A busbar in the list stands for a fault there. It takes out everything connected to that busbar.

To keep your contingencies, select **Export** in the dialog. To read them back, select **Import…**.

### Add a remedial action

A remedial action is a step an operator takes after an outage, such as shedding load. See [remedial action](reference.md#remedial-action).

1. Select **Contingencies** under **Security**.
2. Under **Remedial actions**, select **Add remedial action**.
3. In the name box, enter a name for the action.
4. Under **After**, add the outage the action is for. Leave it empty to apply the action after every contingency.
5. Under **When all of these hold**, set the condition. For example, choose **Loading of**, pick a line and enter 100 %.
6. Under **Do**, choose the action and its element. The actions are **Take out of service**, **Put in service**, **Set generation of**, **Set tap position of** and **Shed load**.
7. Select **Apply**.

After a contingency, an action whose conditions all hold is applied. The case is then solved again, and the results show the state after the action.

## Run it

1. On the **Calculate** tab, select **Contingency**, or press Alt+N.
2. Wait for the progress bar in the status bar to finish.

The **Contingency** tab opens in the results panel. The **Output** tab logs how many contingencies ran and how many have new violations.

To stop the analysis, press Ctrl+.

## Read the results

The top of the **Contingency** tab shows a pill and a summary.

- The pill says how many contingencies have **new violations**, or **Secure under every contingency**. It adds the number that are **not solvable**.
- **Contingencies** is the number of cases run.
- **Screened** shows how many outages the quick method cleared, when you use screening.
- **Remedial actions on** shows how many cases an action changed.
- **Loading limit** is the limit you set.
- **Base case max** is the highest loading before any outage.

A violation is new when the base case does not already have it. The pill counts only new violations.

Use the buttons on the right to switch between the tables.

| Table | What it lists |
| --- | --- |
| **Contingencies** | **Contingency**, **Type**, **Result**, **Max loading**, **Most loaded**, **Min u**, **Max u**, **Lost busbars**, **Violations** and **Remedial actions** |
| **Branches** | **Branch**, **Worst loading** and **Under the outage of**: the outage that loads each branch most |
| **Busbars** | **Busbar**, **Lowest u** and **Highest u**, each with the outage that causes it |

**Result** says **Secure**, a number of violations, or **Not solvable**. **Not solvable** means the load flow found no solution after that outage. Violations already in the base case are listed too, in amber.

The **Remedial actions** column appears when an action ran. Hover over a cell to see how many violations there were before the action.

The diagram shows the worst result for each element. See [Work with results](work-with-results.md) for the filters and the chart.

## Check your results

- **Do it by hand.** Select a line, press Shift+O to switch it out, then run a load flow. The loading should match **Max loading** for that outage.
- **Neighbours.** The **Most loaded** branch is usually next to the one you took out. If it is far away, look at the network around it.
- **Count.** The number of contingencies is the lines plus the transformers, plus any machines, busbars and contingencies of your own.
- **Base case.** If **Base case max** already exceeds the **Loading limit**, the network is overloaded before any outage.
- **A tighter limit.** Lower the **Loading limit** to 80 % and run it again. On the IEEE 14-bus sample, 13 contingencies then have new violations.

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| **N-1 contingency analysis failed**, and "The base case does not converge" | The load flow fails before any outage | Fix the load flow first. See [Run a load flow](run-a-load-flow.md). |
| **Not solvable** in **Result** | The network has no solution after that outage, for example after losing its only source | Check **Lost busbars**. Add a source or reduce the load. |
| A note that screening is off | The study case has controls that screening cannot follow, such as regulating tap changers | Read the note. Every outage then gets a full load flow. |
| A line never shows an overload | Its **Rated current** is 0 | Enter its rated current. |
| A warning in the **Output** tab that memory ran short | A very large network needed more memory than the device had | Wait. The result is the same, but it takes longer. |
| The pill **Calculated before the last edit** | You changed the network after the calculation | Run **Contingency** again. |

## Try it on the IEEE 14-bus sample

1. Select the **Help** tab.
2. Under **Samples**, select **IEEE 14-bus system**.
3. Select the **Calculate** tab, then select **Contingency**.
4. Read the pill. It says **10 contingencies with new violations**. The summary shows 20 **Contingencies**, a **Loading limit** of 100 % and a **Base case max** of 76.4 %.
5. Select the **Max loading** heading until the highest value is at the top. **Line 1-2** is first with 181.4 %. Its **Most loaded** branch is **Line 1-5**.
6. Select the **Branches** button. **Line 1-5** has a **Worst loading** of 181.4 % under the outage of **Line 1-2**. **Line 9-10** reaches 137.9 % under the outage of **Transformer 5-6**.
7. Select the **Busbars** button. The lowest voltage is 0.9935 p.u. at **Bus 5**, under the outage of **Line 1-2**. No voltage falls below its band.

The 10 contingencies with new violations are these outages:

- **Transformer 5-6**, **Transformer 4-7** and **Transformer 7-9**
- **Line 1-2**, **Line 1-5**, **Line 2-3** and **Line 4-5**
- **Line 9-10**, **Line 9-14** and **Line 10-11**

Three of them load a branch above 110 %: **Line 1-2**, **Transformer 5-6** and **Line 1-5**.

**Bus 6** and **Bus 8** are above their band in the base case. Most rows list them, but they are not new violations.

To check the first row by hand, select **Line 1-2** on the diagram and press Shift+O. Run a load flow. **Line 1-5** shows 181.4 % loading. Press Ctrl+Z to undo.

### Add generator outages

Under **Security**, select **Generator outages** and run it again. The count rises to 25 contingencies. The number with new violations stays at 10.

### Try a remedial action

1. Select **Contingencies** under **Security**.
2. Under **Remedial actions**, select **Add remedial action**.
3. Under **After**, add the outage of **Line 1-2**.
4. Under **When all of these hold**, set the condition to **Loading of**, choose **Line 1-5** and enter 100 %.
5. Under **Do**, choose **Shed load**, select **Load 3** and enter 60 %.
6. Select **Apply**, then run **Contingency** again.

**Remedial actions on** shows 1. For the outage of **Line 1-2**, **Max loading** falls from 181.4 % to 125.0 %. That is still above the limit.

Change the share to 100 % and run it again. **Max loading** falls to 93.2 % and no new violation is left. Shedding all of **Load 3** takes 94.2 MW off the network. The example shows how to read the result. It is not a recommendation.

## Try it on the Riverside sample

The Riverside sample has 10 contingencies. One has new violations: the outage of the **CHP unit transformer**. It takes the CHP unit out and leaves **Hilltop** at 0.948 p.u. and **Brook Farm** at 0.930 p.u., both below 0.95 p.u.

Select **Busbar faults** in the study case and run it again. A fault on **Riverside 110 kV** is **Not solvable**. It takes out the grid infeed and both primary transformers.

## Read more

- [Check machines stay in step](check-stability.md)
- [Work with results](work-with-results.md)
- [Set up study cases](set-up-study-cases.md)
- [The engine description of contingency analysis](../ENGINE.md#contingency-analysis)
