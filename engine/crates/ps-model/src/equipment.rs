//! Equipment records. Values are engineering quantities as operators exchange them: kV, MW, Mvar, MVA, Ω, S, A.
//! Series impedances and shunt admittances are totals for the element (not per kilometre). Transformer impedances are
//! referred to winding 1. Positive susceptance is capacitive.

use serde::{Deserialize, Serialize};

use crate::NodeRef;

/// What a node represents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    /// A bus of a bus-branch model (MATPOWER, PSS/E, drawn networks).
    #[default]
    Bus,
    /// A busbar section of a node-breaker model.
    BusbarSection,
    /// An internal connectivity node of a node-breaker model (between switches).
    Connectivity,
    /// A boundary point where one operator's model meets another's (CGMES boundary nodes).
    Boundary,
}

/// A substation: a group of voltage levels at one site.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Substation {
    /// Stable identifier (CGMES mRID, source id or PowerStudio id).
    pub id: String,
    /// Display name.
    pub name: String,
    /// Region or zone.
    pub region: String,
}

/// A voltage level within a substation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VoltageLevel {
    /// Stable identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Substation index, if any.
    pub substation: Option<u32>,
    /// Nominal voltage, kV.
    pub nominal_kv: f64,
}

/// A connection point: a bus, a busbar section or a connectivity node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    /// Stable identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// What the node is.
    pub kind: NodeKind,
    /// Voltage level index, if any.
    pub voltage_level: Option<u32>,
    /// Nominal voltage, kV (the voltage level's, repeated so bus-branch models need no voltage levels).
    pub nominal_kv: f64,
    /// Lower operational voltage limit, p.u.
    pub v_min: f64,
    /// Upper operational voltage limit, p.u.
    pub v_max: f64,
    /// Area index, if any.
    pub area: Option<u32>,
    /// Starting (or last solved) voltage magnitude, p.u.; 0 when unknown.
    pub v0: f64,
    /// Starting (or last solved) voltage angle, degrees.
    pub angle0: f64,
}

/// The kind of a switching device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SwitchKind {
    /// Circuit breaker.
    #[default]
    Breaker,
    /// Disconnector.
    Disconnector,
    /// Load-break switch.
    LoadBreak,
    /// Fuse.
    Fuse,
    /// Any other switch.
    Other,
}

/// A switching device between two nodes. Closed switches merge their nodes into one calculation bus.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Switch {
    /// Stable identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// First node.
    pub node1: NodeRef,
    /// Second node.
    pub node2: NodeRef,
    /// Device kind.
    pub kind: SwitchKind,
    /// Open state.
    pub open: bool,
}

/// A current limit at one end of a branch.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CurrentLimit {
    /// Branch end (1 or 2; 3 for a third transformer winding).
    pub end: u8,
    /// How long the limit may be applied, seconds; `None` for the permanent limit.
    pub duration_s: Option<f64>,
    /// Current, A.
    pub amps: f64,
}

/// An AC line or cable (π model).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    /// Stable identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// End 1.
    pub node1: NodeRef,
    /// End 2.
    pub node2: NodeRef,
    /// Switched in.
    pub in_service: bool,
    /// Ends disconnected from their node while the line stays in service (it then charges from the other end).
    #[serde(default)]
    pub open: [bool; 2],
    /// Series resistance, Ω.
    pub r: f64,
    /// Series reactance, Ω.
    pub x: f64,
    /// Shunt conductance at end 1, S (half the total for a symmetrical π model).
    pub g1: f64,
    /// Shunt susceptance at end 1, S.
    pub b1: f64,
    /// Shunt conductance at end 2, S.
    pub g2: f64,
    /// Shunt susceptance at end 2, S.
    pub b2: f64,
    /// Zero-sequence resistance, Ω.
    pub r0: f64,
    /// Zero-sequence reactance, Ω.
    pub x0: f64,
    /// Zero-sequence total shunt susceptance, S.
    pub b0: f64,
    /// Length, km (informative; the impedances are already totals).
    pub length_km: f64,
    /// Current limits.
    pub limits: Vec<CurrentLimit>,
}

/// How a transformer winding is connected, for the zero sequence and the phase shift.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Winding {
    /// Star, neutral not earthed.
    Y,
    /// Star, neutral earthed.
    #[default]
    Yn,
    /// Delta.
    D,
    /// Zigzag, neutral not earthed.
    Z,
    /// Zigzag, neutral earthed.
    Zn,
}

