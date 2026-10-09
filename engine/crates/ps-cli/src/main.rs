//! `ps`: the PowerStudio engine on the command line.
//!
//! ```text
//! ps lf <case.m> [--tol <p.u.>] [--qlim] [--flat]   solve a MATPOWER case, print a JSON summary
//! ps bench <case.m> [--repeat <n>]                   time ordering, factorisation and full solves
//! ```

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(out) => {
            #[allow(clippy::print_stdout)]
            {
                println!("{out}");
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("ps: {e}");
            ExitCode::FAILURE
        }
    }
}

fn flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn value(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn run(args: &[String]) -> Result<String, String> {
    let cmd = args
        .first()
        .ok_or("usage: ps <lf|bench> <case.m> [options]")?;
    let path = args.get(1).ok_or("missing case file")?;
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let t_parse = ps_num::clock::now_ms();
    let case = ps_io::matpower::parse(&text).map_err(|e| e.to_string())?;
    let parse_ms = ps_num::clock::now_ms() - t_parse;
    let conv = ps_bridge::from_matpower(&case);
    let tol = value(args, "--tol")
        .map(|s| s.parse::<f64>())
        .transpose()
        .map_err(|e| e.to_string())?
        .unwrap_or(1e-8);
    let opt = ps_lf::Options {
        tolerance: tol,
        enforce_q_limits: flag(args, "--qlim"),
        dc_start: !flag(args, "--flat") && !flag(args, "--warm"),
        warm_start: flag(args, "--warm"),
        ..Default::default()
    };
    match cmd.as_str() {
        "lf" => {
            let sol = ps_lf::solve(&conv.net, &opt);
            let buses: Vec<serde_json::Value> = conv
                .bus_numbers
                .iter()
                .enumerate()
                .map(|(i, &n)| serde_json::json!([n, sol.vm[i], sol.va[i] * ps_num::DEG]))
                .collect();
            Ok(serde_json::json!({
                "case": case.name, "buses": conv.net.buses.len(), "branches": conv.net.branches.len(),
                "converged": sol.converged, "message": sol.message, "iterations": sol.iterations, "mismatch": sol.mismatch,
                "timing": { "parse_ms": parse_ms, "analyse_ms": sol.timing.analyse_ms, "factor_solve_ms": sol.timing.factor_solve_ms, "total_ms": sol.timing.total_ms },
                "bus": buses,
            })
            .to_string())
        }
        "bench" => {
            let repeat = value(args, "--repeat")
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(5);
            let mut totals = Vec::new();
            let mut last = None;
            for _ in 0..repeat {
                let sol = ps_lf::solve(&conv.net, &opt);
                totals.push(sol.timing);
                last = Some(sol);
            }
            let sol = last.ok_or("no runs")?;
            let best = totals
                .iter()
                .map(|t| t.total_ms)
                .fold(f64::INFINITY, f64::min);
            let mean = totals.iter().map(|t| t.total_ms).sum::<f64>() / totals.len() as f64;
            Ok(serde_json::json!({
                "case": case.name, "buses": conv.net.buses.len(), "branches": conv.net.branches.len(),
                "converged": sol.converged, "iterations": sol.iterations, "parse_ms": parse_ms,
                "solve_ms_best": best, "solve_ms_mean": mean,
                "analyse_ms": sol.timing.analyse_ms, "factor_solve_ms": sol.timing.factor_solve_ms,
            })
            .to_string())
        }
        other => Err(format!("unknown command {other}")),
    }
}
