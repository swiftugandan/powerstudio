"""OpenLoadFlow settings shared by the PowSyBl oracles (cgmes.py, psse.py): a plain Newton-Raphson load flow.

Every parameter that departs from that is set explicitly, and each golden records them in its "source" field:

* no distributed slack, no reactive limits, no tap, shunt or phase-shifter controls;
* remote voltage control replaced by local control at the same per-unit set point, as PowerStudio holds it today;
* every connected component solved;
* generators with a zero MW target still started, every voltage target accepted;
* a tight convergence threshold.
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
}


def parameters(slack_buses, start):
    """Load flow parameters with the slack at the given buses; start is 'dc' or 'previous' (the stored voltages)."""
    return lf.Parameters(
        distributed_slack=False,
        use_reactive_limits=False,
        transformer_voltage_control_on=False,
        shunt_compensator_voltage_control_on=False,
        phase_shifter_regulation_on=False,
        twt_split_shunt_admittance=False,
        connected_component_mode=lf.ConnectedComponentMode.ALL,
        voltage_init_mode=lf.VoltageInitMode.PREVIOUS_VALUES if start == "previous" else lf.VoltageInitMode.DC_VALUES,
        provider_parameters=dict(PROVIDER, slackBusesIds=",".join(slack_buses)),
    )


def num(v):
    """A float, or None for a missing value."""
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else float(v)
