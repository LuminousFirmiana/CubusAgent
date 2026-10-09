import { expect, test } from 'vitest'
import type { CapabilityKind } from '@cubus/session'
import {
  CapabilityNegotiationError,
  RecipeDeclarationMismatchError,
  RecipeManifestError,
  resolveCapabilities,
  toMountedCapabilities,
  validateManifest,
  verifyDeclarations,
} from '../src/capabilities.ts'
import type { CapabilityOffering } from '../src/capabilities.ts'
import type { AgentRecipeManifest } from '../src/types.ts'

const llm: CapabilityOffering = { kind: 'llm', provider: 'deepseek', features: ['tool-calling', 'streaming'] }
const sessionLog: CapabilityOffering = { kind: 'session-log', provider: 'jsonl', features: ['live-subscribe'] }
const localFs: CapabilityOffering = { kind: 'fs', provider: 'local', features: ['read', 'write'] }
const dockerFs: CapabilityOffering = { kind: 'fs', provider: 'docker', features: ['read', 'write', 'isolated'] }
const bareSubprocess: CapabilityOffering = { kind: 'subprocess', provider: 'local', features: [] }

/** 完整声明式 manifest：契约字段齐全。 */
function declarative(overrides: Partial<AgentRecipeManifest> = {}): AgentRecipeManifest {
  return {
    id: 'demo',
    version: '1.0.0',
    displayName: 'Demo',
    contractVersion: 1,
    requires: [{ kind: 'llm', features: ['tool-calling'] }, { kind: 'fs' }],
    prompt: { fragmentId: 'demo/base' },
    tools: ['read_file'],
    permission: { profile: 'ask' },
    evaluation: { suite: 'repair-v1' },
    presentation: { label: 'Demo' },
    ...overrides,
  }
}

test('matches an offering whose features cover the requirement', () => {
  const resolution = resolveCapabilities({
    recipeId: 'demo',
    requirements: [{ kind: 'llm', features: ['tool-calling'] }, { kind: 'fs' }],
    offerings: [llm, sessionLog, localFs],
  })

  expect(resolution.selection).toEqual([localFs, llm])
  expect(resolution.optionalMissing).toEqual([])
})

test('an offering with extra features still satisfies a narrower requirement', () => {
  const resolution = resolveCapabilities({
    recipeId: 'demo',
    requirements: [{ kind: 'llm', features: ['tool-calling'] }],
    offerings: [llm],
  })
  expect(resolution.selection).toEqual([llm])
})

test('a missing feature is a missing capability, not a silent downgrade', () => {
  expect(() => resolveCapabilities({
    recipeId: 'demo',
    requirements: [{ kind: 'subprocess', features: ['cancellation'] }],
    offerings: [bareSubprocess],
  })).toThrow(CapabilityNegotiationError)
})

