//! Short circuit against IEC TR 60909-4's example network, as pandapower's test suite encodes it
//! (tests/oracle/sc-cases.json; scripts/oracle/iec60909.py writes the goldens). Each golden holds the network in
//! pandapower's terms, which this test turns into a model, the values the test asserts (taken from the report), and
//! pandapower's own results. The engine must meet the report's values to the test's own tolerances, and pandapower's
//! at every bus. With `PS_SC_REPORT` set it prints the worst differences, and the breaking currents the report lists.
//!
//! The report's breaking currents Ib (listed in the test, not asserted by pandapower, which does not compute them)
//! are checked where they depend on synchronous machines only: F1, F4 and F8 in the network, F9 and F10 at the
//! machines' terminals, to 0.01 kA. Where asynchronous motors contribute (F2, F3, F5 to F7) the decay of a motor's
//! current depends on its pole pairs, which pandapower's encoding does not carry; without them the engine takes no
//! decay (q = 1), so Ib there must not fall below the report's value.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use ps_model::study::{FaultType, KappaMethod, ScMode, ShortCircuitSettings};
use ps_model::{
    AsyncMotor, ExternalGrid, Generator, Line, Load, MachineControl, Model, Node, NodeRef, Transformer2, Transformer3,
    Winding, Winding3,
};
use serde_json::Value;

fn num(v: &Value, key: &str) -> f64 {
    v[key].as_f64().unwrap_or_else(|| panic!("{key} in {v}"))
}

fn opt(v: &Value, key: &str) -> Option<f64> {
    v[key].as_f64()
}

/// Connection of each winding from a pandapower vector group such as `YNyd`.
fn connections(group: &str) -> Vec<Winding> {
    let mut out = Vec::new();
    let chars: Vec<char> = group.chars().take_while(|c| c.is_alphabetic()).collect();
    let mut k = 0;
    while k < chars.len() {
        let c = chars[k].to_ascii_uppercase();
        let earthed = chars.get(k + 1).is_some_and(|n| n.eq_ignore_ascii_case(&'n'));
        out.push(match (c, earthed) {
            ('Y', true) => Winding::Yn,
            ('Y', false) => Winding::Y,
            ('Z', true) => Winding::Zn,
            ('Z', false) => Winding::Z,
            _ => Winding::D,
        });
        k += if earthed { 2 } else { 1 };
    }
    out
}

