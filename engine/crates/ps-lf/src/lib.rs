//! Load flow on a per-unit bus-branch network.
//!
//! The input is a [`PuNetwork`]: energised calculation buses with their per-unit base voltages, branches reduced to
//! two-port admittances in the MATPOWER convention, and the machines, grids, loads and shunts that inject at the buses.
//! The canonical model compiles to this form after topology processing; importers for bus-branch formats can build it
//! directly.
//!
//! [`solve`] runs Newton-Raphson in polar coordinates on a sparse Jacobian, started from a DC load flow, with remote
//! and shared voltage control and voltage-dependent loads in the equations, and distributed slack, reactive limits,
//! tap changers and switched shunts as outer loops. [`branch_flows`] turns a solution into flows and currents.

mod control;
mod dc;
mod discrete;
mod equations;
mod flows;
mod init;
mod network;
mod newton;
mod ybus;

pub use dc::dc_angles;
pub use flows::{BranchFlow, branch_flows, bus_injections};
pub use network::{
    BusKind, MachineMode, PuBranch, PuBus, PuGrid, PuLoad, PuMachine, PuNetwork, PuShunt, PuShuntControl, PuTapBranch,
    TapAxis, TapTarget, TwoPort, UnitKind, nominal_angles, two_port,
};
pub use newton::{Balance, Control, ControlLog, IterationLog, Options, Solution, Timing, UnitOutput, solve};
pub use ybus::Ybus;
