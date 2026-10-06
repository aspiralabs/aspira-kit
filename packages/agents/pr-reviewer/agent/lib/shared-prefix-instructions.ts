import { defineDynamic } from 'eve'
import { defineInstructions } from 'eve/instructions'
import { sharedPrefixForSession } from './shared-prefix'

// The system prompt of every seat and of Quinn: the shared prefix, resolved at the start of the
// session's turn from the review context its hook pointed it at. Mounted by each subagent as
// agent/subagents/<seat>/instructions/shared.ts. There is no static instructions.md in a seat on
// purpose: eve puts static instructions before dynamic ones, and anything before the packet
// would be a different prefix per seat. The persona travels in the message instead, after the
// prefix. A session with no pointer (not a seat of a loaded review) gets no system prompt.
export default defineDynamic({
  events: {
    'turn.started': async (_event, ctx) => {
      const prefix = await sharedPrefixForSession(ctx.session.id)
      return prefix === null ? null : defineInstructions({ content: prefix })
    },
  },
})
