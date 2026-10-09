//! Electromechanical (RMS) simulation.
//!
//! [`classical`] is the classical model: every synchronous machine is a constant voltage E′ behind its transient
//! reactance whose angle follows the swing equation, external grids are constant voltages behind their short-circuit
//! impedance, and loads become constant admittances at their load-flow voltage. The network is solved algebraically
//! at every stage of a fourth-order Runge-Kutta step. docs/ENGINE.md, "Stability", states the model and its limits.

pub mod classical;
