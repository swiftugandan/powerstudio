# PowerStudio guide

PowerStudio is a power system workbench that runs in a browser tab. You draw or import a network, then study it with load flow, short circuit, contingency, stability and electromagnetic transient (EMT) calculations.

This guide shows you how to do each task. Each chapter starts from what you want to do, tells you which data you need, and then takes you through the steps.

If you are new to PowerStudio, start with chapter 1. It takes about 30 minutes and uses the IEEE 14-bus sample that comes with the app.

## Choose a chapter

1. [Get started](get-started.md): a first session on the IEEE 14-bus sample, from load flow to EMT.
2. [Build your network](build-your-network.md): draw busbars, lines, transformers, sources and loads, and arrange the diagram.
3. [Enter element data](enter-element-data.md): fill in the data of each element, and see which data each study needs.
4. [Import a model from another tool](import-a-model.md): open CGMES, PSS/E RAW and DYR, and MATPOWER files.
5. [Set up study cases, scenarios and variants](set-up-study-cases.md): study the same network under different conditions.
6. [Run a load flow](run-a-load-flow.md): find voltages, flows, losses and loadings.
7. [Find fault levels](find-fault-levels.md): calculate short-circuit currents at every busbar or at one.
8. [Check the network survives outages](check-outages.md): run an N-1 contingency analysis.
9. [Check machines stay in step](check-stability.md): simulate a fault and its clearing.
10. [Look at the first cycles of a fault or switching](look-at-emt.md): read waveforms from an EMT simulation.
11. [Work with results](work-with-results.md): use tables, charts, run comparisons and exports.
12. [Save, share and protect your work](save-share-protect.md): keep copies and lock them with a passphrase.
13. [Check PowerStudio against your own tool](check-against-your-tool.md): compare results on your own model.
14. [Reference](reference.md): keyboard shortcuts and a glossary of terms.

## Use this guide

- Names in **bold** are labels exactly as the app shows them. You select them.
- Keyboard shortcuts are for Windows and Linux. On a Mac, use ⌘ for Ctrl and ⌥ for Alt.
- Each chapter explains a technical term the first time it appears. The [glossary](reference.md) lists them all.
- Everything happens on your device. PowerStudio does not upload your networks or results.
- The short circuit calculation is IEC 60909-style. It follows the method of IEC 60909-0 but is not certified against the standard.
- The EMT simulation shows the first cycles of a disturbance. It is not a grid code compliance tool.

## Find more detail

- [The calculation engine](../ENGINE.md) explains what each calculation computes and how it is checked.
- The [reference](reference.md) lists every keyboard shortcut. You can also press ? in the app.
