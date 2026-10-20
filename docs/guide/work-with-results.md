# Work with results

This chapter shows you how to read, filter, compare and export the results of any study. It also explains how the diagram shows results and when a result is out of date.

## Find your results

Each calculation puts its results in 2 places. The diagram shows them as colours and result boxes. The results panel below the diagram has a tab for each calculation.

The tabs are **Output**, **Data**, **Load flow**, **Short circuit**, **Contingency**, **Stability** and **EMT**. **Output** is the log of what the app did. **Data** shows every element of one kind as a table you can edit.

1. Run a calculation, for example by pressing Alt+L. Its tab opens by itself.
2. To open another result, select its tab. The arrow keys move between tabs.
3. To hide or show the panel, press Ctrl+J.

A badge on each tab shows its state. A tick means the result matches the network. **old** means the network changed after the calculation. On **Contingency**, the badge counts the contingencies with violations.

If a tab says that nothing has been calculated yet, select the button in the tab to run it.

## Sort and filter a table

1. Select a column heading to sort by it. Select it again to reverse the order.
2. To show only the rows that need attention, select a filter above the table.
3. Select a row to select its element on the diagram and in the inspector.
4. To select more than one element, hold Shift or Ctrl and select more rows.

Each table has its own filters:

| Table | Filters |
| --- | --- |
| **Load flow**, **Busbars** | **Near limits** (within 0.01 p.u. of a limit) and **Outside band** |
| **Load flow**, **Branches** | **Above 90 %** and **Above 100 %** |
| **Contingency**, **Contingencies** | **With violations** |
| **Contingency**, **Branches** | **Above 90 %** and **Above 100 %** |
| **Contingency**, **Busbars** | **Outside band** |
| **EMT**, **Busbars** | **Peak above 1.2 p.u.** and **RMS below 0.9 p.u.** |

Select **All** to remove a filter. When you compare with an earlier run, the load flow tables also get a **Changed** filter.

The table highlights values that break a limit. Examples are a loading above 100 % and a voltage outside its [voltage band](reference.md#voltage-band).

## Show a result as a chart

Some results show as bars. Select **Chart** in the **Table** and **Chart** switch above the table. Select **Table** to go back.

These results have a chart:

- **Load flow**, **Busbars**: the voltage of every busbar as a profile around 1 p.u., with the voltage band shaded.
- **Load flow**, **Branches**: the loading of every branch, with lines at 90 % and 100 %.
- **Short circuit**, **Busbars**: the initial short-circuit current Ik″ at every busbar.
- **Contingency**, **Branches**: the worst loading of each branch under any outage, against the loading limit.

The chart shows the same rows as the table, with the same filters. Bars take the same colours as the diagram. A compared run shows as a line across each bar.

To choose the order of the bars, use the list beside the filters. It says **As sorted in the table** when you sorted the table by another column.

To read a bar, hover over it. To select its element, select the bar. With the chart focused, the arrow keys, Home and End move between bars, and Enter selects the element.

PowerStudio remembers your choice of table or chart until you switch back.

## Compare with an earlier run

PowerStudio records each calculation you start in the project's run log. The log holds hashes of the model, the settings and the results, so you can tell whether a run is reproducible.

You can compare the load flow table with a recorded load flow.

1. Run a load flow.
2. Switch to another study case, or change the network.
3. Run the load flow again.
4. In the **Load flow** tab, open **Compare with a recorded run…**.
5. Choose a run. Each run is listed with its time, study case, scenario and variants.
6. Select **Changed** to show only the rows that differ.

The table now shows the difference from that run beside each value. The busbar table adds **Δu** and **ΔAngle**. The branch table adds **ΔLoading** and **ΔP from**.

To stop comparing, choose **Compare with a recorded run…**, the first item in the list, again.

The list appears only when the project has a recorded load flow. The run log records the calculations you start yourself. It does not record the load flows that **Recalculate on edit** runs. If the app says it did not store the results of a run, choose another run.

## Export a table as CSV

1. Open the results tab with the table you want, and set the filter you want.
2. Select **Export table as CSV**. It is the button at the top right of the results panel.
3. Find the file in your browser's downloads.

You can also use **Export table as CSV** on the **Calculate** tab, under **Study case**. Or select **File**, then **Export**, then **Results table as CSV**.

The file name starts with the network's name and says which table it holds. The columns have their units in the header, for example **Ik″ (kA)**.

The CSV holds the rows the table shows, with the filter applied and each value at full precision. It keeps the engine's order, not the order you sorted by. A chart gives the same CSV as its table.

The **Stability** and **EMT** tabs export what the plot shows. For **Stability**, that is time and one column for each machine, for the quantity you chose. For **EMT**, it is time and the 3 phases of the element you plotted.

The **Data** tab exports the table of elements.

If no table is open, the app asks you to open one first.

## Make a study report

To print the results of all your calculations, or to save them as a PDF, use **Study report**. See [Save, share and protect your work](save-share-protect.md).

## Colour the diagram by results

The diagram shows the results of one calculation at a time. Select a result tab to show that calculation's results. To change which results the diagram shows without changing the tab, use the command palette (Ctrl+K) and search for "Show … results on the diagram".

1. Select the **View** tab.
2. Under **Colouring**, select **Colour by results** to colour elements by the result.
3. Select **Colour by voltage level** to colour them by their nominal voltage instead.

With **Colour by results**, the diagram has a legend. These are the colours:

| Calculation | What the colours show |
| --- | --- |
| Load flow | Branch loading from 0 % to at least 100 %. Busbars below or above their voltage band have their own colours. |
| Short circuit | The initial short-circuit current at each busbar, from low to high. For a fault at one busbar, each branch's share of the fault current. |
| Contingency | The worst loading of each branch under any outage. |
| Stability | Busbars below their band, and busbars below 0.8 p.u., at the time you chose on the plot. |
| EMT | Branch peak current, and busbars whose voltage peak is above 1.2 p.u. or above 1.5 p.u. of crest. |

To remove all results from the diagram and the panel, select **Clear results** on the **Calculate** tab, under **Study case**.

## Choose which labels the diagram shows

The **View** tab controls what the diagram writes next to elements.

- Under **Annotations**, **Result boxes** shows the result values (Shift+R), **Names** shows element names (Shift+N) and **Line names** shows the names of lines.
- Under **Labels**, **Disentangle labels** keeps labels apart (Shift+L). **Reset label positions** returns labels you dragged to automatic placement.

Result boxes show once the diagram is zoomed in enough to read their text.

To put a label where you want it, drag it. It stays there, relative to its element, when the element moves. With **Disentangle labels** off, every label stays in its fixed place.

## Know when a result is out of date

A result is out of date when you edit the network after calculating it. The tab shows **old**, and the toolbar shows **Calculated before the last edit**. The results stay on screen so you can compare them, but they do not describe the network as it is now.

To keep the load flow up to date, use **Recalculate on edit**. It is on the **Calculate** tab, under **Steady state**.

With **Recalculate on edit** on, the load flow runs again after each change, once you have run it. It does not update the other calculations. Run them again after an edit.

If a recalculation is running when you start a calculation yourself, the app stops the recalculation and runs yours.

To stop a calculation that is running, press Ctrl+. or select **Cancel calculation** on the **Calculate** tab.

## Read more

- [Run a load flow](run-a-load-flow.md)
- [Find fault levels](find-fault-levels.md)
- [Check the network survives outages](check-outages.md)
- [Save, share and protect your work](save-share-protect.md)
