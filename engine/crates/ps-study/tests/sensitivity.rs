//! DC sensitivities against PowSyBl (goldens from `scripts/oracle/sensitivity.py`): every branch's power transfer
//! distribution factor for a transfer from each generator's bus to the slack bus, on PSS/E reference cases.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use ps_net::{BuildOptions, Calc};

#[test]
fn ptdfs_agree_with_powsybl() {
    let cases = json("tests/oracle/psse-cases.json");
    let mut worst = Worst::default();
    let mut checked = 0;
    for case in cases["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        if !repo(&format!("tests/oracle/golden/sensitivity-{name}.json")).exists() {
            continue;
        }
        let g = golden(&format!("sensitivity-{name}"));
        let model = psse_import(case).model;
        let calc = Calc::build(&model, &ps_topology::Outages::none(), BuildOptions::default());
        let mut dc = ps_lf::DcModel::new(&calc.net).unwrap();
        let slack = calc
            .net
            .machines
            .iter()
            .find(|m| m.mode == ps_lf::MachineMode::Reference)
            .map(|m| m.bus)
            .unwrap();
        let branch_ids: Vec<&str> = g["branches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        for (unit, row) in g["generators"].as_object().unwrap() {
            let k = model.generators.iter().position(|x| x.id == *unit).unwrap();
            let bus = calc.topo.bus_of(model.generators[k].node).unwrap();
            let ptdf = dc.transfer(bus, slack);
            for (j, id) in branch_ids.iter().enumerate() {
                let b = calc
                    .branches
                    .iter()
                    .position(|s| model.id_of(s.class, s.row as usize) == Some(*id))
                    .unwrap();
                worst.check("ptdf", &format!("{name} {id} for {unit}"), ptdf[b], f(&row[j]));
                checked += 1;
            }
        }
    }
    for r in &worst.rows {
        eprintln!("{} {:.1e} at {}", r.0, r.1, r.2);
    }
    assert!(checked > 1000, "only {checked} factors compared");
    assert!(worst.max("ptdf") < 1e-8, "PTDFs differ by {:.1e}", worst.max("ptdf"));
}