test('a missing required capability fails loudly with an actionable message', () => {
  let caught: unknown
  try {
    resolveCapabilities({
      recipeId: 'repair-eval',
      requirements: [{ kind: 'fs', features: ['write'] }],
      offerings: [llm, sessionLog],
    })
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(CapabilityNegotiationError)
  const error = caught as CapabilityNegotiationError
  expect(error.reason).toBe('missing')
  expect(error.recipeId).toBe('repair-eval')
  // 文案必须同时给出"缺什么"与"Host 有什么"
  expect(error.message).toContain('requires capability fs[write]')
  expect(error.message).toContain('host offers: llm:deepseek[tool-calling,streaming], session-log:jsonl[live-subscribe]')
})

test('an optional capability that the host lacks is recorded, not fatal', () => {
  const resolution = resolveCapabilities({
    recipeId: 'demo',
    requirements: [
      { kind: 'llm' },
      { kind: 'git', required: false },
      { kind: 'sandbox', features: ['network-deny'], required: false },
    ],
    offerings: [llm, localFs],
  })

  expect(resolution.selection).toEqual([llm])
  expect(resolution.optionalMissing).toEqual([
    { kind: 'git', required: false },
    { kind: 'sandbox', features: ['network-deny'], required: false },
  ])
})

test('two candidates without a pin fail as ambiguous and name both providers', () => {
  let caught: unknown
  try {
    resolveCapabilities({ recipeId: 'demo', requirements: [{ kind: 'fs' }], offerings: [localFs, dockerFs] })
  } catch (error) {
    caught = error
  }

  const error = caught as CapabilityNegotiationError
  expect(error).toBeInstanceOf(CapabilityNegotiationError)
  expect(error.reason).toBe('ambiguous')
  expect(error.message).toContain('fs:local, fs:docker')
  expect(error.message).toContain("pin one explicitly")
})

test('a pin resolves the ambiguity deterministically', () => {
  const resolution = resolveCapabilities({
    recipeId: 'demo',
    requirements: [{ kind: 'fs' }],
    offerings: [localFs, dockerFs],
    pins: { fs: 'docker' },
  })
  expect(resolution.selection).toEqual([dockerFs])
})

test('a pin pointing at an unknown provider fails', () => {
  let caught: unknown
  try {
    resolveCapabilities({
      recipeId: 'demo',
      requirements: [{ kind: 'fs' }],
      offerings: [localFs],
      pins: { fs: 'docker' },
    })
  } catch (error) {
    caught = error
  }

  const error = caught as CapabilityNegotiationError
  expect(error).toBeInstanceOf(CapabilityNegotiationError)
  expect(error.reason).toBe('unknown-pin')
  expect(error.message).toContain('"docker"')
  expect(error.message).toContain('candidates: fs:local')
})

test('selection is sorted by kind regardless of offering order', () => {
  const forwards = resolveCapabilities({
    recipeId: 'demo',
    requirements: [{ kind: 'llm' }, { kind: 'fs' }, { kind: 'session-log' }],
    offerings: [llm, localFs, sessionLog],
  })
  const backwards = resolveCapabilities({
    recipeId: 'demo',
    requirements: [{ kind: 'llm' }, { kind: 'fs' }, { kind: 'session-log' }],
    offerings: [sessionLog, localFs, llm],
  })

  expect(forwards.selection.map(offering => offering.kind)).toEqual(['fs', 'llm', 'session-log'])
  expect(backwards.selection).toEqual(forwards.selection)
})

test('a duplicated requirement for the same kind is a manifest error', () => {
  expect(() => resolveCapabilities({
    recipeId: 'demo',
    requirements: [{ kind: 'fs' }, { kind: 'fs' }],
    offerings: [localFs],
  })).toThrow(RecipeManifestError)
})

test('an unknown contract version is rejected', () => {
  const manifest = declarative()
  const { contractVersion: _dropped, ...withoutVersion } = manifest
  expect(() => validateManifest(withoutVersion as AgentRecipeManifest)).toThrow(RecipeManifestError)
  expect(() => validateManifest(withoutVersion as AgentRecipeManifest)).toThrow('unsupported manifest.contractVersion')
})

test('manifest validation rejects unknown kinds, duplicates and empty names', () => {
  expect(() => validateManifest(declarative({
    requires: [{ kind: 'gpu' as CapabilityKind }],
  }))).toThrow('unknown capability kind: gpu')

  expect(() => validateManifest(declarative({
    requires: [{ kind: 'fs' }, { kind: 'fs' }],
  }))).toThrow('duplicate capability requirement: fs')

  expect(() => validateManifest(declarative({ tools: ['read_file', 'read_file'] })))
    .toThrow('manifest.tools contains duplicates')
  expect(() => validateManifest(declarative({ tools: ['  '] }))).toThrow('empty name')
  expect(() => validateManifest(declarative({ presentation: { label: '' } })))
    .toThrow('presentation.label')
})

test('a complete declaration validates', () => {
  expect(() => validateManifest(declarative())).not.toThrow()
})

test('declaration verification accepts a matching implementation', () => {
  expect(() => verifyDeclarations(declarative(), {
    promptFragmentIds: ['demo/base', 'demo/extra'],
    toolNames: ['read_file'],
    evaluationSuites: ['repair-v1'],
  })).not.toThrow()
})

test('declaration verification reports tool drift in both directions', () => {
  let caught: unknown
  try {
    verifyDeclarations(declarative({ tools: ['read_file', 'write_file'] }), {
      promptFragmentIds: ['demo/base'],
      toolNames: ['read_file', 'bash'],
    })
  } catch (error) {
    caught = error
  }

  const error = caught as RecipeDeclarationMismatchError
  expect(error).toBeInstanceOf(RecipeDeclarationMismatchError)
  expect(error.message).toContain('declared but not registered [write_file]')
  expect(error.message).toContain('registered but not declared [bash]')
})

test('declaration verification catches a missing prompt fragment and eval suite', () => {
  expect(() => verifyDeclarations(declarative(), {
    promptFragmentIds: ['other/base'],
    toolNames: ['read_file'],
  })).toThrow('declares prompt fragment "demo/base" but registered fragments are [other/base]')

  expect(() => verifyDeclarations(declarative(), {
    promptFragmentIds: ['demo/base'],
    toolNames: ['read_file'],
    evaluationSuites: ['other-v1'],
  })).toThrow('declares evaluation suite "repair-v1"')
})

test('budget limits must be positive integers when declared', () => {
  expect(() => validateManifest(declarative({ budget: { maxSteps: 0 } })))
    .toThrow('manifest.budget.maxSteps must be a positive integer')
  expect(() => validateManifest(declarative({ budget: { maxToolCalls: 1.5 } })))
    .toThrow('manifest.budget.maxToolCalls must be a positive integer')
  expect(() => validateManifest(declarative({ budget: { maxDurationMs: -5 } })))
    .toThrow('manifest.budget.maxDurationMs must be a positive integer')
  expect(() => validateManifest(declarative({ budget: { maxSteps: 20 } }))).not.toThrow()
})

test('required declaration fields are validated as non-empty strings', () => {
  expect(() => validateManifest(declarative({ prompt: { fragmentId: '  ' } })))
    .toThrow('prompt.fragmentId must be a non-empty string')
  expect(() => validateManifest(declarative({ permission: { profile: '' } })))
    .toThrow('permission.profile must be a non-empty string')
})

test('mounted capabilities are sorted and do not mutate the selection', () => {
  const selection = [
    { kind: 'llm' as CapabilityKind, provider: 'deepseek', features: ['streaming', 'tool-calling'] },
    { kind: 'fs' as CapabilityKind, provider: 'local', features: ['write', 'read'] },
  ]

  expect(toMountedCapabilities(selection)).toEqual([
    { kind: 'fs', provider: 'local', features: ['read', 'write'] },
    { kind: 'llm', provider: 'deepseek', features: ['streaming', 'tool-calling'] },
  ])
  expect(selection[0]?.features).toEqual(['streaming', 'tool-calling'])
})
