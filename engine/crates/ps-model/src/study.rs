//! Study case settings: how each calculation runs. Units follow the settings dialog (MVA tolerances, percentages).

use serde::{Deserialize, Serialize};

/// Load flow settings.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LoadFlowSettings {
    /// Largest acceptable power mismatch, MVA.
    pub tolerance: f64,
    /// Newton iterations per reactive-limit round.
    pub max_iter: u32,
    /// Hold machines at their reactive power limits.
    pub enforce_q_limits: bool,
    /// Start the angles from a DC load flow.
    pub dc_start: bool,
    /// Load scaling, % of the loads' values.
    pub load_scale: f64,
}

impl Default for LoadFlowSettings {
    fn default() -> Self {
        Self {
            tolerance: 0.001,
            max_iter: 30,
            enforce_q_limits: false,
            dc_start: true,
            load_scale: 100.0,
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

/// Contingency settings.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ContingencySettings {
    /// Take out lines.
    pub lines: bool,
    /// Take out transformers.
    pub trafos: bool,
    /// Take out generators.
    pub gens: bool,
    /// Loading limit, %.
    pub max_loading: f64,
}

impl Default for ContingencySettings {
    fn default() -> Self {
        Self {
            lines: true,
            trafos: true,
            gens: false,
            max_loading: 100.0,
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
