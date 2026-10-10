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
    /// Control areas hold their net export at their targets with their slack buses' machines.
    pub area_interchange: bool,
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
            area_interchange: false,
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

/// A condition of a remedial action, on the post-contingency solution.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Condition {
    /// A branch's loading is above a value, %.
    #[serde(rename_all = "camelCase")]
    Loading {
        /// Branch identifier.
        element: String,
        /// Threshold, %.
        above: f64,
    },
    /// A node's voltage is below a value, p.u.
    #[serde(rename_all = "camelCase")]
    VoltageBelow {
        /// Node identifier.
        node: String,
        /// Threshold, p.u.
        below: f64,
    },
    /// A node's voltage is above a value, p.u.
    #[serde(rename_all = "camelCase")]
    VoltageAbove {
        /// Node identifier.
        node: String,
        /// Threshold, p.u.
        above: f64,
    },
    /// The contingency takes out this element.
    #[serde(rename_all = "camelCase")]
    Outage {
        /// Element identifier.
        element: String,
    },
}

/// An action of a remedial action.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Action {
    /// Switches an element in or out of service (a switch: closes or opens it).
    #[serde(rename_all = "camelCase")]
    Switch {
        /// Element identifier.
        element: String,
        /// In service (closed) after the action.
        in_service: bool,
    },
    /// Sets a generator's active power, MW.
    #[serde(rename_all = "camelCase")]
    Generation {
        /// Generator identifier.
        element: String,
        /// Active power after the action, MW.
        p: f64,
    },
    /// Sets a transformer's tap position (its first tap changer, ratio or phase).
    #[serde(rename_all = "camelCase")]
    Tap {
        /// Transformer identifier.
        element: String,
        /// Position after the action.
        position: i32,
    },
    /// Reduces a load by a share of its active and reactive power, %.
    #[serde(rename_all = "camelCase")]
    LoadShed {
        /// Load identifier.
        element: String,
        /// Share shed, %.
        percent: f64,
    },
}

/// A remedial action: when every condition holds on a contingency's solution, its actions apply and the contingency
/// is solved again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RemedialAction {
    /// Identifier, unique within the study case.
    pub id: String,
    /// Display name.
    pub name: String,
    /// The contingencies it is considered for; empty for every one.
    pub contingencies: Vec<String>,
    /// Conditions, all of which must hold.
    pub conditions: Vec<Condition>,
    /// Actions, applied together.
    pub actions: Vec<Action>,
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
    /// Fault each busbar: its protection opens every switch around it and everything connected there goes out.
    pub busbars: bool,
    /// Loading limit, %.
    pub max_loading: f64,
    /// How long an overload after an outage may last before operators act, seconds: a branch is judged against the
    /// largest of its limits that holds at least that long (its permanent limit always does). 0 judges against
    /// permanent limits only.
    pub acceptable_s: f64,
    /// Further contingencies, such as several elements failing together.
    pub list: Vec<Contingency>,
    /// Estimate each single-branch outage linearly first and solve it in full only when the estimate comes within
    /// the margins of a limit.
    pub screening: bool,
    /// Loading margin of screening, % of the loading limit: an outage whose estimate loads a branch above
    /// (100 − margin) % of the limit is solved in full.
    pub screening_margin: f64,
    /// Voltage margin of screening, p.u.: an outage whose estimate brings a voltage within this of its band's edge
    /// is solved in full.
    pub screening_voltage: f64,
    /// Remedial actions, considered in order on each contingency's solution.
    pub remedial: Vec<RemedialAction>,
}

impl Default for ContingencySettings {
    fn default() -> Self {
        Self {
            lines: true,
            trafos: true,
            gens: false,
            hvdc: false,
            busbars: false,
            max_loading: 100.0,
            acceptable_s: 0.0,
            list: Vec::new(),
            screening: false,
            screening_margin: 5.0,
            screening_voltage: 0.01,
            remedial: Vec::new(),
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
