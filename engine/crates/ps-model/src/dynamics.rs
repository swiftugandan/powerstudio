//! Dynamic data of synchronous machines for the stability simulation: the rotor model and the machine's controls
//! (exciter, governor, power system stabiliser).
//!
//! A control is a model kind and its parameters in the order a PSS/E DYR record lists them, under the names the PSS/E
//! model library uses. The same list is the DYR import and export and the document's field names, so a model's data
//! is written down once ([`ControllerKind::params`]); `src/core/catalog.js` gives each parameter its label and default,
//! and a test keeps the two lists equal.

use serde::{Deserialize, Serialize};

/// How the stability simulation models a machine's rotor and stator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RotorModel {
    /// A constant voltage behind the transient reactance X′d (PSS/E GENCLS).
    #[default]
    Classical,
    /// Round rotor with transient and subtransient circuits on both axes and quadratic saturation (PSS/E GENROU).
    RoundRotor,
}

/// Round-rotor data (PSS/E GENROU), p.u. of the machine's rating and seconds. The transient reactance X′d is
/// [`crate::MachineDynamics::xdt`], the subtransient reactance X″d (equal to X″q) is
/// [`crate::MachineShortCircuit::xdss`] and the stator resistance is [`crate::MachineShortCircuit::rs`], so the short
/// circuit and the stability simulation read the same values.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundRotor {
    /// Synchronous reactance, d axis.
    pub xd: f64,
    /// Synchronous reactance, q axis.
    pub xq: f64,
    /// Transient reactance, q axis.
    pub xqt: f64,
    /// Stator leakage reactance.
    pub xl: f64,
    /// Open-circuit transient time constant, d axis, s.
    pub td0t: f64,
    /// Open-circuit subtransient time constant, d axis, s.
    pub td0s: f64,
    /// Open-circuit transient time constant, q axis, s.
    pub tq0t: f64,
    /// Open-circuit subtransient time constant, q axis, s.
    pub tq0s: f64,
    /// Saturation at 1.0 p.u. air-gap flux, S(1.0).
    pub s10: f64,
    /// Saturation at 1.2 p.u. air-gap flux, S(1.2).
    pub s12: f64,
}

/// Typical round-rotor data, used where a machine has none.
pub const TYPICAL_ROUND_ROTOR: RoundRotor = RoundRotor {
    xd: 1.8,
    xq: 1.7,
    xqt: 0.55,
    xl: 0.15,
    td0t: 6.5,
    td0s: 0.03,
    tq0t: 0.4,
    tq0s: 0.05,
    s10: 0.0,
    s12: 0.0,
};

impl Default for RoundRotor {
    fn default() -> Self {
        TYPICAL_ROUND_ROTOR
    }
}

/// Which of a machine's controls a model is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Slot {
    /// Excitation system: sets the field voltage.
    Exciter,
    /// Turbine and governor: sets the mechanical power.
    Governor,
    /// Power system stabiliser: adds a signal to the exciter's voltage reference.
    Stabiliser,
}

/// A control model of the library, by its PSS/E name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ControllerKind {
    /// Simplified excitation system.
    #[serde(rename = "SEXS")]
    Sexs,
    /// IEEE type 1 excitation system (1968).
    #[serde(rename = "IEEET1")]
    Ieeet1,
    /// IEEE type DC2 excitation system (1981).
    #[serde(rename = "EXDC2")]
    Exdc2,
    /// IEEE 421.5 type DC2A excitation system (2005).
    #[serde(rename = "ESDC2A")]
    Esdc2a,
    /// IEEE type ST1 excitation system (1981).
    #[serde(rename = "EXST1")]
    Exst1,
    /// IEEE 421.5 type ST1A excitation system (2005).
    #[serde(rename = "ESST1A")]
    Esst1a,
    /// IEEE 421.5 type ST3A excitation system (2005).
    #[serde(rename = "ESST3A")]
    Esst3a,
    /// Steam turbine governor.
    #[serde(rename = "TGOV1")]
    Tgov1,
    /// IEEE type 1 speed-governing model.
    #[serde(rename = "IEEEG1")]
    Ieeeg1,
    /// Hydro turbine governor.
    #[serde(rename = "HYGOV")]
    Hygov,
    /// IEEE stabiliser.
    #[serde(rename = "IEEEST")]
    Ieeest,
    /// Dual-input stabiliser.
    #[serde(rename = "ST2CUT")]
    St2cut,
}

impl ControllerKind {
    /// Every model, exciters first, then governors and stabilisers.
    pub const ALL: [ControllerKind; 12] = [
        Self::Sexs,
        Self::Ieeet1,
        Self::Exdc2,
        Self::Esdc2a,
        Self::Exst1,
        Self::Esst1a,
        Self::Esst3a,
        Self::Tgov1,
        Self::Ieeeg1,
        Self::Hygov,
        Self::Ieeest,
        Self::St2cut,
    ];

