export interface SystemPromptFragment {
  /** Stable contribution identity within one service realm. */
  id: string
  /** Lower values render first. Equal values are ordered by id. */
  order?: number
  /** Static text and render are mutually exclusive. */
  text?: string
  render?: () => string
}

interface RegisteredFragment {
  fragment: SystemPromptFragment
  order: number
}

function validateFragment(fragment: SystemPromptFragment): RegisteredFragment {
  if (fragment.id.trim() === '') throw new TypeError('system prompt fragment id must not be empty')
  const hasText = fragment.text !== undefined
  const hasRender = fragment.render !== undefined
  if (hasText === hasRender) {
    throw new TypeError(`system prompt fragment ${fragment.id} must define exactly one of text or render`)
  }
  const order = fragment.order ?? 0
  if (!Number.isFinite(order)) throw new TypeError(`system prompt fragment ${fragment.id} order must be finite`)
  return { fragment, order }
}

/** Registry and deterministic assembler for model-visible system-prompt text. */
export class SystemPromptService {
  private readonly fragments = new Map<string, RegisteredFragment>()

  register(fragment: SystemPromptFragment): () => void {
    const registered = validateFragment(fragment)
    if (this.fragments.has(fragment.id)) {
      throw new Error(`system prompt fragment already registered: ${fragment.id}`)
    }
    this.fragments.set(fragment.id, registered)
    return () => this.fragments.delete(fragment.id)
  }

  assemble(): string | undefined {
    const parts = [...this.fragments.values()]
      .sort((a, b) => a.order - b.order || a.fragment.id.localeCompare(b.fragment.id))
      .map(({ fragment }) => fragment.text ?? fragment.render!())
      .filter(text => text !== '')
    return parts.length === 0 ? undefined : parts.join('\n\n')
  }

  list(): readonly SystemPromptFragment[] {
    return [...this.fragments.values()]
      .sort((a, b) => a.order - b.order || a.fragment.id.localeCompare(b.fragment.id))
      .map(({ fragment }) => ({ ...fragment }))
  }
}
