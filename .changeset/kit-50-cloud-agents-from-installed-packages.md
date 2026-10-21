---
'@aspiralabs/agent-common': patch
'@aspiralabs/groomer': patch
'@aspiralabs/pr-reviewer': patch
---

The groomer's and the pr-reviewer's cloud agents start from an installed package (KIT-50). eve compiles no workflow tool for a package under node_modules, so their cloud start failed with "defineWorkflowTool() requires a compiled workflow executor" on every project; the launchers now run the agent from a copy of the package outside node_modules (`.work/.agents/<name>@<version>/`, the package's dependency directory linked in), built once with `eve build`. agent-common's and the pr-reviewer's relative imports carry their `.ts` extension, so Node loads them from node_modules without eve's bundler. A kit checkout runs the package where it is, as before.
