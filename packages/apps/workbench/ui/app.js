/**
 * 工作台前端（E3）：零构建、无框架。
 *
 * **无状态原则**：界面不缓存任何状态 —— 打开会话就是"订阅日志（先回放、后实时）",
 * 刷新页面等于重新回放同一份日志，因此"跑到一半刷新"渲染结果与刷新前一致。
 * 唯一的例外是控制帧（run 开始/结束），它是易失的：连得晚的客户端从日志与详情里取状态。
 */
'use strict'

const el = id => document.getElementById(id)
const transcript = el('transcript')
let current = null
let source = null

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild) }

function row(kind, who) {
  const div = document.createElement('div')
  div.className = 'row ' + kind
  const label = document.createElement('div')
  label.className = 'who'
  label.textContent = who
  const body = document.createElement('div')
  body.className = 'body'
  div.append(label, body)
  transcript.append(div)
  transcript.scrollTop = transcript.scrollHeight
  return body
}

function marker(text, className) {
  const div = document.createElement('div')
  div.className = 'row marker' + (className ? ' ' + className : '')
  div.textContent = text
  transcript.append(div)
  transcript.scrollTop = transcript.scrollHeight
  return div
}

function toolCard(event) {
  const div = document.createElement('div')
  div.className = 'row tool'
  div.dataset.callId = event.id
  const name = document.createElement('div')
  name.className = 'name'
  name.textContent = event.name
  const args = document.createElement('pre')
  args.textContent = JSON.stringify(event.args)
  const out = document.createElement('pre')
  out.className = 'out'
  div.append(name, args, out)
  transcript.append(div)
  transcript.scrollTop = transcript.scrollHeight
  return div
}

function summarize(event) {
  switch (event.type) {
    case 'session/mount': {
      const m = event.mount
      return '装配：' + m.recipe.id + '@' + m.recipe.version +
        ' · 权限 ' + m.permission.profile + '(' + m.permission.source + ')' +
        ' · 能力 ' + m.capabilities.map(c => c.kind + ':' + c.provider).join(', ')
    }
    case 'turn/start': return '回合开始'
    case 'turn/end': return event.settled === true ? '回合结束（恢复时结算）' : '回合结束'
    case 'step/start': return '第 ' + (event.stepId || '').slice(0, 8) + ' 步'
    case 'step/end': return event.settled === true ? '步结束（恢复时结算）' : null
    default: return null
  }
}

function render(event) {
  // 助手正文：chunk 逐字追加，message 用最终文本收束（与日志投影一致）
  if (event.type === 'assistant/chunk') {
    const last = transcript.lastElementChild
    const kind = event.thinkingDelta !== undefined ? 'thinking' : 'assistant'
    if (last && last.classList.contains(kind) && last.dataset.open === 'true') {
      last.querySelector('.body').textContent += event.delta !== undefined ? event.delta : event.thinkingDelta
    } else {
      const body = row(kind, kind === 'thinking' ? '思考' : '助手')
      body.textContent = event.delta !== undefined ? event.delta : event.thinkingDelta
      body.parentElement.dataset.open = 'true'
    }
    transcript.scrollTop = transcript.scrollHeight
    return
  }

  if (event.type === 'assistant/message') {
    const last = transcript.lastElementChild
    const text = (event.content || []).map(block => block.text || '').join('')
    const isOpenAssistant = last && last.classList.contains('assistant') && last.dataset.open === 'true'
    if (isOpenAssistant) {
      last.querySelector('.body').textContent = text
      last.dataset.open = 'false'
    } else if (text !== '') {
      row('assistant', '助手').textContent = text
    }
    if (event.usage) {
      marker('tokens: ' + event.usage.totalTokens +
        '（prompt ' + event.usage.promptTokens + ' / completion ' + event.usage.completionTokens +
        (event.usage.cachedTokens === undefined ? '' : ' / cached ' + event.usage.cachedTokens) + '）')
    }
    if (event.interrupted === true) marker('（本回合被取消，以上是已收到的部分）', 'settled')
    return
  }

  if (event.type === 'user/message') {
    row('user', '你').textContent = (event.content || []).map(block => block.text || '').join('')
    return
  }

  if (event.type === 'tool/call') { toolCard(event); return }

  if (event.type === 'tool/result') {
    const card = transcript.querySelector('[data-call-id="' + event.id + '"]')
    if (card) {
      card.classList.toggle('failed', event.ok !== true)
      card.querySelector('.out').textContent = event.ok === true ? '' : '（失败）'
      card.querySelector('.out').textContent += (event.output && event.output.text ? event.output.text : '').slice(0, 400)
    }
    return
  }

  if (event.type === 'request/header') {
    marker('请求：' + event.header.model + (event.header.tools ? ' · ' + event.header.tools.length + ' 个工具' : ''))
    return
  }

  const text = summarize(event)
  if (text !== null) marker(text, event.settled === true ? 'settled' : undefined)
}

