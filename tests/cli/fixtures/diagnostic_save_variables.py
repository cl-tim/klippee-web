"""Verify only allowlisted QIDI Box variables appear in diagnostic snapshots.

argv: <installer path>.
"""
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("klippee_client", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

selected = module.select_diagnostic_object_names([
    "webhooks",
    "save_variables",
    "filament_motion_sensor box_motion_sensor",
    "gcode_move",
    "save_variables",
    42,
])
assert selected == [
    "filament_motion_sensor box_motion_sensor",
    "webhooks",
]
assert module.select_diagnostic_object_names(None) == []

secret = "never-upload-this-token"
snapshot = module.build_safe_save_variables_diagnostic({
    "result": {
        "eventtime": 123.0,
        "status": {
            "save_variables": {
                "variables": {
                    "auto_read_rfid": 1,
                    "auto_reload_detect": 1,
                    "box_count": 1,
                    "is_tool_change": 0,
                    "last_load_slot": "slot2",
                    "load_retry_num": 2,
                    "qidi_box_auto_insert": 0,
                    "retry_step": "QDE_004_010_00",
                    "slot2": 3,
                    "api_token": secret,
                    "auto_refill": 1,
                    "wifi_password": secret,
                    "unknown": {"nested": secret},
                }
            }
        },
    }
})
assert snapshot == {
    "schema": "klippee-safe-save-variables/v1",
    "variables": {
        "auto_read_rfid": 1,
        "auto_reload_detect": 1,
        "box_count": 1,
        "is_tool_change": 0,
        "last_load_slot": "slot2",
        "load_retry_num": 2,
        "qidi_box_auto_insert": 0,
        "retry_step": "QDE_004_010_00",
        "slot2": 3,
    },
    "omitted_variable_count": 4,
}
assert secret not in str(snapshot)
