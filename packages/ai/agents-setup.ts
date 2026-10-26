// Setup for the agent suites (vitest.config.ts): the agents fall back to process.env for the knowledge root when a
// test passes no env, so a developer's own KNOWLEDGE_PAGE (the real Agent Instructions page) replaced the fixtures'
// mock root and failed 17 tests on any machine with it set. Clearing it here keeps every suite on its own fixtures.
// NOTION_TOKEN and NOTION_API_KEY are cleared too, so no agent test can reach a real Notion workspace (TEST-003).
for (const name of ['KNOWLEDGE_PAGE', 'KNOWLEDGE_REQUIRED', 'NOTION_TOKEN', 'NOTION_API_KEY']) delete process.env[name]
