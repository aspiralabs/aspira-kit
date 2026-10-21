// KIT-48: the run packet and the session model names.
import { describe, expect, it } from 'vitest'
import { PACKET_MAX_PATHS, renderPacket } from './packet.ts'
import { sessionModel } from './session-model.ts'

describe('renderPacket', () => {
  it('lists the project facts, the ticket files and the repository map grouped by top-level directory', () => {
    const packet = renderPacket({
      files: ['package.json', 'apps/web/src/a.ts', 'apps/web/src/b.ts', 'packages/ui/index.ts'],
      aspira: { app: 'apps/web', repository: 'aspiralabs/x', gates: [{ cwd: 'apps/web', command: 'pnpm check' }] },
      ticketFiles: [{ name: 'idea', path: '/w/.work/x/idea.md', bytes: 120 }],
      knowledgeDir: '/w/.work/x/knowledge',
    })
    expect(packet).toContain('- app: apps/web')
    expect(packet).toContain('- gates: pnpm check (in apps/web)')
    expect(packet).toContain('- idea: /w/.work/x/idea.md (120 bytes)')
    expect(packet).toContain('- folder: /w/.work/x/knowledge')
    expect(packet).toContain('### apps (2)\n\n- apps/web/src/a.ts\n- apps/web/src/b.ts')
    expect(packet).toContain('### (root) (1)\n\n- package.json')
    expect(packet).toContain('4 tracked paths.')
  })

  it('caps the map and says how many paths it left out', () => {
    const files = Array.from({ length: PACKET_MAX_PATHS + 5 }, (_, i) => `src/f${String(i).padStart(5, '0')}.ts`)
    const packet = renderPacket({ files, aspira: null, ticketFiles: [] })
    expect(packet).toContain(`${PACKET_MAX_PATHS + 5} tracked paths (the first ${PACKET_MAX_PATHS} listed; search for the rest).`)
    expect(packet).toContain('- aspira.json: none')
    expect(packet).toContain('- none yet')
  })
})

describe('sessionModel', () => {
  it('maps a gateway model id onto the session model names', () => {
    expect(sessionModel('anthropic/claude-haiku-4.5')).toBe('haiku')
    expect(sessionModel('anthropic/claude-sonnet-5')).toBe('sonnet')
    expect(sessionModel('anthropic/claude-opus-5.5')).toBe('opus')
    expect(sessionModel('openai/gpt-6-luna')).toBe('opus')
    expect(sessionModel(undefined)).toBe('opus')
  })
})
