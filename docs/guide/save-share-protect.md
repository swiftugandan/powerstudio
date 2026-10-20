# Save, share and protect your work

PowerStudio runs in your browser and keeps your work on your device. This chapter explains where your work is kept, how to take a copy and what the app can and cannot protect.

## Check where your work is kept

PowerStudio saves your networks, projects, run logs and results in your browser's storage (IndexedDB) as you work. It saves for the web address you opened the app from, so the hosted app and a downloaded copy do not share networks.

1. Look at the title bar. It says **Saved** when your latest change is kept.
2. To save at once, press Ctrl+S, or open the command palette and select **Save now**.
3. To see the networks kept in this browser, select **File**, then **Open**.

If your browser does not allow storage, the title bar says **This session only**. Your work lasts until you close the tab. Export it to keep it.

The page cannot send your work anywhere. Its security policy forbids every network connection.

## Keep a copy outside the browser

1. Select **File**, then **Export**.
2. Select the kind of copy you want from the table below.
3. Find the file in your browser's downloads.

| Export | What you get |
| --- | --- |
| **Study report** | The study case's results, settings and run records, laid out for print or saving as PDF |
| **Project** | Every study case, scenario and variant, with the run log, in one file |
| **Encrypted project** | The same file, locked with a passphrase |
| **PowerStudio file** | The network as the active study case composes it, with its settings, as JSON |
| **CGMES SSH and SV** | The operating point, for a project imported from CGMES (the card only appears for those projects) |
| **Diagram as SVG** | A vector drawing of the diagram |
| **Diagram as PNG** | A bitmap of the whole diagram |
| **Results table as CSV** | The table shown in the results panel |

To open a **Project** or **PowerStudio file** again, select **File**, then **Import**, then **PowerStudio file or project**. You can also drop the file on the window. It opens as a new network. Nothing is overwritten.

## Print or save a study report

1. Run the calculations you want in the report.
2. Select **File**, then **Export**, then **Study report**.
3. In the print dialog, choose a printer, or choose to save as PDF.

The report covers the active study case. It shows each calculation's key figures, the rows that matter, the settings it ran with and a run record. The run record holds hashes of the model, the settings and the results. The report always prints in the light colour scheme.

Calculations that you have not run are left out. A result marked **Calculated before the last edit** is marked in the report too.

## Move a model to another machine

Use an encrypted project to move a model between machines. It is locked with a passphrase, using AES-256-GCM. The key comes from your passphrase through Argon2id.

1. Select **File**, then **Export**.
2. Select **Encrypted project**.
3. Enter a passphrase of at least 12 characters, then enter it again.
4. Select **Encrypt and export**.

To open the file on the other machine:

1. Select **File**, then **Import**.
2. Select **PowerStudio file or project**, then choose the file.
3. Enter the passphrase and select **Open**.

**Warning.** PowerStudio does not store your passphrase and cannot recover it. If you lose the passphrase, you lose the encrypted file. A wrong passphrase and a changed file give the same message.

## Delete a network from the browser

Delete networks you no longer need, especially on a shared computer.

1. Select **File**, then **Open**.
2. Find the network in the list.
3. Select the delete button beside it. Its tooltip says **Delete from this browser**.
4. Select **Delete** to confirm.

Deleting cannot be undone. Export the network first if you want a copy.

## Know what the app can and cannot see

PowerStudio protects your models in 4 ways:

- **No network access.** The built app forbids every connection, form submission and remote script. A bug or a crafted file cannot send a model anywhere.
- **No code from data.** The app has no `eval` and no remote script. HTML reaches the page only through the app's own policy, which browsers that support Trusted Types enforce.
- **Imported files are data.** The Rust engine parses CGMES, PSS/E, MATPOWER and PowerStudio files. The import gate checks every value before a document opens.
- **Encrypted export.** Your passphrase stays on your device. An encrypted file whose contents were changed does not open.

The protection has limits:

- **Data in the browser is as safe as your device account.** Networks, projects and results are stored unencrypted, like any web app's storage. Anyone who can use your browser profile can read them. Use your operating system's disk encryption and account separation.
- **A compromised device is out of scope.** Malware, a shared account or a stolen unlocked laptop can read your work.
- **Browser extensions can read any page they are allowed on.** A page cannot control this.
- **A downloaded file is only as trustworthy as where it came from.** Check it, as the next section describes.

[Security](../SECURITY.md) describes every protection and its limits in full, including the supply chain.

## Check a downloaded copy

Each release publishes a SHA-256 checksum for `PowerStudio.html` and a GitHub attestation of how it was built.

1. Calculate the SHA-256 of your downloaded `PowerStudio.html`. On a Mac, run `shasum -a 256 PowerStudio.html`.
2. Compare it with the checksum published with the release.
3. To check the attestation, run `gh attestation verify PowerStudio.html --repo swiftugandan/powerstudio`.

Releases are reproducible. With Docker, you can rebuild the engine to the same bytes. A build on another host, such as a Mac, differs. Each release also carries a software bill of materials, which lists the components the engine is built from.

## Report a security problem

Report a security problem privately. Use the repository's **Report a vulnerability** button, which is GitHub private vulnerability reporting. Do not report it in a public issue.

## Read more

- [Work with results](work-with-results.md)
- [Check PowerStudio against your own tool](check-against-your-tool.md)
- [Reference](reference.md)
