//! Electromagnetic transient (EMT) simulation.
//!
//! The network is three-phase: every bus has a node per phase, every element its own terminals behind a three-pole
//! breaker. [`network`] builds the circuit from the load flow's network: lines as travelling waves (Bergeron) or
//! coupled π sections, transformers as ideal transformers per leg with their windings connected as the vector group
//! says, sources as EMFs behind their short-circuit impedance, loads and shunts as admittances. [`transient`] steps
//! it by Dommel's method (trapezoidal companion models, two backward-Euler half steps after every switching), from
//! the circuit's own sinusoidal steady state. [`sim`] applies the events (faults, clearing, switching) and reports
//! waveforms and peaks. docs/ENGINE.md, "Electromagnetic transients", states the models and their limits;
//! docs/design/EMT.md the decisions.

pub mod circuit;
pub mod dense;
pub mod network;
pub mod sim;
pub mod transient;

pub use sim::{
    EmtAppliedEvent, EmtBranch, EmtBus, EmtFaultTrace, EmtReport, EmtSource, Options, PoleOperation, simulate,
};