    /// The PSS/E model name.
    pub fn name(self) -> &'static str {
        match self {
            Self::Sexs => "SEXS",
            Self::Ieeet1 => "IEEET1",
            Self::Exdc2 => "EXDC2",
            Self::Esdc2a => "ESDC2A",
            Self::Exst1 => "EXST1",
            Self::Esst1a => "ESST1A",
            Self::Esst3a => "ESST3A",
            Self::Tgov1 => "TGOV1",
            Self::Ieeeg1 => "IEEEG1",
            Self::Hygov => "HYGOV",
            Self::Ieeest => "IEEEST",
            Self::St2cut => "ST2CUT",
        }
    }

    /// The model with a PSS/E name, ignoring case and surrounding blanks.
    pub fn from_name(name: &str) -> Option<Self> {
        let name = name.trim();
        Self::ALL.into_iter().find(|k| k.name().eq_ignore_ascii_case(name))
    }

    /// Which control the model is.
    pub fn slot(self) -> Slot {
        match self {
            Self::Sexs | Self::Ieeet1 | Self::Exdc2 | Self::Esdc2a | Self::Exst1 | Self::Esst1a | Self::Esst3a => {
                Slot::Exciter
            }
            Self::Tgov1 | Self::Ieeeg1 | Self::Hygov => Slot::Governor,
            Self::Ieeest | Self::St2cut => Slot::Stabiliser,
        }
    }

    /// The parameters in DYR order (integer parameters, ICONs, first). Machine-base per unit and seconds.
    pub fn params(self) -> &'static [&'static str] {
        const DC: &[&str] = &[
            "TR", "KA", "TA", "TB", "TC", "VRMAX", "VRMIN", "KE", "TE", "KF", "TF1", "SWITCH", "E1", "SE1", "E2", "SE2",
        ];
        match self {
            Self::Sexs => &["TA/TB", "TB", "K", "TE", "EMIN", "EMAX"],
            Self::Ieeet1 => &[
                "TR", "KA", "TA", "VRMAX", "VRMIN", "KE", "TE", "KF", "TF", "SWITCH", "E1", "SE1", "E2", "SE2",
            ],
            Self::Exdc2 | Self::Esdc2a => DC,
            Self::Exst1 => &[
                "TR", "VIMAX", "VIMIN", "TC", "TB", "KA", "TA", "VRMAX", "VRMIN", "KC", "KF", "TF",
            ],
            // The order of OpenIPSL's ESST1A, which ANDES's DYR table does not follow (docs/research/sources.md).
            Self::Esst1a => &[
                "UEL", "VOS", "TR", "VIMAX", "VIMIN", "TC", "TB", "TC1", "TB1", "KA", "TA", "VAMAX", "VAMIN", "VRMAX",
                "VRMIN", "KC", "KF", "TF", "KLR", "ILR",
            ],
            Self::Esst3a => &[
                "TR", "VIMAX", "VIMIN", "KM", "TC", "TB", "KA", "TA", "VRMAX", "VRMIN", "KG", "KP", "KI", "VBMAX",
                "KC", "XL", "VGMAX", "THETAP", "TM", "VMMAX", "VMMIN",
            ],
            Self::Tgov1 => &["R", "T1", "VMAX", "VMIN", "T2", "T3", "DT"],
            Self::Ieeeg1 => &[
                "IBUS", "IM", "K", "T1", "T2", "T3", "UO", "UC", "PMAX", "PMIN", "T4", "K1", "K2", "T5", "K3", "K4",
                "T6", "K5", "K6", "T7", "K7", "K8",
            ],
            Self::Hygov => &[
                "R", "r", "TR", "TF", "TG", "VELM", "GMAX", "GMIN", "TW", "AT", "DTURB", "QNL",
            ],
            Self::Ieeest => &[
                "MODE", "BUSR", "A1", "A2", "A3", "A4", "A5", "A6", "T1", "T2", "T3", "T4", "T5", "T6", "KS", "LSMAX",
                "LSMIN", "VCU", "VCL",
            ],
            Self::St2cut => &[
                "MODE", "BUSR", "MODE2", "BUSR2", "K1", "K2", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9",
                "T10", "LSMAX", "LSMIN", "VCU", "VCL",
            ],
        }
    }

    /// Typical values, one per parameter, each set copied from a published case (docs/research/sources.md): EXDC2
    /// and TGOV1 from Kundur's two-area system, ESDC2A from the WECC 179-bus system, EXST1, ESST3A, IEEEG1, IEEEST
    /// and ST2CUT (the machine at bus 2) from the IEEE 14-bus system as ANDES publishes them, SEXS from ANDES's Kundur case with SEXS
    /// exciters, IEEET1, ESST1A and HYGOV from ANDES's IEEE 14-bus cases with those models.
    pub fn defaults(self) -> &'static [f64] {
        match self {
            Self::Sexs => &[0.4, 5.0, 20.0, 0.83, 0.0, 5.0],
            Self::Ieeet1 => &[0.02, 5.0, 0.04, 7.3, -7.3, 1.0, 0.8, 0.1, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0],
            Self::Exdc2 => &[
                0.02, 20.0, 0.02, 1.0, 1.0, 5.2, -4.16, 1.0, 0.83, 0.0754, 1.246, 0.0, 0.0, 0.0, 1.0, 1.0,
            ],
            Self::Esdc2a => &[
                0.02, 50.0, 0.05, 0.02, 0.0, 0.0, -3.0, 0.0, 0.512, 0.07, 1.3, 0.0, 3.9825, 0.5, 5.31, 1.049,
            ],
            Self::Exst1 => &[
                0.02, 99.0, -99.0, 0.0, 0.02, 50.0, 0.02, 9999.0, -9999.0, 0.0, 0.01, 1.0,
            ],
            Self::Esst1a => &[
                1.0, 1.0, 0.01, 0.8, -0.1, 1.0, 1.0, 1.0, 1.0, 80.0, 0.04, 999.0, -999.0, 7.3, -7.3, 0.1, 0.1, 1.0,
                1.0, 1.0,
            ],
            Self::Esst3a => &[
                0.02, 0.2, -0.2, 8.0, 1.0, 5.0, 20.0, 0.0, 99.0, -99.0, 1.0, 3.67, 0.435, 5.48, 0.01, 0.0098, 3.86,
                3.33, 0.4, 99.0, 0.0,
            ],
            Self::Tgov1 => &[0.05, 0.49, 33.0, 0.4, 2.1, 7.0, 0.0],
            Self::Ieeeg1 => &[
                0.0, 0.0, 20.0, 0.1, 0.0, 0.2, 1.0, -1.0, 0.95, 0.0, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.3, 0.0, 8.72,
                0.7, 0.0,
            ],
            Self::Hygov => &[0.05, 1.0, 1.0, 0.05, 0.05, 0.3, 0.45001, 0.0, 1.0, 1.0, 0.0, 0.1],
            Self::Ieeest => &[
                3.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.75, 1.0, 4.2, -2.0, 0.1, -0.1, 0.0, 0.0,
            ],
            Self::St2cut => &[
                1.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 3.0, 3.0, 0.15, 0.05, 0.15, 0.05, 0.15, 0.05, 0.05, -0.05,
                0.0, 0.0,
            ],
        }
    }

    /// How many leading parameters are integers (PSS/E ICONs).
    pub fn integer_params(self) -> usize {
        match self {
            Self::Ieeeg1 | Self::Ieeest | Self::Esst1a => 2,
            Self::St2cut => 4,
            _ => 0,
        }
    }
}