/// Voltage control by a tap changer, a shunt or a machine.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VoltageControl {
    /// Whether the control acts in the load flow.
    pub enabled: bool,
    /// The node whose voltage is controlled.
    pub node: NodeRef,
    /// Target, kV.
    pub target_kv: f64,
    /// Dead band (full width), kV.
    pub deadband_kv: f64,
}

/// One position of a tabular tap changer. Ratio and angle replace the stepped values; the corrections change the
/// transformer's series impedance and magnetising admittance at that position.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TapPoint {
    /// Tap position.
    pub position: i32,
    /// Voltage of the tap winding at this position over its rated voltage (1 at rated).
    pub ratio: f64,
    /// Phase shift, degrees, in the tap changer's own sense (see [`PhaseTap`]).
    pub angle_deg: f64,
    /// Change of the series resistance, %.
    pub r_pct: f64,
    /// Change of the series reactance, %.
    pub x_pct: f64,
    /// Change of the magnetising conductance, %.
    pub g_pct: f64,
    /// Change of the magnetising susceptance, %.
    pub b_pct: f64,
}

/// A ratio tap changer on one winding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RatioTap {
    /// Winding the tap changer sits on (1, 2 or 3).
    pub end: u8,
    /// Lowest position.
    pub low: i32,
    /// Highest position.
    pub high: i32,
    /// Position at which the ratio is the rated one.
    pub neutral: i32,
    /// Voltage change per step, % of the winding's rated voltage.
    pub step_pct: f64,
    /// Present position.
    pub position: i32,
    /// Automatic control, if fitted.
    pub control: Option<VoltageControl>,
    /// Ratio and impedance changes per position; when present they replace `step_pct`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub table: Vec<TapPoint>,
}

/// Active power control by a phase-shifting transformer.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FlowControl {
    /// Whether the control acts in the load flow.
    pub enabled: bool,
    /// Target active power at winding 1, MW.
    pub target_mw: f64,
    /// Dead band (full width), MW.
    pub deadband_mw: f64,
}

/// A phase tap changer. Without a table it shifts by a constant angle per step; with one (how importers store
/// symmetrical, asymmetrical and tabular phase shifters) each position has its own angle and ratio. A positive angle
/// makes the other winding lag the tap changer's winding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PhaseTap {
    /// Winding the tap changer sits on (1 or 2).
    pub end: u8,
    /// Lowest position.
    pub low: i32,
    /// Highest position.
    pub high: i32,
    /// Position with no phase shift.
    pub neutral: i32,
    /// Phase shift per step, degrees (winding 2 lags winding 1 for positive values).
    pub step_deg: f64,
    /// Present position.
    pub position: i32,
    /// Automatic control, if fitted.
    pub control: Option<FlowControl>,
    /// Angle, ratio and impedance changes per position; when present they replace `step_deg`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub table: Vec<TapPoint>,
}

/// A two-winding transformer. Series impedance and magnetising admittance are referred to winding 1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Transformer2 {
    /// Stable identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Winding 1 node (normally the HV side).
    pub node1: NodeRef,
    /// Winding 2 node.
    pub node2: NodeRef,
    /// Switched in.
    pub in_service: bool,
    /// Windings disconnected from their node while the transformer stays in service.
    #[serde(default)]
    pub open: [bool; 2],
    /// Rated voltage of winding 1, kV.
    pub rated_kv1: f64,
    /// Rated voltage of winding 2, kV.
    pub rated_kv2: f64,
    /// Rated power, MVA.
    pub rated_mva: f64,
    /// Whether the rated power is only a base for the transformer's data, not a thermal rating (a MATPOWER branch
    /// without a rating): its loading is then judged by its current limits alone.
    #[serde(default)]
    pub unrated: bool,
    /// Series resistance referred to winding 1, Ω.
    pub r: f64,
    /// Series reactance referred to winding 1, Ω.
    pub x: f64,
    /// Magnetising conductance at winding 1, S.
    pub g1: f64,
    /// Magnetising susceptance at winding 1, S (negative: inductive).
    pub b1: f64,
    /// Magnetising conductance at winding 2, referred to winding 1, S.
    pub g2: f64,
    /// Magnetising susceptance at winding 2, referred to winding 1, S.
    pub b2: f64,
    /// Phase displacement as a clock number: winding 2 lags winding 1 by `clock × 30°`.
    pub clock: u8,
    /// Further fixed phase shift, degrees, in the same sense (winding 2 lags for positive values). Carries the
    /// arbitrary angles of bus-branch formats (MATPOWER `SHIFT`, PSS/E `ANG1`).
    pub phase_shift_deg: f64,
    /// Winding 1 connection.
    pub conn1: Winding,
    /// Winding 2 connection.
    pub conn2: Winding,
    /// Zero-sequence series resistance referred to winding 1, Ω.
    pub r0: f64,
    /// Zero-sequence series reactance referred to winding 1, Ω.
    pub x0: f64,
    /// Ratio tap changers, at most one per winding.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ratio_taps: Vec<RatioTap>,
    /// Phase tap changer, if fitted.
    pub phase_tap: Option<PhaseTap>,
    /// Current limits.
    pub limits: Vec<CurrentLimit>,
    /// Its taps change on load (for the correction factor of a power station unit, IEC 60909-0, 6.7).
    #[serde(default)]
    pub on_load_taps: bool,
    /// The tap range used for a power station unit without on-load tap changer, ±%.
    #[serde(default)]
    pub tap_range_pct: f64,
}

