import type { LlmAdapter, LlmChunk, LlmRequest } from './types.ts'

/** 场景里的一步：产出可选碎片；hold 用于测试钩子（产出后阻塞）。 */
export interface SceneStep {
  chunk?: LlmChunk
  /** 产出该碎片后阻塞，直到 hold 完成或 signal 中止。 */
  hold?: Promise<void>
}

/** 一次模型请求的完整脚本：一串按顺序产出的步。 */
export interface Scene {
  steps: SceneStep[]
}

function abortError(): Error {
  return new DOMException('aborted', 'AbortError')
}

function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(abortError()), { once: true })
  })
}

/**
 * 脚本化假模型：不联网、不花钱，按预定场景逐碎片产出。
 *
 * 确定性：同样的场景序列 + 同样的请求序列，永远产出同样的碎片序列。
 * 多场景支持工具闭环：第 0 个场景以工具调用收尾，第 1 个场景是
 * 收到工具结果后的第二步回答。
 */
export class ScriptedAdapter implements LlmAdapter {
  /** 已产出的碎片数（测试等待用）。 */
  delivered = 0

  private sceneIndex = 0
  private readonly scenes: Scene[]

  constructor(scenes: Scene[]) {
    this.scenes = scenes
  }

  async *stream(_request: LlmRequest, signal: AbortSignal): AsyncGenerator<LlmChunk, void, void> {
    const scene = this.scenes[this.sceneIndex++]
    if (!scene) return // 脚本用尽：空回复

    for (const step of scene.steps) {
      if (signal.aborted) throw abortError()
      if (step.chunk) {
        yield step.chunk
        this.delivered++
      }
      if (step.hold) {
        // 卡住：与取消信号赛跑（真模型的 fetch 也是这么被 abort 的）
        await Promise.race([step.hold, abortPromise(signal)])
      }
    }
  }
}

