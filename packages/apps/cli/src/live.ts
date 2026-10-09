import type { SessionEvent } from '@cubus/session'
import type { CodingCommandOutput } from './coding.ts'

/**
 * 行式输出接口下的实时渲染器：模型正文增量先缓冲、遇换行成行输出；
 * 工具调用与结果即时成行。只消费会话日志事件，不持有任何状态源。
 */
export interface LiveRenderer {
  onEvent(event: SessionEvent): void
  /** 冲刷残留缓冲（消息结束或运行结束时调用）。 */
  flush(): void
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit - 1) + '…'
}

/** 工具参数摘要：优先展示路径/命令/模式，其它情况退化为紧凑 JSON。 */
export function summarizeToolArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null) return ''
  const record = args as Record<string, unknown>
  for (const key of ['path', 'command', 'pattern']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return truncate(value, 80)
  }
  const json = JSON.stringify(args)
  return json === undefined ? '' : truncate(json, 60)
}

function firstLine(text: string): string {
  return truncate(text.split('\n')[0] ?? '', 100)
}

/**
 * 创建实时渲染器。
 * 说明：思考增量（thinkingDelta）本步不渲染，仍完整保存在会话日志中。
 */
export function createLiveRenderer(output: CodingCommandOutput): LiveRenderer {
  let buffer = ''

  const flushBuffer = (): void => {
    if (buffer === '') return
    output.write('  ' + buffer)
    buffer = ''
  }

  return {
    onEvent(event: SessionEvent): void {
      switch (event.type) {
        case 'assistant/chunk': {
          if (event.delta === undefined || event.delta === '') return
          buffer += event.delta
          let newline = buffer.indexOf('\n')
          while (newline >= 0) {
            output.write('  ' + buffer.slice(0, newline))
            buffer = buffer.slice(newline + 1)
            newline = buffer.indexOf('\n')
          }
          return
        }
        case 'assistant/message': {
          flushBuffer()
          return
        }
        case 'tool/call': {
          flushBuffer()
          const summary = summarizeToolArgs(event.args)
          output.write('→ ' + event.name + (summary === '' ? '' : ' ' + summary))
          return
        }
        case 'tool/result': {
          flushBuffer()
          const detail = firstLine(event.output.text)
          output.write('← ' + (event.ok ? 'ok' : 'failed') + (detail === '' ? '' : ' ' + detail))
          return
        }
        default:
          // turn/*, step/*, request/header, user/message：不进入实时输出
          return
      }
    },
    flush(): void {
      flushBuffer()
    },
  }
}