/// One winding of a three-winding transformer, with its share of the star-equivalent impedance.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Winding3 {
    /// Node.
    pub node: NodeRef,
    /// Rated voltage, kV.
    pub rated_kv: f64,
    /// Rated power, MVA.
    pub rated_mva: f64,
    /// Star-equivalent resistance referred to this winding, Ω.
    pub r: f64,
    /// Star-equivalent reactance referred to this winding, Ω.
    pub x: f64,
    /// Magnetising conductance of this winding, S at its rated voltage.
    #[serde(default)]
    pub g: f64,
    /// Magnetising susceptance of this winding, S at its rated voltage.
    #[serde(default)]
    pub b: f64,
    /// Clock number of this winding relative to winding 1.
    pub clock: u8,
    /// Further fixed phase shift of this winding, degrees, in the same sense as the clock: the winding's node lags
    /// the star point for positive values. PSS/E `ANG1`…`ANG3` (the bus leads the star point) enter negated.
    #[serde(default)]
    pub phase_shift_deg: f64,
    /// Connection.
    pub conn: Winding,
    /// Disconnected from its node while the transformer stays in service.
    #[serde(default)]
    pub open: bool,
}

/// A three-winding transformer as a star of three windings. Each winding carries its own share of the star impedance
/// and of the magnetising admittance (at the winding's network side, as CGMES gives it per end).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Transformer3 {
    /// Stable identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// The three windings.
    pub windings: [Winding3; 3],
    /// Switched in.
    pub in_service: bool,
    /// Ratio tap changers, at most one per winding.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ratio_taps: Vec<RatioTap>,
    /// Phase tap changers, at most one per winding. A positive angle makes the star point lag the winding.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub phase_taps: Vec<PhaseTap>,
    /// Current limits.
    pub limits: Vec<CurrentLimit>,
}

/// How a machine is dispatched in the load flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum MachineControl {
    /// Active power and voltage held.
    #[default]
    Pv,
    /// Active and reactive power held.
    Pq,
    /// Reference: holds the angle and balances its island.
    Reference,
}

/// Short-circuit data of a synchronous machine (IEC 60909 terms).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MachineShortCircuit {
    /// Subtransient reactance, p.u. of the rating.
    pub xdss: f64,
    /// Stator resistance, p.u. of the rating.
    pub rs: f64,
    /// Rated power factor.
    pub cos_phi: f64,
    /// Neutral earthed (zero sequence).
    pub earthed: bool,
    /// The range over which the machine's voltage is regulated, ±% (pG of IEC 60909-0, 6.6.1).
    #[serde(default)]
    pub pg: f64,
    /// The source meets short circuits as a network feeder with these data instead of as a machine: an equivalent of
    /// an external network that regulates voltage in the load flow, as CGMES external network injections are.
    #[serde(default)]
    pub feeder: Option<Feeder>,
}

/// A network feeder's short-circuit data (IEC 60909-0, 6.2), as an external grid has them.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Feeder {
    /// Initial short-circuit power for maximum currents, MVA.
    pub sk_max: f64,
    /// Initial short-circuit power for minimum currents, MVA.
    pub sk_min: f64,
    /// R/X for maximum currents.
    pub rx_max: f64,
    /// R/X for minimum currents.
    pub rx_min: f64,
    /// X0/X1.
    pub x0x1: f64,
    /// R0/X0.
    pub r0x0: f64,
}