/// One control of a machine: its model and parameters in [`ControllerKind::params`] order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Controller {
    /// The model.
    pub kind: ControllerKind,
    /// Parameter values, one per name in [`ControllerKind::params`].
    pub values: Vec<f64>,
}

impl Controller {
    /// A parameter's value by its PSS/E name, or zero when the model has no such parameter.
    pub fn get(&self, name: &str) -> f64 {
        self.kind
            .params()
            .iter()
            .position(|p| *p == name)
            .and_then(|k| self.values.get(k).copied())
            .unwrap_or(0.0)
    }
}

/// A machine's controls. A machine without an exciter keeps its field voltage, without a governor its mechanical
/// power.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Controls {
    /// Excitation system.
    pub exciter: Option<Controller>,
    /// Turbine and governor.
    pub governor: Option<Controller>,
    /// Power system stabiliser (acts through the exciter).
    pub stabiliser: Option<Controller>,
}

impl Controls {
    /// No controls.
    pub const NONE: Controls = Controls {
        exciter: None,
        governor: None,
        stabiliser: None,
    };

    /// The control in a slot.
    pub fn slot(&self, slot: Slot) -> Option<&Controller> {
        match slot {
            Slot::Exciter => self.exciter.as_ref(),
            Slot::Governor => self.governor.as_ref(),
            Slot::Stabiliser => self.stabiliser.as_ref(),
        }
    }

    /// The control in a slot, to change.
    pub fn slot_mut(&mut self, slot: Slot) -> &mut Option<Controller> {
        match slot {
            Slot::Exciter => &mut self.exciter,
            Slot::Governor => &mut self.governor,
            Slot::Stabiliser => &mut self.stabiliser,
        }
    }

    /// Whether the machine has any control.
    pub fn is_empty(&self) -> bool {
        self.exciter.is_none() && self.governor.is_none() && self.stabiliser.is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip_and_slots_are_grouped() {
        for k in ControllerKind::ALL {
            assert_eq!(
                ControllerKind::from_name(&format!(" {} ", k.name().to_lowercase())),
                Some(k)
            );
            assert!(k.params().len() > k.integer_params());
            assert_eq!(k.defaults().len(), k.params().len(), "{}", k.name());
        }
        assert_eq!(ControllerKind::from_name("GENROU"), None);
    }

    #[test]
    fn get_reads_by_name() {
        let c = Controller {
            kind: ControllerKind::Tgov1,
            values: vec![0.05, 0.49, 33.0, 0.4, 2.1, 7.0, 0.0],
        };
        assert_eq!(c.get("T3"), 7.0);
        assert_eq!(c.get("KA"), 0.0);
    }
}
