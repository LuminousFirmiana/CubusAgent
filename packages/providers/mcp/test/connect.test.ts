import { expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectMcpServers, McpConfigError, parseMcpServerConfigs, StdioMcpClient } from '../src/index.ts'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mcp-echo-server.mjs')

function requireClient(connections: { clients: ReadonlyMap<string, unknown> }, name: string) {
  const client = connections.clients.get(name)
  if (client === undefined) throw new Error('expected a connected client: ' + name)
  return client as StdioMcpClient & { callTool: (tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }> }
}

test('parses stdio/http configs and infers the transport', () => {
  const configs = parseMcpServerConfigs([
    { name: 'local', command: 'npx', args: ['-y', 'server'], env: { TOKEN: 'x' } },
    { name: 'remote', url: 'https://example.com/mcp', headers: { authorization: 'Bearer y' } },
    { name: 'explicit', transport: 'stdio', command: 'node', timeoutMs: 5000 },
  ])
  expect(configs.map(config => [config.name, config.transport])).toEqual([
    ['local', 'stdio'],
    ['remote', 'http'],
    ['explicit', 'stdio'],
  ])
  expect(parseMcpServerConfigs(undefined)).toEqual([])
})

test('malformed configuration fails before anything is connected', () => {
  const cases: readonly [unknown, string][] = [
    [{}, 'must be an array'],
    [[{ command: 'node' }], 'name must be a non-empty string'],
    [[{ name: 'a', command: 'node' }, { name: 'a', command: 'node' }], 'duplicate server name'],
    [[{ name: 'a' }], 'has no command'],
    [[{ name: 'a', transport: 'http' }], 'has no url'],
    [[{ name: 'a', command: 'node', transport: 'sse' }], 'must be "stdio" or "http"'],
    [[{ name: 'a', command: 'node', timeoutMs: 0 }], 'timeoutMs must be a positive integer'],
    [[{ name: 'a', command: 'node', env: { K: 1 } }], 'env.K must be a string'],
  ]
  for (const [value, message] of cases) {
    expect(() => parseMcpServerConfigs(value)).toThrow(McpConfigError)
    expect(() => parseMcpServerConfigs(value)).toThrow(message)
  }
})

test('connects over stdio, discovers tools and calls one', async () => {
  const connections = await connectMcpServers([
    { name: 'fake', command: process.execPath, args: [fixtures, '--tools', '12', '--name', 'fixture'] },
  ])
  try {
    expect(connections.connections).toEqual([
      expect.objectContaining({ name: 'fake', transport: 'stdio', connected: true, serverName: 'fixture', protocolVersion: '2025-06-18' }),
    ])
    expect(connections.tools).toHaveLength(12)
    expect(connections.tools[0]).toMatchObject({ server: 'fake', name: 'echo_tool_1' })
    expect(connections.tools[11]?.name).toBe('echo_tool_12')

    const client = requireClient(connections, 'fake')
    expect(await client.callTool('echo_tool_3', { text: '你好' })).toEqual({ text: 'echo: 你好', isError: false })
    // 远端报错 -> 协议错误，带服务器名
    await expect(client.callTool('nope', {})).rejects.toThrow('mcp[fake]: protocol error -32602: unknown tool: nope')
  } finally {
    await connections.close()
  }
}, 20_000)

test('closing a stdio server terminates its process group (no orphans)', async () => {
  const client = new StdioMcpClient({ name: 'fake', command: process.execPath, args: [fixtures] })
  await client.start()
  await client.initialize()
  const pid = client.pid
  expect(typeof pid).toBe('number')

  await client.close()
  const alive = (): boolean => {
    if (pid === undefined) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  for (let attempt = 0; attempt < 20 && alive(); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  expect(alive()).toBe(false)
  // 关闭之后不再接受请求
  await expect(client.listTools()).rejects.toThrow('client is not running')
}, 20_000)

test('a server that cannot start is reported, never thrown: assembly must not be blocked', async () => {
  const connections = await connectMcpServers([
    { name: 'exits', command: process.execPath, args: [fixtures, '--fail'] },
    { name: 'missing', command: '/nonexistent/cubus-mcp-server' },
  ])
  expect(connections.connections.map(connection => connection.connected)).toEqual([false, false])
  expect(connections.connections[0]?.error).toContain('mcp[exits]')
  expect(connections.connections[1]?.error).toContain('failed to start')
  expect(connections.clients.size).toBe(0)
  expect(connections.tools).toEqual([])
  await connections.close()
}, 20_000)

test('an http endpoint is reached over Streamable HTTP and the session id is echoed back', async () => {
  const seenSessions: string[] = []
  let session: string | undefined
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      const message = JSON.parse(body) as { id?: number; method?: string; params?: { arguments?: { text?: string } } }
      if (message.id === undefined) {
        response.writeHead(202).end()
        return
      }
      seenSessions.push(String(request.headers['mcp-session-id'] ?? ''))
      const reply = (result: unknown): void => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
      }
      if (session === undefined) {
        session = 'sess-1'
        response.setHeader('mcp-session-id', session)
      }
      if (message.method === 'initialize') {
        reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'http-fake', version: '1' } })
        return
      }
      if (message.method === 'tools/list') {
        reply({ tools: [{ name: 'http_echo', description: 'Echo over HTTP.', inputSchema: { type: 'object' } }] })
        return
      }
      if (message.method === 'tools/call') {
        reply({ content: [{ type: 'text', text: 'http: ' + String(message.params?.arguments?.text ?? '') }] })
        return
      }
      reply({})
    })
  })
  const port = await listen(server)
  try {
    const connections = await connectMcpServers([
      { name: 'remote', transport: 'http', url: 'http://127.0.0.1:' + String(port) + '/mcp' },
    ])
    try {
      expect(connections.connections[0]).toMatchObject({ connected: true, transport: 'http', serverName: 'http-fake' })
      const client = requireClient(connections, 'remote')
      expect((await client.callTool('http_echo', { text: 'hi' })).text).toBe('http: hi')
      // 第一次请求没有会话，之后的请求都要带上服务端给的 id
      expect(seenSessions[0]).toBe('')
      expect(seenSessions.slice(1).every(id => id === 'sess-1')).toBe(true)
    } finally {
      await connections.close()
    }
  } finally {
    server.close()
  }
}, 20_000)

test('an http error status is reported as a connection error with the status code', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(500, { 'content-type': 'text/plain' }).end('boom')
  })
  const port = await listen(server)
  try {
    const connections = await connectMcpServers([
      { name: 'broken', transport: 'http', url: 'http://127.0.0.1:' + String(port) + '/mcp' },
    ])
    expect(connections.connections[0]?.connected).toBe(false)
    expect(connections.connections[0]?.error).toContain('http 500')
    expect(connections.connections[0]?.error).toContain('boom')
    await connections.close()
  } finally {
    server.close()
  }
}, 20_000)

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return typeof address === 'object' && address !== null ? address.port : 0
}