/// The model of a golden's network.
fn model_of(net: &Value) -> Model {
    let mut m = Model::new("TR 60909-4");
    m.meta.base_mva = num(net, "sn_mva");
    m.meta.frequency_hz = num(net, "f_hz");
    let rows = |key: &str| net[key].as_array().unwrap().iter().filter(|r| r["in_service"] != false);
    let node = |bus: f64| NodeRef(bus as u32);
    for b in net["bus"].as_array().unwrap() {
        m.nodes.push(Node {
            id: format!("N{}", b["index"]),
            nominal_kv: num(b, "vn_kv"),
            ..Default::default()
        });
    }
    for g in rows("ext_grid") {
        let rx = num(g, "rx_max");
        m.external_grids.push(ExternalGrid {
            id: format!("X{}", g["index"]),
            node: node(num(g, "bus")),
            in_service: true,
            v_set: 1.0,
            sk_max: num(g, "s_sc_max_mva"),
            sk_min: opt(g, "s_sc_min_mva").unwrap_or(num(g, "s_sc_max_mva")),
            rx_max: rx,
            rx_min: opt(g, "rx_min").unwrap_or(rx),
            x0x1: opt(g, "x0x_max").unwrap_or(1.0),
            r0x0: opt(g, "r0x0_max").unwrap_or(0.1),
            ..Default::default()
        });
    }
    for t in rows("trafo") {
        let (uh, sn) = (num(t, "vn_hv_kv"), num(t, "sn_mva"));
        let zb = uh * uh / sn;
        let (z, r) = (num(t, "vk_percent") / 100.0 * zb, num(t, "vkr_percent") / 100.0 * zb);
        let (z0, r0) = (
            opt(t, "vk0_percent").map_or(z, |v| v / 100.0 * zb),
            opt(t, "vkr0_percent").map_or(r, |v| v / 100.0 * zb),
        );
        let conn = connections(t["vector_group"].as_str().unwrap_or("Yy"));
        // pandapower's neutral reactance belongs to the earthed star winding.
        let xn = opt(t, "xn_ohm").unwrap_or(0.0);
        let earthed_hv = matches!(conn.first(), Some(Winding::Yn | Winding::Zn));
        m.transformers2.push(Transformer2 {
            id: format!("T{}", t["index"]),
            node1: node(num(t, "hv_bus")),
            node2: node(num(t, "lv_bus")),
            in_service: true,
            rated_kv1: uh,
            rated_kv2: num(t, "vn_lv_kv"),
            rated_mva: sn,
            r,
            x: (z * z - r * r).sqrt(),
            conn1: conn.first().copied().unwrap_or(Winding::Y),
            conn2: conn.get(1).copied().unwrap_or(Winding::Y),
            phase_shift_deg: opt(t, "shift_degree").unwrap_or(0.0),
            on_load_taps: t["oltc"] == true,
            tap_range_pct: opt(t, "pt_percent").unwrap_or(0.0),
            r0,
            x0: (z0 * z0 - r0 * r0).max(0.0).sqrt(),
            rn: [0.0; 2],
            xn: if earthed_hv { [xn, 0.0] } else { [0.0, xn] },
            ..Default::default()
        });
    }
    for t in rows("trafo3w") {
        // pandapower's vk_hv is the HV-MV pair, vk_mv the MV-LV pair, vk_lv the HV-LV pair, each on the smaller
        // rating of its pair; on the HV voltage, then to a star, then each winding on its own voltage.
        let u = [num(t, "vn_hv_kv"), num(t, "vn_mv_kv"), num(t, "vn_lv_kv")];
        let s = [num(t, "sn_hv_mva"), num(t, "sn_mv_mva"), num(t, "sn_lv_mva")];
        let pair = |vk: &str, vkr: &str, a: usize, b: usize| {
            let zb = u[0] * u[0] / s[a].min(s[b]);
            let (z, r) = (num(t, vk) / 100.0 * zb, num(t, vkr) / 100.0 * zb);
            (r, (z * z - r * r).sqrt())
        };
        let half = |a: (f64, f64), b: (f64, f64), c: (f64, f64)| (0.5 * (a.0 + b.0 - c.0), 0.5 * (a.1 + b.1 - c.1));
        let star_of = |zero: &str| {
            let key = |kind: &str, side: &str| format!("{kind}{zero}_{side}_percent");
            let (hm, ml, hl) = (
                pair(&key("vk", "hv"), &key("vkr", "hv"), 0, 1),
                pair(&key("vk", "mv"), &key("vkr", "mv"), 1, 2),
                pair(&key("vk", "lv"), &key("vkr", "lv"), 0, 2),
            );
            [half(hm, hl, ml), half(hm, ml, hl), half(hl, ml, hm)]
        };
        let star = star_of("");
        // The reduced networks give no zero-sequence data: the positive sequence stands in.
        let star0 = if opt(t, "vk0_hv_percent").is_some() {
            star_of("0")
        } else {
            star
        };
        let conn = connections(t["vector_group"].as_str().unwrap_or("Yyy"));
        let bus = [num(t, "hv_bus"), num(t, "mv_bus"), num(t, "lv_bus")];
        let winding = |w: usize| Winding3 {
            node: node(bus[w]),
            rated_kv: u[w],
            rated_mva: s[w],
            r: star[w].0 * (u[w] / u[0]).powi(2),
            x: star[w].1 * (u[w] / u[0]).powi(2),
            r0: star0[w].0 * (u[w] / u[0]).powi(2),
            x0: star0[w].1 * (u[w] / u[0]).powi(2),
            conn: conn.get(w).copied().unwrap_or(Winding::Y),
            ..Default::default()
        };
        m.transformers3.push(Transformer3 {
            id: format!("T3-{}", t["index"]),
            windings: [winding(0), winding(1), winding(2)],
            in_service: true,
            ..Default::default()
        });
    }
    for l in rows("line") {
        let len = num(l, "length_km") * opt(l, "parallel").unwrap_or(1.0).recip();
        m.lines.push(Line {
            id: format!("L{}", l["index"]),
            node1: node(num(l, "from_bus")),
            node2: node(num(l, "to_bus")),
            in_service: true,
            r: num(l, "r_ohm_per_km") * len,
            x: num(l, "x_ohm_per_km") * len,
            r0: opt(l, "r0_ohm_per_km").unwrap_or(num(l, "r_ohm_per_km")) * len,
            x0: opt(l, "x0_ohm_per_km").unwrap_or(num(l, "x_ohm_per_km")) * len,
            length_km: num(l, "length_km"),
            ..Default::default()
        });
    }
    for g in rows("gen") {
        let (vn, sn) = (num(g, "vn_kv"), num(g, "sn_mva"));
        let mut machine = Generator {
            id: format!("G{}", g["index"]),
            node: node(num(g, "bus")),
            in_service: true,
            control: MachineControl::Pv,
            p: num(g, "p_mw"),
            v_set: 1.0,
            rated_mva: sn,
            rated_kv: vn,
            unit_transformer: opt(g, "power_station_trafo").map(|t| format!("T{}", t as i64)),
            ..Default::default()
        };
        machine.sc.xdss = num(g, "xdss_pu");
        machine.sc.rs = num(g, "rdss_ohm") / (vn * vn / sn);
        machine.sc.cos_phi = num(g, "cos_phi");
        machine.sc.pg = opt(g, "pg_percent").unwrap_or(0.0);
        m.generators.push(machine);
    }
    for mo in rows("motor") {
        m.loads.push(Load {
            id: format!("M{}", mo["index"]),
            node: node(num(mo, "bus")),
            in_service: true,
            motor: Some(AsyncMotor {
                rated_mw: num(mo, "pn_mech_mw"),
                rated_kv: num(mo, "vn_kv"),
                efficiency: num(mo, "efficiency_n_percent") / 100.0,
                cos_phi: num(mo, "cos_phi_n"),
                ilr: num(mo, "lrc_pu"),
                rx: num(mo, "rx"),
                // pandapower's encoding of the network has no pole pairs, so q is 1 (no decay of the motors' own
                // currents).
                pole_pairs: 0,
            }),
            ..Default::default()
        });
    }
    m
}

