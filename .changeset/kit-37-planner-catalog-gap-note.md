---
'@aspiralabs/planner': patch
---

Planner (KIT-37): a plan gap about the Aspira UI catalog (an empty listing, a failed `get_component`) is a note, not a readiness problem, once the catalog listing itself succeeded; the planning prompt says so for a plan that adds no new component. Before, the one remaining gap on a project whose UI package has no documented components yet kept every plan incomplete.
