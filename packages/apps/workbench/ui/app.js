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
  // 记忆类工具加一句人话：模型在"回忆/记下"什么，一眼看懂（S7.2）
  const toolNote = event.name === 'recall_memory'
    ? '（按需读回记忆正文）'
    : event.name === 'remember_memory'
      ? '（写入长期记忆）'
      : event.name === 'read_session_log'
        ? '（读回被压缩的原文）'
        : ''
  name.textContent = event.name + toolNote
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
      // MCP 工具来源（S2.4）：连了几台、多少工具、用哪种暴露模式 —— 都在装配快照里，不是猜的。
      const mcp = m.config && m.config.mcp
        ? ' · MCP ' + m.config.mcp.servers.filter(s => s.connected).length + '/' + m.config.mcp.servers.length + ' 台' +
          ' · ' + (m.config.mcp.mode === 'eager' ? '全量加载' : '按需检索') +
          (m.config.mcp.deferredTools > 0 ? '（延迟 ' + m.config.mcp.deferredTools + ' 个）' : '')
        : ''
      // 指令分层（S4.2）：全文也在快照里，这里只显示"带了哪几层、多少字符、有没有被截"
      const instructions = m.config && Array.isArray(m.config.instructions) ? m.config.instructions : []
      const instructionText = instructions.length === 0
        ? ' · 指令 无'
        : ' · 指令 ' + instructions.map(tier =>
            (tier.source === 'user' ? '用户' : '项目') + ' ' + String(tier.chars) + ' 字' +
            (tier.truncated ? '（已截断）' : '')).join(' + ')
      // 跨会话记忆（S4.3）：只注入了索引，正文按需检索
      const memory = m.config && m.config.memory ? m.config.memory : undefined
      const memoryText = memory === undefined
        ? ''
        : ' · 记忆 ' + String(memory.entries) + ' 条索引' + (memory.entries === 0 ? '（空）' : '')
      return '装配：' + m.recipe.id + '@' + m.recipe.version +
        ' · 权限 ' + m.permission.profile + '(' + m.permission.source + ')' +
        mcp +
        instructionText +
        memoryText +
        ' · 能力 ' + m.capabilities.map(c => c.kind + ':' + c.provider).join(', ') +
        (function () {
          // 权限规则（S5.1）：规则条数写在 approval 能力的 features 里
          const approval = m.capabilities.find(c => c.kind === 'approval')
          const count = approval && approval.features
            ? approval.features.filter(f => f.indexOf('rules:') === 0)[0]
            : undefined
          return count ? ' · ' + count.replace('rules:', '权限规则 ') + ' 条' : ''
        })()
    }
    case 'context/compacted':
      // 压缩边界（S3.3）：历史被摘要替代、之后的消息逐字保留 —— 原事件一条没少。
      return '上下文压缩：' + event.summary.length + ' 字摘要替代了前 ' + event.keepFrom + ' 条事件' +
        '（估算 ' + event.before + ' → ' + event.after + ' token，原因 ' + event.reason + '）'
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

    // 崩溃留下的未闭合会话：给一个恢复入口（E6）
    if (session.needsSettlement) {
      const resume = document.createElement('button')
      resume.textContent = '恢复 ' + session.id
      resume.style.marginTop = '-4px'
      resume.onclick = () => resumeSession(session.id)
      list.append(resume)
    }
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
    // 用量带上限：步数/工具/token 是**会话级**累计，时长是**本次运行**用时。
    const limits = detail.summary && detail.summary.budget ? detail.summary.budget : {}
    const used = (value, limit) => (limit === undefined ? String(value) : value + '/' + limit)
    const seconds = (value, limit) =>
      (value / 1000).toFixed(1) + 's' + (limit === undefined ? '' : '/' + String(limit / 1000) + 's')
    parts.push(
      '步 ' + used(detail.budget.steps, limits.maxSteps) +
      ' · 工具 ' + used(detail.budget.toolCalls, limits.maxToolCalls) +
      ' · tokens ' + used(detail.budget.tokens, limits.maxTokens) +
      ' · ' + seconds(detail.budget.elapsedMs, limits.maxDurationMs) +
      (detail.budget.tripped === undefined ? '' : ' · 已触发 ' + detail.budget.tripped),
    )
  }
  if (detail.run) {
    parts.push(detail.run.finishedAt ? '上次运行已结束' : '运行中…')
    if (detail.run.error) parts.push('错误：' + detail.run.error)
  }
  el('meta').textContent = parts.join(' · ')
  el('recipe').textContent = detail.summary && detail.summary.recipe
    ? detail.summary.recipe.id + '@' + detail.summary.recipe.version
    : '—'
  // 服务端重启后，历史会话在本进程里是"没打开"的（只有磁盘回放），直接运行会被拒绝。
  // 给一个显式入口把它打开：恢复 = 重新装配（身份必须一致）+ 结算未闭合区间。
  const isOpen = detail.budget !== undefined || detail.snapshot !== undefined
  if (!isOpen) {
    const open = document.createElement('button')
    open.textContent = '继续此会话'
    open.style.marginLeft = '10px'
    open.onclick = () => resumeSession(id)
    el('meta').append(open)
  }
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
  // 控制帧易失：刷新后要靠列表把"还在等回答"的审批找回来
  refreshApprovals().catch(() => {})

  // EventSource 自带重连与 Last-Event-ID：断线后从断点续传（协议见 ADR §4）
  source = new EventSource('/api/sessions/' + id + '/events')
  source.onopen = () => { el('status').textContent = '实时（' + id + '）'; el('status').className = 'live' }
  source.onerror = () => { el('status').textContent = '断线，重连中…'; el('status').className = 'offline' }
  source.addEventListener('session-event', message => render(JSON.parse(message.data)))
  source.addEventListener('approval', message => {
    const event = JSON.parse(message.data)
    if (event.type === 'requested') approvalCard(event.approval)
    else resolveApprovalCard(event.approval.id, event.outcome, event.reason, event.by)
  })
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

