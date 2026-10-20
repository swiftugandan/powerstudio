# Import a model from another tool

If your network already exists in another tool, you can open it in PowerStudio instead of drawing it. This chapter shows you which formats PowerStudio reads, how to import them, and how to check the result.

PowerStudio imports 4 kinds of file: CGMES models, PSS/E RAW files (with DYR files for dynamic data), MATPOWER cases, and PowerStudio's own files and projects. An imported network opens as a new network. Nothing you already have is overwritten.

## Before you start

Find out which format you have, and collect every file it needs.

| Format | Versions | Files to select together |
| --- | --- | --- |
| CGMES | 2.4.15 and 3.0 | The EQ, TP, SSH and SV files, and the boundary set, as XML files or ZIP archives |
| PSS/E RAW | 32, 33 and 35, bus-branch or node-breaker | The `.raw` file, and its `.dyr` file if you want the machines' dynamic models |
| MATPOWER | Case files of version 2, from the MATPOWER power flow toolbox | The `.m` file |
| PowerStudio | Files and projects, including encrypted ones | The `.json` file |

CGMES, the Common Grid Model Exchange Standard, is the format European transmission operators use to share models. A CGMES model splits into profiles. EQ is the equipment and TP the topology. SSH is the steady-state hypothesis (set points and switching) and SV the state variables (the solved voltages). PowerStudio also reads the DL and GL profiles. The files can come in any order.

## Import a file

1. Go to the **File** tab.
2. Select **Import**.
3. Select the card for your format: **PowerStudio file or project**, **CGMES model**, **PSS/E RAW and DYR files** or **MATPOWER case**.
4. In the file chooser, select all the files for the model.

You can also drop the files anywhere on the window. Or press Ctrl+Shift+O, which is **Import file** on the **Insert** tab. That file chooser accepts `.json`, `.xml`, `.zip`, `.raw` and `.m` files only. To bring in a DYR file with its RAW file, use the **File** page or drop both files on the window.

For a PowerStudio file, the network opens at once. For any other format, PowerStudio reads the files first and then shows the import dialog.

## Read the import dialog

The dialog is titled with the file's name, or with the number of files. It opens before the network does, so you can stop if the result is not what you expect.

The first line gives the format, how many nodes, branches, sources and loads PowerStudio read, and how long it took.

Below it, a status says how closely PowerStudio's network matches the source. PowerStudio solves a load flow on the imported model and on the network it built, and compares the voltages.

| Status | What it means |
| --- | --- |
| **Exact** | The voltages agree to within a tiny tolerance. |
| **Check** | The voltages differ. The message gives the largest difference and where it is. Read the notes below. |
| **Differs** | PowerStudio's network does not reach the imported model's solution. |

If the imported model's own load flow does not converge, the dialog says PowerStudio could not check the network against it.

Open the sections below the status to see more:

- **Validation** lists errors and warnings about the source model. Read any errors before you continue.
- **Simplified for the editor** lists what the diagram changes, such as joining busbars.
- **Notes from the import** lists anything PowerStudio filled in or left out.
- **What was read** is a table of every class in the files and how many there are. It says whether PowerStudio used the class, mapped it to something else or did not use it.

Select **Open network** to import the model, or **Cancel** to stop.

## Check the imported network

After the import, the network opens as a new network, laid out automatically. A message appears with the number of elements. The notes go to the **Output** tab.

1. Read the **Output** tab for notes and warnings.
2. Select **Fit** (F) on the **View** tab to see the whole diagram.
3. Run a load flow (Alt+L).
4. Compare the voltages and flows with your source tool's results.

The diagram simplifies what the editor's 7 kinds of element cannot hold:

- Closed switches join their busbars into 1 busbar.
- A 3-winding transformer becomes a star busbar with 3 transformers.
- A static var compensator becomes a machine without active power that holds its voltage.
- A DC converter station becomes the fixed injection its set point gives.
- A shunt with uneven sections keeps its present admittance.

The dialog's status tells you how closely the simplified network matches the source model's load flow.

## Know what each format brings

**CGMES.**

- Machines, external networks, loads, shunts, static var compensators and power electronics connections come across, with their regulating controls.
- Short-circuit data come across where the files give them, for example the subtransient reactance and the transformer earthing.
- PowerStudio reads the vector group clock but does not apply it. The import report says so.
- A project imported from CGMES can write its operating point back into the same files. Go to **File**, then **Export**, and select **CGMES SSH and SV**. That card shows only for CGMES projects.

**PSS/E RAW and DYR.**

- A DYR file sets the dynamic models of the machines. PowerStudio reads the machine, exciter, governor and stabiliser models of its library. A model outside the library is listed as not used, and the machine keeps its classical model.
- PowerStudio does not model multi-terminal DC lines, series FACTS devices, induction machines or impedance correction tables. The import report counts what it left out.

**MATPOWER.**

- A MATPOWER case has no zero-sequence, machine or inertia data. PowerStudio fills them with stated typical values and lists them in the notes. Short-circuit, stability and EMT results from a MATPOWER import therefore use typical values.
- A branch with a RATE_A of 0 has no rating. A transformer like that has **Rated power limits loading** switched off, and PowerStudio does not report its loading.

**PowerStudio files and projects.**

- A `.powerstudio.json` file is 1 network. A `.powerstudio-project.json` file is a whole project: every study case, scenario and variant, with the run log.
- If the file is encrypted, PowerStudio asks for the passphrase. Type it and select **Open**. A wrong passphrase gives an error and asks again.

## Set up the study case after an import

PowerStudio sets the study case where the file shows how it was solved. If in-service machines sit at a reactive power limit in the file's own solution, the study case respects reactive power limits. The dialog tells you why. Without the limits, those machines would hold voltages they cannot reach.

Check the study case settings (Ctrl+,) before a short circuit, stability or EMT study. Then continue with [Enter element data](enter-element-data.md) to replace typical values with your own, and [Set up study cases, scenarios and variants](set-up-study-cases.md).

## If something goes wrong

| Problem | What to do |
| --- | --- |
| **Import failed** appears | Read the message and the **Output** tab. Check you selected every file of the model together. |
| A CGMES model shows few elements | Check you selected the EQ, TP, SSH and SV files and the boundary set. |
| The status is **Differs** or **Check** | Read **Simplified for the editor** and **Notes from the import**. Some differences come from simplifying a 3-winding transformer or a converter station. |
| A model you expect is missing busbars | Look in **Validation** and the **Load flow** tab. Parts without a source are left out as de-energised. |
| The load flow does not converge | The network may need a good starting point. PowerStudio starts from the imported voltages, then from its own last solution. |
| A machine keeps its classical model after a DYR import | Its DYR model is outside the library. The notes list it. |

For what each importer maps, and how it is checked against other tools, see [the calculation engine](../ENGINE.md#opening-other-tools-files-in-the-app).