/// A machine's dynamic data: inertia, damping and transient reactance, which every rotor model uses, the rotor model
/// with its data, and the machine's controls.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MachineDynamics {
    /// Transient reactance X′d, p.u. of the rating.
    pub xdt: f64,
    /// Inertia constant, s, on the rating.
    pub h: f64,
    /// Damping, p.u. of the rating.
    pub d: f64,
    /// How the simulation models the rotor.
    pub rotor_model: crate::RotorModel,
    /// Round-rotor data, used when [`Self::rotor_model`] is [`crate::RotorModel::RoundRotor`].
    pub rotor: crate::RoundRotor,
    /// Exciter, governor and stabiliser.
    pub controls: crate::Controls,
}

impl MachineDynamics {
    /// The classical model with the given transient reactance, inertia and damping, typical round-rotor data and no
    /// controls.
    pub const fn classical(xdt: f64, h: f64, d: f64) -> Self {
        Self {
            xdt,
            h,
            d,
            rotor_model: crate::RotorModel::Classical,
            rotor: crate::dynamics::TYPICAL_ROUND_ROTOR,
            controls: crate::Controls::NONE,
        }
    }
}

/// A synchronous machine or other controllable generating unit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Generator {
    /// Stable identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Connection node.
    pub node: NodeRef,
    /// Switched in.
    pub in_service: bool,
    /// Load-flow control.
    pub control: MachineControl,
    /// Active power, MW.
    pub p: f64,
    /// Reactive power (PQ control), Mvar.
    pub q: f64,
    /// Voltage setpoint, p.u. of the regulated node's nominal voltage.
    pub v_set: f64,
    /// Node whose voltage is regulated; `None` for the machine's own node.
    pub regulated_node: Option<NodeRef>,
    /// Angle of a reference machine, degrees.
    pub angle: f64,
    /// Lower reactive power limit, Mvar.
    pub q_min: f64,
    /// Upper reactive power limit, Mvar.
    pub q_max: f64,
    /// Lower active power limit, MW (both limits are 0 when the source gives none).
    pub p_min: f64,
    /// Upper active power limit, MW.
    pub p_max: f64,
    /// Rated power, MVA.
    pub rated_mva: f64,
    /// Rated voltage, kV.
    pub rated_kv: f64,
    /// Share of a distributed slack (0 for none).
    pub participation: f64,
    /// Preference as reference machine of its island: 1 is the first choice, higher numbers later ones, 0 never by
    /// priority (CGMES `referencePriority`).
    #[serde(default)]
    pub reference_priority: u32,
    /// Short-circuit data.
    pub sc: MachineShortCircuit,
    /// Classical dynamic data.
    pub dynamics: MachineDynamics,
    /// The transformer of its power station unit, by identifier: the machine and this transformer meet the short
    /// circuit as one unit (IEC 60909-0, 6.7).
    #[serde(default)]
    pub unit_transformer: Option<String>,
}

/// A load with optional voltage dependence (ZIP).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Load {
    /// Stable identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Connection node.
    pub node: NodeRef,
    /// Switched in.
    pub in_service: bool,
    /// Active power at nominal voltage, MW.
    pub p: f64,
    /// Reactive power at nominal voltage, Mvar.
    pub q: f64,
    /// Shares of constant impedance, current and power in P (summing to 1; `[0, 0, 1]` is constant power).
    pub p_zip: [f64; 3],
    /// Shares of constant impedance, current and power in Q.
    pub q_zip: [f64; 3],
    /// The load is an asynchronous motor (or a group of them) that feeds a short circuit, with its rated data.
    #[serde(default)]
    pub motor: Option<AsyncMotor>,
}

/// An asynchronous motor's rated data, for its contribution to short-circuit currents (IEC 60909-0, 6.8).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AsyncMotor {
    /// Rated mechanical power, MW.
    pub rated_mw: f64,
    /// Rated voltage, kV.
    pub rated_kv: f64,
    /// Rated efficiency, as a fraction.
    pub efficiency: f64,
    /// Rated power factor.
    pub cos_phi: f64,
    /// Locked-rotor current over rated current, ILR/IrM.
    pub ilr: f64,
    /// Locked-rotor resistance over reactance, RM/XM.
    pub rx: f64,
    /// Pairs of poles, for the decay of its breaking current.
    pub pole_pairs: u32,
}

impl AsyncMotor {
    /// Rated apparent power, MVA: the mechanical power over efficiency and power factor.
    pub fn rated_mva(&self) -> f64 {
        self.rated_mw / (self.efficiency * self.cos_phi)
    }
}