/** 审批卡片：allow/deny 按钮把决定 POST 回去；刷新后靠 GET /api/approvals 找回待回答项。 */
function approvalCard(approval) {
  const card = document.createElement('div')
  card.className = 'row tool'
  card.dataset.approvalId = approval.id
  const name = document.createElement('div')
  name.className = 'name'
  name.textContent = '需要审批：' + approval.toolName +
    (approval.sessionId ? '（会话 ' + approval.sessionId.slice(0, 8) + '）' : '') +
    (approval.queuePosition > 0 ? '（排队第 ' + approval.queuePosition + ' 位）' : '')
  const args = document.createElement('pre')
  args.textContent = JSON.stringify(approval.args)
  const hint = document.createElement('pre')
  hint.textContent = '未回答将在 ' + new Date(approval.expiresAt).toLocaleTimeString() + ' 之后按拒绝处理'
  const buttons = document.createElement('div')
  buttons.style.display = 'flex'
  buttons.style.gap = '6px'
  buttons.style.marginTop = '6px'
  const answer = async decision => {
    const response = await fetch('/api/approvals/' + approval.id, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: String(response.status) }))
      marker('回答失败：' + body.error, 'error')
    }
  }
  const allow = document.createElement('button')
  allow.textContent = '允许'
  allow.onclick = () => answer('allow')
  const deny = document.createElement('button')
  deny.textContent = '拒绝'
  deny.onclick = () => answer('deny')
  buttons.append(allow, deny)
  card.append(name, args, hint, buttons)
  // 审批卡不住在 transcript 里：transcript 会被整份日志回放（顺序由日志决定），
  // 而"还在等回答"是易失的实时状态。放固定区域，刷新/重连后都找得到。
  el('approvals').append(card)
}

function resolveApprovalCard(id, outcome, reason, by) {
  const card = el('approvals').querySelector('[data-approval-id="' + id + '"]')
  if (!card) return
  const note = document.createElement('pre')
  note.textContent = (outcome === 'allow' ? '已允许' : '已拒绝') +
    (by === 'timeout' ? '（超时未回答，按默认拒绝）' : '') + (reason ? '：' + reason : '')
  card.append(note)
  for (const button of card.querySelectorAll('button')) button.disabled = true
  // 结论看一眼就够，3 秒后收起，避免审批区堆积历史决定
  setTimeout(() => card.remove(), 3000)
}

async function refreshApprovals() {
  const response = await fetch('/api/approvals')
  if (!response.ok) return
  const payload = await response.json()
  for (const approval of payload.pending) {
    if (!el('approvals').querySelector('[data-approval-id="' + approval.id + '"]')) approvalCard(approval)
  }
}

/** 恢复：把崩溃留下的未闭合区间结算掉，之后这个会话就能继续用了（D3 语义）。 */
async function resumeSession(id) {
  const response = await fetch('/api/sessions/' + id + '/resume', { method: 'POST' })
  const body = await response.json().catch(() => ({ error: String(response.status) }))
  if (!response.ok) {
    // 409 不只是"失败"：装配不一致/格式版本过高都要把原因原样显示出来
    marker('无法恢复 ' + id + '：' + body.error, 'error')
    return
  }
  if (body.settled) {
    // 结算事件是**恢复时补写的闭合**：在 transcript 里单独标出来，与正常回合区分
    for (const event of body.settlementEvents) {
      marker('恢复补写：' + describeSettlement(event), 'settled')
    }
  } else {
    marker('恢复 ' + id + '：日志本来就是闭合的，无需结算')
  }
  await refreshSessions(id)
  openSession(id)
}

function describeSettlement(event) {
  if (event.type === 'tool/result') return '工具结果未知（崩溃前没落盘）：' + (event.output ? event.output.text : '')
  if (event.type === 'step/end') return '步闭合（settled）'
  if (event.type === 'turn/end') return '回合闭合（settled）'
  return event.type
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