async function refreshSessions(selectId) {
  const data = await (await fetch('/api/sessions')).json()
  const list = el('sessions')
  clear(list)
  for (const session of data.sessions) {
    const button = document.createElement('button')
    button.textContent = session.id
    if (session.needsSettlement) {
      const badge = document.createElement('span')
      badge.className = 'badge warn'
      badge.textContent = '待恢复'
      button.append(badge)
    }
    if (session.problems && session.problems.length > 0) {
      const badge = document.createElement('span')
      badge.className = 'badge warn'
      badge.textContent = '日志有问题'
      button.append(badge)
    }
    if (session.id === (selectId || current)) button.setAttribute('aria-current', 'true')
    button.onclick = () => openSession(session.id)
    list.append(button)
  }
  return data.sessions
}

async function refreshChanges(id) {
  const response = await fetch('/api/sessions/' + id + '/changes')
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: String(response.status) }))
    marker('改动报告暂不可用：' + body.error)
    return
  }
  const payload = await response.json()
  const changes = payload.changes
  if (!changes.isRepository) {
    marker('工作区不是 git 仓库，无法给出改动报告')
    return
  }
  if (changes.changed.length === 0) {
    marker('本次运行没有改变任何文件')
    return
  }
  for (const file of changes.changed) {
    marker('改动 ' + file.kind + '：' + file.path +
      '（+' + file.addedLines + ' / -' + file.removedLines + '）')
  }
}

async function refreshDetail(id) {
  const detail = await (await fetch('/api/sessions/' + id)).json()
  const parts = []
  if (detail.summary && detail.summary.recipe) parts.push('recipe ' + detail.summary.recipe.id + '@' + detail.summary.recipe.version)
  parts.push('事件 ' + (detail.summary ? detail.summary.eventCount : '?'))
  if (detail.budget) {
    parts.push('步 ' + detail.budget.steps + ' · 工具 ' + detail.budget.toolCalls + ' · tokens ' + detail.budget.tokens +
      ' · ' + (detail.budget.elapsedMs / 1000).toFixed(1) + 's')
  }
  if (detail.run) {
    parts.push(detail.run.finishedAt ? '上次运行已结束' : '运行中…')
    if (detail.run.error) parts.push('错误：' + detail.run.error)
  }
  el('meta').textContent = parts.join(' · ')
  el('recipe').textContent = detail.summary && detail.summary.recipe
    ? detail.summary.recipe.id + '@' + detail.summary.recipe.version
    : '—'
  return detail
}

function openSession(id) {
  current = id
  if (source) source.close()
  clear(transcript)
  el('status').textContent = '连接中…'
  el('status').className = ''
  refreshSessions(id).catch(() => {})
  refreshDetail(id).catch(() => {})

  // EventSource 自带重连与 Last-Event-ID：断线后从断点续传（协议见 ADR §4）
  source = new EventSource('/api/sessions/' + id + '/events')
  source.onopen = () => { el('status').textContent = '实时（' + id + '）'; el('status').className = 'live' }
  source.onerror = () => { el('status').textContent = '断线，重连中…'; el('status').className = 'offline' }
  source.addEventListener('session-event', message => render(JSON.parse(message.data)))
  source.addEventListener('control', message => {
    const frame = JSON.parse(message.data)
    if (frame.running === true) {
      marker('开始运行…')
      el('meta').textContent = '运行中…'
    } else {
      if (frame.error) marker('运行失败：' + frame.error, 'error')
      if (frame.assistantText) marker('最终回复：' + frame.assistantText)
      refreshDetail(id).catch(() => {})
      // 运行结束后看改动（复用 A1 的只读 Git 报告，与 CLI 输出同源）
      refreshChanges(id).catch(() => {})
    }
  })
}

el('run').onclick = async () => {
  if (!current) { alert('先新建或选择一个会话'); return }
  const task = el('task').value.trim()
  if (task === '') { alert('写点任务再运行'); return }
  const response = await fetch('/api/sessions/' + current + '/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task }),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: String(response.status) }))
    marker('无法开始运行：' + body.error, 'error')
  }
}

el('new-session').onclick = async () => {
  const response = await fetch('/api/sessions', { method: 'POST' })
  const body = await response.json()
  await refreshSessions(body.session.id)
  openSession(body.session.id)
}

el('refresh').onclick = () => { refreshSessions().catch(() => {}) }

refreshSessions().then(sessions => {
  if (sessions.length > 0) openSession(sessions[0].id)
}).catch(() => {})