/// A switchable shunt compensator (capacitor bank or reactor).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Shunt {
    /// Stable identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Connection node.
    pub node: NodeRef,
    /// Switched in.
    pub in_service: bool,
    /// Voltage at which the per-section values apply, kV.
    pub nominal_kv: f64,
    /// Conductance per section, S.
    pub g_per_section: f64,
    /// Susceptance per section, S (positive: capacitive).
    pub b_per_section: f64,
    /// Sections in service.
    pub sections: u32,
    /// Sections installed.
    pub max_sections: u32,
    /// Automatic voltage control, if fitted.
    pub control: Option<VoltageControl>,
    /// Admittance of each section in turn (G, B in S at the nominal voltage) for a non-linear bank; when present it
    /// replaces the per-section values.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub points: Vec<(f64, f64)>,
}

/// A static var compensator.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Svc {
    /// Stable identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Connection node.
    pub node: NodeRef,
    /// Switched in.
    pub in_service: bool,
    /// Voltage at which the susceptance range applies, kV.
    pub nominal_kv: f64,
    /// Lowest susceptance, S.
    pub b_min: f64,
    /// Highest susceptance, S.
    pub b_max: f64,
    /// Voltage setpoint, p.u.
    pub v_set: f64,
    /// Whether it regulates voltage; otherwise it holds `q`.
    #[serde(default)]
    pub regulating: bool,
    /// Reactive power output when not regulating, Mvar (positive: capacitive, into the network).
    #[serde(default)]
    pub q: f64,
}

/// An external grid: the equivalent of the network beyond the model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExternalGrid {
    /// Stable identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Connection node.
    pub node: NodeRef,
    /// Switched in.
    pub in_service: bool,
    /// Voltage setpoint, p.u.
    pub v_set: f64,
    /// Voltage angle, degrees.
    pub angle: f64,
    /// Maximum short-circuit power, MVA.
    pub sk_max: f64,
    /// Minimum short-circuit power, MVA.
    pub sk_min: f64,
    /// R/X at maximum short-circuit power.
    pub rx_max: f64,
    /// R/X at minimum short-circuit power.
    pub rx_min: f64,
    /// X0/X1.
    pub x0x1: f64,
    /// R0/X0.
    pub r0x0: f64,
}

/// The technology of an HVDC converter station.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ConverterKind {
    /// Line-commutated: it always consumes reactive power, |P|·tan(acos pf).
    #[default]
    Lcc,
    /// Voltage-source: it regulates voltage or holds a reactive power, within limits.
    Vsc,
}

/// An HVDC converter station: where an HVDC link meets the AC network.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Converter {
    /// Stable identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// AC connection node.
    pub node: NodeRef,
    /// Switched in.
    pub in_service: bool,
    /// Technology.
    pub kind: ConverterKind,
    /// Station losses, % of the AC active power through it.
    pub loss_pct: f64,
    /// Power factor of a line-commutated station.
    pub power_factor: f64,
    /// Whether a voltage-source station regulates voltage.
    pub voltage_control: bool,
    /// Voltage setpoint, p.u. of the regulated node's nominal voltage.
    pub v_set: f64,
    /// Node whose voltage is regulated; `None` for the station's own node.
    pub regulated_node: Option<NodeRef>,
    /// Reactive power of a voltage-source station that does not regulate voltage, Mvar (positive into the network).
    pub q: f64,
    /// Lower reactive power limit of a voltage-source station, Mvar.
    pub q_min: f64,
    /// Upper reactive power limit of a voltage-source station, Mvar.
    pub q_max: f64,
}

/// An HVDC link between two converter stations, run at an active power setpoint.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HvdcLine {
    /// Stable identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Switched in.
    pub in_service: bool,
    /// Identifier of the station at end 1.
    pub converter1: String,
    /// Identifier of the station at end 2.
    pub converter2: String,
    /// DC resistance of the line, Ω.
    pub r: f64,
    /// DC voltage, kV.
    pub nominal_kv: f64,
    /// Active power the rectifier draws from its AC network, MW.
    pub p_set: f64,
    /// The rectifying end: 1 or 2.
    pub rectifier: u8,
    /// Largest active power, MW.
    pub p_max: f64,
}

/// A control area with an interchange target.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Area {
    /// Stable identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Net export target, MW (positive: export).
    pub interchange_mw: f64,
    /// Tolerance on the target, MW.
    pub tolerance_mw: f64,
    /// Whether interchange control acts in the load flow (when the study case turns it on).
    pub control: bool,
    /// The area slack: the node whose machines change their active power to hold the interchange.
    #[serde(default)]
    pub slack: Option<NodeRef>,
}
