//! Electromechanical (RMS) simulation.
//!
//! Every synchronous machine is a classical model (a voltage behind its transient reactance) or a round-rotor model
//! (PSS/E GENROU), with optional exciter, governor and stabiliser models from the PSS/E library; external grids are
//! constant voltages behind their short-circuit impedance, and loads constant admittances at their load-flow voltage.
//! [`sim`] solves the machines' equations and the network together with the implicit trapezoidal rule. Model
//! equations are written once over [`scalar::Scalar`], and their Jacobians come from evaluating them with dual
//! numbers. docs/ENGINE.md, "Stability", states the models, their sources and limits.

pub mod block;
pub mod exciter;
pub mod governor;
pub mod machine;
pub mod scalar;
pub mod sim;
pub mod stabiliser;
pub mod unit;

pub use sim::{
    AppliedEvent, EventSteps, MachineTrace, Options, RmsReport, Trajectory, UnitTrajectory, simulate, simulate_detailed,
};