#[test]
fn the_tr_60909_4_example_meets_the_reports_values() {
    let cases = json("tests/oracle/sc-cases.json");
    let report = std::env::var("PS_SC_REPORT").is_ok();
    let mut failures = Vec::new();
    for case in cases["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let golden = golden(&format!("sc-{name}"));
        let model = model_of(&golden["network"]);
        let st = ShortCircuitSettings {
            fault: match case["fault"].as_str() {
                Some("2ph") => FaultType::LineToLine,
                Some("1ph") => FaultType::LineToEarth,
                _ => FaultType::ThreePhase,
            },
            mode: if case["case"] == "min" {
                ScMode::Min
            } else {
                ScMode::Max
            },
            kappa: KappaMethod::C,
            t_min: 0.1,
            line_temperature: case["changes"]["line_endtemp_degree"].as_f64().unwrap_or(80.0),
            ..Default::default()
        };
        let res = ps_study::shortcircuit::run(&model, &st);
        let at = |bus: usize| res.buses.iter().find(|b| b.id == format!("N{bus}")).unwrap();
        let value = |bus: usize, column: &str| {
            let b = at(bus);
            match column {
                "ikss_ka" => b.ikss,
                "ip_ka" => b.ip,
                "skss_mw" => b.skss,
                "ith_ka" => b.ith,
                c => panic!("column {c}"),
            }
        };
        // The report's values, to the tolerances pandapower's test asserts.
        for e in golden["expected"].as_array().unwrap() {
            let column = e["column"].as_str().unwrap();
            let atol = f(&e["atol"]);
            let mut worst = (0.0_f64, 0usize);
            for (bus, want) in e["values"].as_array().unwrap().iter().map(f).enumerate() {
                // pandapower's encoding earths transformer T6's 10 kV star point solidly where the report earths it
                // through 100 Ω, so its earth faults at F6 and F7 are not the report's (MiniGrid has the earthing;
                // its test checks those two).
                if case["fault"] == "1ph" && (bus == 5 || bus == 6) {
                    continue;
                }
                let d = (value(bus, column) - want).abs();
                if d > worst.0 {
                    worst = (d, bus);
                }
            }
            if report {
                eprintln!(
                    "{name}: {column} worst {:.2e} at bus {} (tolerance {atol})",
                    worst.0, worst.1
                );
            }
            if worst.0 > atol {
                failures.push(format!(
                    "{name}: {column} at bus {} differs from the report's value by {:.2e} (tolerance {atol})",
                    worst.1, worst.0
                ));
            }
        }
        // pandapower's own results at every bus, for Ik″, ip and Sk″. One bus differs by design: in the reduced
        // network without its generator, pandapower keeps the generator's transformer flagged as a unit transformer
        // and leaves it uncorrected; the engine knows a unit by its machine, so the lone transformer takes KT.
        for (bus, r) in golden["results"].as_object().unwrap() {
            let bus: usize = bus.parse().unwrap();
            if name == "tr60909-4-small-no-gen" && bus == 6 {
                continue;
            }
            for (column, tol) in [("ikss_ka", 1e-6), ("ip_ka", 1e-6), ("skss_mw", 1e-4)] {
                if let Some(want) = r[column].as_f64() {
                    let d = (value(bus, column) - want).abs();
                    if d > tol * want.abs().max(1.0) {
                        failures.push(format!(
                            "{name}: {column} at bus {bus} is {} against pandapower's {want}",
                            value(bus, column)
                        ));
                    }
                }
            }
        }
        // The report's peak currents for earth faults, which pandapower's test leaves out, from MiniGrid's workbook
        // (its sheet of the report's line-to-earth values, F2 to F5 by node code).
        if name == "tr60909-4-1ph-max" {
            for want in minigrid_sheet(3).iter().filter(|w| w.ip.is_finite()) {
                let bus: usize = want.code.parse::<usize>().unwrap() - 1;
                let got = at(bus).ip;
                if report {
                    eprintln!("{name}: ip at F{} {got:.4} report {}", want.code, want.ip);
                }
                if (got - want.ip).abs() > 1e-4 * want.ip {
                    failures.push(format!(
                        "{name}: ip at F{} is {got:.4} kA, the report's {}",
                        want.code, want.ip
                    ));
                }
            }
        }
        if name == "tr60909-4-3ph-max" {
            let ib: Vec<f64> = golden["listed"]["ib"].as_array().unwrap().iter().map(f).collect();
            for (bus, &want) in ib.iter().enumerate() {
                let got = at(bus).ib;
                let machines_only = [0, 3, 7, 8, 9].contains(&bus);
                if machines_only && (got - want).abs() > 0.01 {
                    failures.push(format!(
                        "{name}: Ib at F{} is {got:.4} kA, the report's {want}",
                        bus + 1
                    ));
                }
                if !machines_only && got < want - 0.001 {
                    failures.push(format!(
                        "{name}: Ib at F{} is {got:.4} kA, below the report's {want}",
                        bus + 1
                    ));
                }
            }
        }
        if report {
            for (list, values) in golden["listed"].as_object().unwrap() {
                if list.starts_with("ib") {
                    let ours: Vec<String> = (0..values.as_array().unwrap().len())
                        .map(|b| format!("{:.4}", at(b).ib))
                        .collect();
                    eprintln!("{name}: {list} listed {values}\n    engine {}", ours.join(", "));
                }
            }
            for w in &res.warnings {
                eprintln!("  warning: {w}");
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The editor holds a three-winding transformer as a star busbar with three two-winding transformers, and power
/// station units, motors and the transformers' tap data as fields of its elements. Written as a document and read
/// back, the example network must give the same currents: the windings at the star get KT per winding pair, as the
/// three-winding transformer did, and the units and motors survive the round trip.
#[test]
fn the_example_gives_the_same_currents_after_a_round_trip_through_a_document() {
    for name in ["tr60909-4-3ph-max", "tr60909-4-3ph-min", "tr60909-4-2ph-max"] {
        let golden = golden(&format!("sc-{name}"));
        let model = model_of(&golden["network"]);
        let converted = ps_io::powerstudio_write::to_document(&model);
        let read = ps_io::powerstudio::from_value(&converted.doc).expect("the written document reads back");
        assert!(
            read.model.transformers3.is_empty(),
            "{name}: the document holds the star as two-winding transformers"
        );
        let st = ShortCircuitSettings {
            fault: if name.contains("2ph") {
                FaultType::LineToLine
            } else {
                FaultType::ThreePhase
            },
            mode: if name.contains("min") { ScMode::Min } else { ScMode::Max },
            kappa: KappaMethod::C,
            ..Default::default()
        };
        let before = ps_study::shortcircuit::run(&model, &st);
        let after = ps_study::shortcircuit::run(&read.model, &st);
        // The three-winding transformers' star points are buses of the original model without a node.
        for b in &before.buses {
            let Some(node) = model.nodes.iter().position(|n| n.id == b.id) else {
                continue;
            };
            let bus = converted.bus_of_node[node].as_deref().expect("every node is written");
            let a = after
                .buses
                .iter()
                .find(|x| x.id == bus)
                .unwrap_or_else(|| panic!("{name}: {bus} after the round trip"));
            for (what, x, y) in [("Ik″", b.ikss, a.ikss), ("ip", b.ip, a.ip), ("Ib", b.ib, a.ib)] {
                assert!(
                    (x - y).abs() <= 1e-9 * x.abs().max(1.0),
                    "{name}: {what} at {} is {y} after the round trip, {x} before",
                    b.id
                );
            }
        }
        assert!(after.warnings.is_empty(), "{name}: {:?}", after.warnings);
    }
}

/// The cells of one worksheet of an .xlsx workbook, row by row, with shared strings resolved; `entries` are the
/// workbook's files, under `prefix`.
fn worksheet(entries: &[ps_io::zip::Entry], prefix: &str, sheet: usize) -> Vec<Vec<String>> {
    let text = |name: &str| {
        let name = format!("{prefix}{name}");
        String::from_utf8(
            entries
                .iter()
                .find(|e| e.name == name)
                .unwrap_or_else(|| panic!("{name}"))
                .data
                .clone(),
        )
        .unwrap()
    };
    let shared: Vec<String> = text("xl/sharedStrings.xml")
        .split("<si>")
        .skip(1)
        .map(|s| strip_tags(s.split("</si>").next().unwrap()))
        .collect();
    let xml = text(&format!("xl/worksheets/sheet{sheet}.xml"));
    xml.split("<row ")
        .skip(1)
        .map(|row| {
            row.split("<c ")
                .skip(1)
                .filter_map(|c| {
                    let v = c.split("<v>").nth(1)?.split("</v>").next()?;
                    Some(if c.split('>').next()?.contains("t=\"s\"") {
                        shared[v.parse::<usize>().ok()?].clone()
                    } else {
                        v.to_string()
                    })
                })
                .collect()
        })
        .collect()
}

/// Text without its XML tags.
fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    for c in s.chars() {
        match c {
            '<' => inside = true,
            '>' => inside = false,
            c if !inside => out.push(c),
            _ => {}
        }
    }
    out
}

/// Fault results per node of the MiniGrid workbook's sheet: node code, CIM identifier (when the sheet gives it),
/// Ik″, ip and Ib in kA.
struct SheetResult {
    code: String,
    cim: Option<String>,
    ikss: f64,
    ip: f64,
    ib: f64,
}

fn sheet_results(rows: &[Vec<String>]) -> Vec<SheetResult> {
    let mut out: Vec<SheetResult> = Vec::new();
    let mut section = "";
    for r in rows {
        let (Some(head), second) = (r.first().map(String::as_str), r.get(1).map(String::as_str)) else {
            continue;
        };
        match head {
            "NodeCode:" => out.push(SheetResult {
                code: second.unwrap_or_default().to_string(),
                cim: None,
                ikss: f64::NAN,
                ip: f64::NAN,
                ib: f64::NAN,
            }),
            "CIM ID: " => {
                if let Some(last) = out.last_mut() {
                    last.cim = second.map(|c| c.trim_start_matches('_').to_string());
                }
            }
            h if h.starts_with('#') => section = h,
            "Phase A:" => {
                let Some(last) = out.last_mut() else { continue };
                let value = |k: usize| r.get(k).and_then(|v| v.parse::<f64>().ok()).unwrap_or(f64::NAN);
                match section {
                    "#Current at fault location" if last.ikss.is_nan() => last.ikss = value(3),
                    "#Peal Short Circuit" => last.ip = value(1),
                    "#Braking Short Circuit" => last.ib = value(1),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    out
}

/// The fault results of one sheet of MiniGrid's results workbook, read from the cached CGMES 3.0 archive: 3 and 4 the
/// report's values for line-to-earth and three-phase faults, 5 and 6 a tool's with each node's CIM identifier.
fn minigrid_sheet(sheet: usize) -> Vec<SheetResult> {
    let cases = json("tests/oracle/cgmes-cases.json");
    let archive = repo(&format!(
        ".cache/reference/{}",
        cases["archives"]["cgmes-3.0.3"]["file"].as_str().unwrap()
    ));
    let bytes = std::fs::read(&archive).unwrap_or_else(|e| {
        panic!(
            "{}: {e}. Run node scripts/fetch-reference.mjs first.",
            archive.display()
        )
    });
    let book = "CGMES_ConformityAssessmentScheme_TestConfigurations_v3-0-3/v3.0/MiniGrid/MiniGrid-RESULTS.xlsx";
    let entries = ps_io::zip::read_matching(&bytes, &[book]).unwrap();
    sheet_results(&worksheet(&entries, &format!("{book}/"), sheet))
}

/// The TopologicalNode of every ConnectivityNode, from the case's TP file.
fn topological_nodes(files: &[ps_io::files::File]) -> std::collections::HashMap<String, String> {
    let tp = files.iter().find(|f| f.name.ends_with("_TP.xml")).expect("a TP file");
    let text = String::from_utf8_lossy(&tp.data);
    let mut out = std::collections::HashMap::new();
    for block in text.split("<cim:ConnectivityNode ").skip(1) {
        let block = block.split("</cim:ConnectivityNode>").next().unwrap_or_default();
        let id = block
            .split('"')
            .nth(1)
            .unwrap_or_default()
            .trim_start_matches('#')
            .trim_start_matches('_');
        if let Some(tn) = block.split("ConnectivityNode.TopologicalNode rdf:resource=\"").nth(1) {
            let tn = tn
                .split('"')
                .next()
                .unwrap_or_default()
                .trim_start_matches('#')
                .trim_start_matches('_');
            out.insert(id.to_string(), tn.to_string());
        }
    }
    out
}

/// MiniGrid, CGMES's conformity configuration of the same example network, imported from its files: machines, units,
/// motors, feeders and neutral earthing come from CGMES's short-circuit attributes. The results workbook that comes
/// with it lists the report's values (sheets 3 and 4, line-to-earth and three-phase) and a tool's results with the
/// CIM identifier of each node (sheets 5 and 6), all read from the cached archive. Every location is also faulted in
/// the network written as a document and read back, which must give the same currents.
///
/// One datum differs from the report: MiniGrid rates machine G2 at 150 MVA where the report (and pandapower's
/// encoding, in the golden) has 100 MVA. The test takes the report's rating. With it, three-phase Ik″ and ip meet the
/// report's values to 1e-4 at every location. Ib meets them to 0.1 % where only synchronous machines contribute and to
/// 0.25 % at the motors' busbars (F6, F7), where the engine's Ib is the lower by 0.14 and 0.21 %. Earth-fault Ik″
/// meets them to 1e-3: MiniGrid's zero-sequence data for the three-winding transformers differ a little from the
/// report's.
#[test]
fn minigrid_from_cgmes_meets_the_reports_values() {
    let cases = json("tests/oracle/cgmes-cases.json");
    let case = cases["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "minigrid-3")
        .unwrap();
    let files = cgmes_files(case);
    let mut model = ps_io::cgmes::import(&files).unwrap().model;
    let report_g2 = f(&golden("sc-tr60909-4-3ph-max")["network"]["gen"][1]["sn_mva"]);
    for g in model.generators.iter_mut().filter(|g| g.name == "G2") {
        g.rated_mva = report_g2;
    }
    let report = minigrid_sheet(4);
    let tool = minigrid_sheet(6);
    let tn_of = topological_nodes(&files);
    let print = std::env::var("PS_SC_REPORT").is_ok();
    let mut failures = Vec::new();
    // The editor's form of the same network, as the app opens it.
    let converted = ps_io::powerstudio_write::to_document(&model);
    let document = ps_io::powerstudio::from_value(&converted.doc).unwrap().model;
    assert_eq!(tool.len(), 8, "the workbook lists eight fault locations");
    for t in &tool {
        let tn = t.cim.as_deref().unwrap();
        let node = model
            .nodes
            .iter()
            .find(|n| tn_of.get(&n.id).is_some_and(|x| x == tn))
            .unwrap_or_else(|| panic!("F{}: no node", t.code));
        let st = ShortCircuitSettings {
            kappa: KappaMethod::C,
            location: node.id.clone(),
            ..Default::default()
        };
        let res = ps_study::shortcircuit::run(&model, &st);
        let b = &res.buses[0];
        let k = model.nodes.iter().position(|n| n.id == node.id).unwrap();
        let in_document = ps_study::shortcircuit::run(
            &document,
            &ShortCircuitSettings {
                location: converted.bus_of_node[k].clone().unwrap(),
                ..st.clone()
            },
        );
        let d = &in_document.buses[0];
        if (d.ikss - b.ikss).abs() > 1e-9 * b.ikss || (d.ib - b.ib).abs() > 1e-9 * b.ib {
            failures.push(format!(
                "F{}: the document gives Ik″ {} and Ib {}, the model {} and {}",
                t.code, d.ikss, d.ib, b.ikss, b.ib
            ));
        }
        let want = report.iter().find(|x| x.code == t.code).unwrap();
        if print {
            eprintln!(
                "F{:>2} Ik″ {:8.4} report {:8.4} | ip {:8.4} report {:8.4} | Ib {:8.4} report {:8.4}",
                t.code, b.ikss, want.ikss, b.ip, want.ip, b.ib, want.ib
            );
        }
        let motors = ["6", "7"].contains(&t.code.as_str());
        for (what, got, want, rel) in [
            ("Ik″", b.ikss, want.ikss, 1e-4),
            ("ip", b.ip, want.ip, 1e-4),
            ("Ib", b.ib, want.ib, if motors { 2.5e-3 } else { 1e-3 }),
        ] {
            if (got - want).abs() > rel * want {
                failures.push(format!("F{}: {what} is {got:.4} kA, the report's {want}", t.code));
            }
        }
    }
    // Line-to-earth faults: the report's values (sheet 3) at the locations the tool lists with their CIM identifiers
    // (sheet 5).
    let report = minigrid_sheet(3);
    let tool = minigrid_sheet(5);
    for t in &tool {
        let Some(want) = report.iter().find(|x| x.code == t.code) else {
            continue;
        };
        let tn = t.cim.as_deref().unwrap();
        let k = model
            .nodes
            .iter()
            .position(|n| tn_of.get(&n.id).is_some_and(|x| x == tn))
            .unwrap_or_else(|| panic!("F{}: no node", t.code));
        let st = ShortCircuitSettings {
            fault: FaultType::LineToEarth,
            kappa: KappaMethod::C,
            location: model.nodes[k].id.clone(),
            ..Default::default()
        };
        let b = ps_study::shortcircuit::run(&model, &st).buses.remove(0);
        let d = ps_study::shortcircuit::run(
            &document,
            &ShortCircuitSettings {
                location: converted.bus_of_node[k].clone().unwrap(),
                ..st.clone()
            },
        )
        .buses
        .remove(0);
        if print {
            eprintln!(
                "F{:>2} earth Ik″ {:8.4} report {:8.4} document {:8.4} | ip {:8.4} report {:8.4}",
                t.code, b.ikss, want.ikss, d.ikss, b.ip, want.ip
            );
        }
        if (d.ikss - b.ikss).abs() > 1e-9 * b.ikss {
            failures.push(format!(
                "F{}: the document gives an earth-fault Ik″ of {}, the model {}",
                t.code, d.ikss, b.ikss
            ));
        }
        // MiniGrid's zero-sequence data for the three-winding transformers differ a little from the report's, which
        // pandapower's encoding of them meets to 1e-4 (the first test); so 1e-3 here.
        if (b.ikss - want.ikss).abs() > 1e-3 * want.ikss {
            failures.push(format!(
                "F{}: earth-fault Ik″ is {:.4} kA, the report's {}",
                t.code, b.ikss, want.ikss
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
