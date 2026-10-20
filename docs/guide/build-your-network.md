# Build your network

This chapter shows you how to draw a network as a single-line diagram. You place busbars, join them with lines and transformers, connect sources and loads, and arrange the result. The diagram is also the model. Every calculation uses what you draw and the data you enter for it.

If you already have a model in another tool, [import it](import-a-model.md) instead. PowerStudio lays the diagram out for you.

## Before you start

Decide the voltage levels of your network and where its sources are. You need at least 1 source in each connected part of the network:

- an **External grid**, which stands for the upstream network and holds the voltage
- a **Machine** in **Reference** mode, which holds the voltage angle and balances the system

A part of the network without either is left out of the load flow. If it has machines only, PowerStudio picks the largest as the reference and warns you.

Drawing gives each element typical values. You then replace them with your own data. [Enter element data](enter-element-data.md) shows you how.

## Start a network

1. Go to the **File** tab.
2. On the **New** page, select **Empty network**.

The network starts with default study settings. PowerStudio saves your work in this browser as you go. The title bar shows **Saved** when your last change is stored.

To name the network, edit its name in the title bar. To set its base power and frequency, select an empty part of the diagram. The inspector then shows the network's **Name**, **Base power**, **Frequency** and **Description**. The base power is the MVA that [per unit](reference.md#per-unit) values refer to. The frequency is 50 Hz or 60 Hz.

## Choose a tool

Choose a tool on the **Insert** tab, or press its key. Press the key again to go back to the **Select** tool. Press Escape to end a tool.

| Tool | Key | What it does |
| --- | --- | --- |
| **Busbar** | B | Places a busbar where you select. |
| **Line** | L | Places a line between 2 busbars of the same voltage. Select 1 busbar, then the other. |
| **Transformer** | T | Places a 2-winding transformer between 2 voltage levels. Select 1 busbar, then the other. |
| **Machine** | G | Connects a synchronous machine to the busbar you select. Its short-circuit source can also make it a network feeder or a converter-fed unit. |
| **External grid** | E | Connects the equivalent of the upstream network. It holds the voltage and balances the system. |
| **Load** | D | Connects a load to the busbar you select. |
| **Shunt** | C | Connects a capacitor bank or a reactor to the busbar you select. |
| **Select** | V | Moves and selects elements. |
| **Pan** | H | Moves the view. You can also hold Space. |

The status bar and the hint over the diagram tell you what the current tool expects next.

## Place busbars

A busbar is a point where elements connect. In the model, it is a node.

1. On the **Insert** tab, select **Busbar**, or press B.
2. Select a point on the diagram. A busbar appears there.
3. Repeat for each busbar you need.
4. Press Escape to end the tool.

A new busbar is 120 units long and has a nominal voltage of 20 kV. To change the voltage:

1. Select the busbar.
2. In the inspector, under **Basic data**, change **Nominal voltage**.
3. Press Enter.

To lengthen or shorten a busbar, drag one of its ends. The other end stays where it is. You can also change **Bar length** under **Diagram** in the inspector.

## Join busbars with lines and transformers

1. Select **Line** on the **Insert** tab, or press L.
2. Select the first busbar.
3. Select the second busbar.

The 2 busbars must have the same nominal voltage. If they differ, PowerStudio shows a **Different voltages** warning. Select **Use transformer** in the warning to place a transformer instead.

For a transformer, select **Transformer** or press T, then select the 2 busbars in turn. The busbar with the higher voltage becomes the HV side. The transformer takes its rated voltages from the busbars.

PowerStudio gives a new line typical data for its voltage: a 3 km cable at 36 kV and below, or a 20 km overhead line above that. A new transformer gets typical ratings for its voltage levels. Replace both with your own data.

To move 1 end of a line or transformer to another busbar, drag that end onto the new busbar.

## Connect sources, loads and shunts

1. Select **Machine**, **External grid**, **Load** or **Shunt** on the **Insert** tab.
2. Select the busbar to connect it to.

The element appears on the side of the busbar where you selected. The tool stays active, so you can add more. Press Escape to end it.

The first machine you add to a network without an external grid is a **Reference** machine. Later machines are **PV** machines, which hold their active power and voltage.

To move a connection along its busbar, drag it. To move it to the other side, drag it across the busbar, or select it and press X (**Flip side**).

## Snap elements into line

Elements line up as you place or drag them.

- A busbar you drag lines up with the busbars on screen. When its start, centre or end comes within a few pixels of another busbar's, it snaps there. A dashed guide shows the line.
- Otherwise, a busbar lands on the grid. Choose the step on the **View** tab: **Grid 10**, **Grid 20** or **Grid 40**. The dots follow it.
- A connection you drag along its busbar snaps to the busbar's centre.
- The end of a branch snaps into line with its other end, so the route runs straight.

