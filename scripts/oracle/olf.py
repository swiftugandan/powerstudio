"""OpenLoadFlow settings shared by the PowSyBl oracles (cgmes.py, psse.py, matpower.py, controls.py): a plain
Newton-Raphson load flow, with named controls (CONTROLS) that the controls goldens enable one at a time.

Every parameter that departs from that is set explicitly, and each golden records them in its "source" field:

* no distributed slack, no reactive limits, no tap, shunt or phase-shifter controls;
* remote voltage control replaced by local control at the same per-unit set point, as PowerStudio holds it today;
* every connected component solved;
* generators with a zero MW target still started, every voltage target accepted;
* a tight convergence threshold;
* the reactive power of a bus split among its machines at the same fraction of each one's reactive range
  (K_EQUAL_PROPORTION, MATPOWER's rule; OpenLoadFlow's default gives each the same Mvar).
"""

import math

import pypowsybl.loadflow as lf

PROVIDER = {
    "slackBusSelectionMode": "NAME",
    "voltageRemoteControl": "false",
    "generatorsWithZeroMwTargetAreNotStarted": "false",
    "minPlausibleTargetVoltage": "0.0",
    "maxPlausibleTargetVoltage": "100.0",
    "minNominalVoltageTargetVoltageCheck": "0.0",
    "svcVoltageMonitoring": "false",
    "newtonRaphsonConvEpsPerEq": "1.0E-10",
    "maxNewtonRaphsonIterations": "50",
    "useLoadModel": "false",
    "reactivePowerDispatchMode": "K_EQUAL_PROPORTION",
}


# The controls a golden can enable, each as OpenLoadFlow parameters. The others stay as in a plain load flow.
CONTROLS = {
    # Distributed slack in proportion to maximum active power, within active limits, to a tight residue; what
    # cannot be placed stays on the reference (PowerStudio's behaviour) instead of failing the run.
    "slack": ({"distributed_slack": True, "balance_type": lf.BalanceType.PROPORTIONAL_TO_GENERATION_P_MAX},
              {"slackBusPMaxMismatch": "1.0E-4", "slackDistributionFailureBehavior": "LEAVE_ON_SLACK_BUS",
               "useActiveLimits": "true"}),
    "qlim": ({"use_reactive_limits": True}, {"reactiveLimitsMaxPqPvSwitch": "3"}),
    "remote": ({}, {"voltageRemoteControl": "true"}),
    "zip": ({}, {"useLoadModel": "true"}),
    # Discrete controls move whole positions by OpenLoadFlow's incremental rules (PowerStudio's only mode).
    "taps": ({"transformer_voltage_control_on": True}, {"transformerVoltageControlMode": "INCREMENTAL_VOLTAGE_CONTROL"}),
    "shunts": ({"shunt_compensator_voltage_control_on": True}, {"shuntVoltageControlMode": "INCREMENTAL_VOLTAGE_CONTROL"}),
    "phase": ({"phase_shifter_regulation_on": True}, {"phaseShifterControlMode": "INCREMENTAL"}),
}


def parameters(slack_buses, start, controls=()):
    """Load flow parameters with the slack at the given buses; start is 'dc' or 'previous' (the stored voltages);
    controls names entries of CONTROLS to enable."""
    base = {
        "distributed_slack": False,
        "use_reactive_limits": False,
        "transformer_voltage_control_on": False,
        "shunt_compensator_voltage_control_on": False,
        "phase_shifter_regulation_on": False,
        "twt_split_shunt_admittance": False,
        "connected_component_mode": lf.ConnectedComponentMode.ALL,
        "voltage_init_mode": lf.VoltageInitMode.PREVIOUS_VALUES if start == "previous" else lf.VoltageInitMode.DC_VALUES,
    }
    provider = dict(PROVIDER, slackBusesIds=",".join(slack_buses))
    for c in controls:
        common, ext = CONTROLS[c]
        base.update(common)
        provider.update(ext)
    return lf.Parameters(**base, provider_parameters=provider)


def num(v):
    """A float, or None for a missing value."""
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else float(v)
