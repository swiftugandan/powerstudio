//! Study case settings: how each calculation runs. Units follow the settings dialog (MVA tolerances, percentages).

use serde::{Deserialize, Serialize};

/// How an island's active power imbalance is shared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Balance {
    /// The reference machine (or external grid) takes all of it.
    #[default]
    Reference,
    /// Machines in proportion to their maximum active power.
    MaxP,
    /// Machines in proportion to their present active power.
    TargetP,
    /// Machines in proportion to their participation factors.
    Factor,
    /// Machines in proportion to their remaining margin.
    Margin,
    /// Loads in proportion to their active power.
    Load,
}

/// Load flow settings.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LoadFlowSettings {
    /// Largest acceptable power mismatch, MVA.
    pub tolerance: f64,
    /// Newton iterations per solve.
    pub max_iter: u32,
    /// Hold machines at their reactive power limits.
    pub enforce_q_limits: bool,
    /// Start the angles from a DC load flow.
    pub dc_start: bool,
    /// Load scaling, % of the loads' values.
    pub load_scale: f64,
    /// How each island's imbalance is shared.
    pub balance: Balance,
    /// Largest imbalance left on the reference after distribution, MW.
    pub slack_tolerance: f64,
    /// Machines regulate the busbar their data names (otherwise their own terminals).
    pub remote_voltage: bool,
    /// Loads follow their voltage characteristics (otherwise every load is constant power).
    pub voltage_dependent_loads: bool,
    /// Tap changers regulate voltage.
    pub tap_control: bool,
    /// Switched shunts regulate voltage.
    pub shunt_control: bool,
    /// Phase shifters regulate active power flow.
    pub phase_control: bool,
}

impl Default for LoadFlowSettings {
    fn default() -> Self {
        Self {
            tolerance: 0.001,
            max_iter: 30,
            enforce_q_limits: false,
            dc_start: true,
            load_scale: 100.0,
            balance: Balance::Reference,
            slack_tolerance: 0.001,
            remote_voltage: true,
            voltage_dependent_loads: true,
            tap_control: false,
            shunt_control: false,
            phase_control: false,
        }
    }
}

impl LoadFlowSettings {
    /// Every control off: machines hold their own terminals, loads are constant power, nothing moves. The reference
    /// comparisons with control-free goldens use it.
    pub fn plain() -> Self {
        Self {
            remote_voltage: false,
            voltage_dependent_loads: false,
            ..Self::default()
        }
    }
}

/// Short-circuit fault type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum FaultType {
    /// Three-phase.
    #[default]
    #[serde(rename = "3ph")]
    ThreePhase,
    /// Line-to-line.
    #[serde(rename = "2ph")]
    LineToLine,
    /// Line-to-earth.
    #[serde(rename = "1ph")]
    LineToEarth,
}

/// Maximum or minimum short-circuit currents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ScMode {
    /// Maximum currents (cmax, KT applied).
    #[default]
    Max,
    /// Minimum currents (cmin).
    Min,
}

/// How the peak factor κ is found in meshed networks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum KappaMethod {
    /// Method B: uniform ratio R/X with a 1.15 safety factor.
    B,
    /// Method C: equivalent frequency.
    #[default]
    C,
}

/// Voltage tolerance of low-voltage networks, which sets the voltage factor c.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum LvTolerance {
    /// +6 %.
    #[serde(rename = "6")]
    Six,
    /// +10 %.
    #[default]
    #[serde(rename = "10")]
    Ten,
}

/// Short-circuit settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ShortCircuitSettings {
    /// Fault type.
    pub fault: FaultType,
    /// Maximum or minimum.
    pub mode: ScMode,
    /// Peak factor method.
    pub kappa: KappaMethod,
    /// LV voltage tolerance.
    pub lv_tolerance: LvTolerance,
    /// Identifier of the faulted node; empty for a fault at every node in turn.
    pub location: String,
}

/// A contingency: elements that fail together, by identifier.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Contingency {
    /// Identifier, unique within the study case.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Identifiers of the elements that fail.
    pub elements: Vec<String>,
}

/// Contingency analysis settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ContingencySettings {
    /// Take out lines.
    pub lines: bool,
    /// Take out transformers.
    pub trafos: bool,
    /// Take out generators.
    pub gens: bool,
    /// Take out HVDC links.
    pub hvdc: bool,
    /// Loading limit, %.
    pub max_loading: f64,
    /// How long an overload after an outage may last before operators act, seconds: a branch is judged against the
    /// largest of its limits that holds at least that long (its permanent limit always does). 0 judges against
    /// permanent limits only.
    pub acceptable_s: f64,
    /// Further contingencies, such as several elements failing together.
    pub list: Vec<Contingency>,
}

impl Default for ContingencySettings {
    fn default() -> Self {
        Self {
            lines: true,
            trafos: true,
            gens: false,
            hvdc: false,
            max_loading: 100.0,
            acceptable_s: 0.0,
            list: Vec::new(),
        }
    }
}

/// What a simulation event does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EventKind {
    /// Three-phase fault at a node.
    Fault,
    /// Clears the fault at a node.
    Clear,
    /// Switches out a machine, branch or load.
    Trip,
    /// Sets a load to a percentage of its initial power.
    Loadstep,
}

/// A simulation event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimEvent {
    /// Time, s.
    pub t: f64,
    /// What happens.
    pub kind: EventKind,
    /// Identifier of the element concerned.
    pub target: String,
    /// Load step value, %.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
}

/// Stability (RMS) settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RmsSettings {
    /// Simulated time, s.
    pub t_end: f64,
    /// Step size, s.
    pub dt: f64,
    /// Events in time order.
    pub events: Vec<SimEvent>,
}

impl Default for RmsSettings {
    fn default() -> Self {
        Self {
            t_end: 3.0,
            dt: 0.001,
            events: Vec::new(),
        }
    }
}

/// A study case: settings for every calculation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct StudyCase {
    /// Load flow.
    pub loadflow: LoadFlowSettings,
    /// Short circuit.
    pub shortcircuit: ShortCircuitSettings,
    /// Contingency analysis.
    pub contingency: ContingencySettings,
    /// Stability.
    pub rms: RmsSettings,
}