Hold Alt to place anything freely. While you drag, the status bar shows how far you have moved, or the length of the busbar.

## Select elements

- To select 1 element, select it. To add to the selection, hold Shift or Ctrl and select more.
- To select by area, drag a marquee over empty space. Dragging to the right selects what lies wholly inside it. Dragging to the left selects whatever it touches, and draws a dashed outline.
- Where elements lie on top of each other, select again at the same spot to pick the one beneath.
- To select by name, press Ctrl+K and type, or select the element in the model tree.
- To select everything, press Ctrl+A (**Select all** on the **Home** tab).

The **Arrange** tab adds selections based on the current one:

- **Select connected** adds a busbar's connections, or an element's busbars.
- **Select same kind** selects every element of the kinds selected.
- **Select voltage level** selects every element at the voltage levels of the selection.

## Arrange busbars and connections

The **Arrange** tab tidies the diagram. Each command is 1 step that you can undo. You can also right-click a selection for the commands that apply.

| Group | Command | What it does |
| --- | --- | --- |
| Align | **Align left**, **Align centres**, **Align right**, **Align top**, **Align middles**, **Align bottom** | Lines the busbars up with the first one you selected. |
| Spacing | **Distribute horizontally**, **Distribute vertically** | Spaces 3 or more busbars evenly. |
| Spacing | **Same length** | Gives the selected busbars the first one's length. |
| Turn | **Rotate** (R) | Turns busbars between horizontal and vertical. |
| Turn | **Flip side** (X) | Moves machines, loads and shunts to the other side of their busbar. |
| Connections | **Spread connections** | Spaces the connections of the selected busbars evenly. |
| Connections | **Lay out diagram** | Lays the whole diagram out again from the network's topology. |

## Shape the route of a line or transformer

A line or transformer has an automatic route that follows its busbars wherever they go. The inspector's **Diagram** group says which kind of route a branch has.

To shape a route by hand:

1. Select the branch. A handle appears on each segment.
2. Drag a segment across itself.

Where a segment meets a busbar, it gets a jog, so the route still leaves the busbar at right angles. To remove a jog, double-click its handle. A route you shaped keeps its bends and stays square to its busbars when they move.

To move the middle segment of an automatic route, select the branch and drag that segment. The route stays automatic and its **Route offset** changes.

On the **Arrange** tab:

- **Route around obstacles** finds, for each selected branch, the route with the fewest bends that crosses no busbar or symbol.
- **Straighten route** makes the routes automatic again.

A line or transformer you draw is routed around a busbar or symbol from the start if its automatic route would cross one.

## Find your way around a large diagram

- **Fit** (F) shows the whole diagram. **Zoom to selection** (Shift+F) fits the selection in the window.
- **Zoom in** and **Zoom out** are on the **View** tab.
- **Pan** (H), or holding Space, moves the view.
- **Overview map** (M, on the **View** tab) draws the whole network with the view as a rectangle. Select or drag in it to move the view there. The map shows by default from 200 busbars.

## Control the labels

PowerStudio places names and result boxes so that none covers another. A label moves along its line or busbar if its usual place is taken. If nothing nearby is free, it moves further and a thin leader line joins it to its element.

Use the **View** tab to choose what shows:

- **Result boxes**, **Names** and **Line names** switch each kind of label on or off.
- **Disentangle labels** (Shift+L) switches the automatic placing on or off. Off puts every label in its fixed place.
- **Colour by results** and **Colour by voltage level** choose how elements are coloured.

To place a label yourself, drag it. It stays there, relative to its element, when the element moves. The inspector's **Diagram** group says how many labels you placed by hand. To go back to automatic placing, select **Reset label positions** on the **View** tab, or right-click a label.

## Cut, copy, paste and delete

- **Copy** (Ctrl+C), **Cut** (Ctrl+X), **Paste** (Ctrl+V) and **Duplicate** (Ctrl+D) are on the **Home** tab.
- Copying a busbar copies the machines, loads and shunts connected to it. A line or transformer copies only if both its busbars are selected.
- Pasted busbars appear 40 units down and to the right, and their names end in "(copy)".
- **Delete** removes the selection. Deleting a busbar also deletes everything connected to it.
- The arrow keys move the selection 1 grid step. With Shift, they move it 5 steps.
- **Switch in or out of service** (Shift+O) switches the selected elements. A busbar cannot be switched out.

## Undo and redo

Every change is 1 step you can undo. Press Ctrl+Z to undo and Ctrl+Shift+Z to redo. Press Escape during a drag to put everything back as it was.

## Check your network before you calculate

Before you run a study, check that:

- every busbar has at least 1 line, transformer or element connected
- every line joins 2 busbars of the same voltage
- each connected part has an **External grid** or a **Reference** machine
- you replaced the typical values with your own data

Then [enter your element data](enter-element-data.md) and run a [load flow](run-a-load-flow.md).
