// Shared tool; see packages/ai/common. eve discovers tools by file under agent/tools/,
// so each agent mounts it with a re-export.
export { default } from '@aspiralabs/ai/common/tools/load-knowledge'
