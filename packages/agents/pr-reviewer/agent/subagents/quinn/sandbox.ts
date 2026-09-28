import { defineSandbox } from 'eve/sandbox'

// Share the root's sandbox so every seat reads the same diff and the same record.
export default defineSandbox(({ parent }) => {
  if (parent === null) throw new Error('This seat only runs inside the pr-debator workflow.')
  return parent.sandbox
})
