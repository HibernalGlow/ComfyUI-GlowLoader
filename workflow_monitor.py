"""BatchWorkflowMonitor — a passthrough node whose real job is to host a DOM
widget (registered from web/workflow_monitor.js) that displays the current
tab's workflow status. It passes its optional trigger input through unchanged
so it can sit anywhere in the graph without affecting execution.
"""


class BatchWorkflowMonitor:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "trigger": ("*",),
            },
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("trigger",)
    FUNCTION = "execute"
    CATEGORY = "GlowLoader"

    def execute(self, trigger=None):
        return (trigger,)
