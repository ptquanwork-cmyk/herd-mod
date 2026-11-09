import { expect, test } from 'claude-code/testing'

const ok = (result: unknown) => ({
  value: { exitCode: 0, stdout: JSON.stringify({ id: '1', result }), stderr: '' },
})

const CODE_PANE = {
  plugin: 'herd',
  component: 'Pane',
  requestId: 'herd-code',
  surface: 'desktop',
  props: {
    title: 'Code',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const herdrEnv: { value: string | undefined } = { value: undefined }

function ready($: any, on: any) {
  herdrEnv.value = undefined
  on('command.register', () => ({ value: { command: 'x' } }))
  on('tool.register', (_: unknown, e: { name: string }) => ({ value: { tool: `mcp__herd__${e.name}` } }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.root', () => ({ value: 'C:\\proj' }))
  on('env.get', (_: unknown, e: { name: string }) => ({
    value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : herdrEnv.value,
  }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  return $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
}

/** A fake herdr that keeps a real pane list, so the grid can be read back from its splits. */
function grid(on: any) {
  const calls: string[][] = []
  const panes: Record<string, string>[] = []
  let next = 1
  const pane = (cwd: string, tab: string) => {
    const row = { pane_id: `w1:p${next++}`, tab_id: tab, workspace_id: 'w1', cwd }
    panes.push(row)
    return row
  }
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1] as string
  on('fs.exists', () => ({ value: true }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    const args = e.argv.slice(1)
    calls.push(args)
    const verb = args.slice(0, 2).join(' ')
    if (verb === 'pane list') return ok({ panes: [...panes] })
    if (verb === 'pane split') return ok({ pane: pane(after(args, '--cwd'), 'w1:t1') })
    if (verb === 'workspace create') return ok({ root_pane: pane(after(args, '--cwd'), 'w1:t1') })
    if (verb === 'tab create') return ok({ root_pane: pane(after(args, '--cwd'), 'w1:t2') })
    return ok({ agents: [] })
  })
  return calls
}

test('sessions of a project fill a 2×2 grid, then a new tab', async ($, on) => {
  const calls = grid(on)
  await ready($, on)
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    await $.tool.call({ tool: 'mcp__herd__spawn', name } as never)
  }

  const splits = calls.filter(args => args[1] === 'split').map(args => `${args[2]} ${args[4]}`)
  expect(splits).toEqual(['w1:p1 right', 'w1:p1 down', 'w1:p2 down'])
  expect(calls.filter(args => args[0] === 'tab').length).toBe(1)
})

test('a worktree joins its project grid, and sessions spawned at once do not collide', async ($, on) => {
  const calls = grid(on)
  await ready($, on)
  await $.tool.call({ tool: 'mcp__herd__spawn', name: 'a', folder: 'C:\\proj' } as never)
  await Promise.all(
    ['b', 'c'].map(name =>
      $.tool.call({ tool: 'mcp__herd__spawn', name, folder: `C:\\proj\\.worktrees\\${name}` } as never),
    ),
  )

  expect(calls.filter(args => args[0] === 'workspace' && args[1] === 'create').length).toBe(1)
  expect(calls.filter(args => args[1] === 'split').map(args => args[4])).toEqual(['right', 'down'])
})

test('a session gets its prompt once', async ($, on) => {
  const calls = grid(on)
  await ready($, on)

  await $.tool.call({ tool: 'mcp__herd__spawn', name: 'one', task: 'hi' } as never)
  await $.tool.call({ tool: 'mcp__herd__spawn', name: 'two' } as never)

  const prompts = calls.filter(args => args[1] === 'prompt')
  expect(prompts.length).toBe(1)
  expect(prompts[0]?.slice(0, 4)).toEqual(['agent', 'prompt', 'one', 'hi'])
})

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: [], tools: ['mcp__herd__spawn'], outputStyle: null, traits: [] }

test('the main session gets the workflow, a session inside herdr does not and cannot spawn', async ($, on) => {
  let ran = 0
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'x', scope: 'shared' }] }))
  on('process.run', () => {
    ran += 1
    return ok({})
  })
  await ready($, on)
  const ids = async () => (await $.prompt.compose(COMPOSE as never)).sections.map((one: { id: string }) => one.id)

  expect(await ids()).toEqual(['intro', 'herd:workflow'])

  herdrEnv.value = '1'
  expect(await ids()).toEqual(['intro'])
  const answer = await $.tool.call({ tool: 'mcp__herd__spawn', name: 'child' } as never)
  expect(answer.deny).toMatch(/không được tạo thêm/)
  expect(ran).toBe(0)
})

test('wait reports each session and a timeout is not an error', async ($, on) => {
  on('process.run', (_: unknown, e: { argv: string[] }) =>
    e.argv[3] === 'slow'
      ? { value: { exitCode: 1, stdout: '', stderr: '{"error":{"code":"timeout"}}' } }
      : ok({ agent: { agent_status: 'done' } }),
  )
  await ready($, on)

  const answer = await $.tool.call({ tool: 'mcp__herd__wait', names: ['fast', 'slow'] } as never)

  expect(JSON.parse(answer.result as string)).toEqual([
    { name: 'fast', status: 'done' },
    { name: 'slow', status: 'still working' },
  ])
})

test('a stalled prompt gets Enter again, never the text twice', async ($, on) => {
  const calls: string[][] = []
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    const args = e.argv.slice(1)
    calls.push(args)
    if (args[1] === 'prompt') {
      return { value: { exitCode: 1, stdout: '', stderr: '{"error":{"code":"agent_prompt_stalled"}}' } }
    }
    return ok({})
  })
  await ready($, on)

  const answer = await $.tool.call({ tool: 'mcp__herd__prompt', name: 'one', text: 'hi' } as never)

  expect(answer.deny).toBeUndefined()
  expect(calls.filter(args => args[1] === 'prompt').length).toBe(1)
  expect(calls[1]).toEqual(['agent', 'send-keys', 'one', 'enter'])
})

test('/herd asks for a normal turn and calls no tool itself', async ($, on) => {
  let toolCalls = 0
  on('process.run', () => ok({ agents: [] }))
  on('tool.call', () => {
    toolCalls += 1
    return { result: '' }
  })
  on('clock.after', () => ({ value: undefined }))
  const submitted = new Promise<string>(resolve => {
    on('prompt.submit', (_: unknown, e: { text: string }) => {
      resolve(e.text)
      return { text: e.text }
    })
  })
  await ready($, on)

  await $.command.run({ command: 'herd', args: '' })

  expect(await submitted).toMatch(/mcp__terminal__run_in_terminal/)
  expect(toolCalls).toBe(0)
})

const HERD_PANE = { ...CODE_PANE, requestId: 'herd', props: { ...CODE_PANE.props, title: 'Herd' } } as const

test('picking a folder shows only its sessions and new sessions start there', async ($, on) => {
  const calls: string[][] = []
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: [] }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('fs.read', () => ({
    value: JSON.stringify({ projects: { 'C:/work/app': {}, 'C:/work/api': {}, 'C:/x/scratch-workspaces/y': {} } }),
  }))
  on('clock.after', () => ({ value: undefined }))
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    const args = e.argv.slice(1)
    calls.push(args)
    if (args[1] === 'split') return ok({ pane: { pane_id: 'w3:p2' } })
    if (args[0] === 'pane') {
      return ok({ panes: [{ cwd: 'C:\\work\\app\\', workspace_id: 'w3', tab_id: 'w3:t1', pane_id: 'w3:p1' }] })
    }
    return ok({
      agents: [
        { name: 'in-app', pane_id: 'w3:p1', cwd: 'C:\\work\\app', agent_status: 'idle' },
        { name: 'in-api', pane_id: 'w4:p1', cwd: 'C:\\work\\api', agent_status: 'idle' },
      ],
    })
  })
  await ready($, on)
  await $.command.run({ command: 'herd', args: '' })
  const ui = await $.ui.mount(HERD_PANE)
  await $.tool.call({ tool: 'mcp__herd__list' } as never)

  expect(await ui.find({ key: 'folder-C:\\x\\scratch-workspaces\\y' })).toBeUndefined()
  await ui.press({ key: 'folder-C:\\work\\app' })

  expect(calls.some(args => args.join(' ') === 'workspace focus w3')).toBe(true)
  await $.tool.call({ tool: 'mcp__herd__spawn', name: 'three' } as never)
  const split = calls.find(args => args[1] === 'split')
  expect(split?.[split.indexOf('--cwd') + 1]).toBe('C:\\work\\app')
  await ui.unmount()
})

test('a task held behind a trust dialog is sent once, when the session is ready', async ($, on) => {
  const calls: string[][] = []
  let status = 'blocked'
  on('fs.exists', () => ({ value: true }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    const args = e.argv.slice(1)
    calls.push(args)
    if (args[1] === 'start') {
      return { value: { exitCode: 1, stdout: '', stderr: '{"error":{"code":"agent_not_ready"}}' } }
    }
    if (args[0] === 'pane') return ok({ panes: [] })
    if (args[0] === 'workspace') return ok({ root_pane: { pane_id: 'w1:p1' } })
    return ok({ agents: [{ name: 'one', pane_id: 'w1:p1', cwd: 'C:\\proj', agent_status: status }] })
  })
  await ready($, on)

  await $.tool.call({ tool: 'mcp__herd__spawn', name: 'one', task: 'build' } as never)
  expect(calls.filter(args => args[1] === 'prompt').length).toBe(0)

  status = 'idle'
  await $.tool.call({ tool: 'mcp__herd__spawn', name: 'bad name' } as never)
  await $.command.run({ command: 'herd', args: '' })
  await $.tool.call({ tool: 'mcp__herd__spawn', name: 'two' } as never)
  await $.tool.call({ tool: 'mcp__herd__spawn', name: 'tri' } as never)

  const prompts = calls.filter(args => args[1] === 'prompt')
  expect(prompts.length).toBe(1)
  expect(prompts[0]?.slice(2, 4)).toEqual(['one', 'build'])
})

test('a browsed folder is where the new session starts', async ($, on) => {
  const calls: string[][] = []
  on('fs.exists', () => ({ value: true }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    if (e.argv[0] === 'powershell') {
      return { value: { exitCode: 0, stdout: 'D:\\dự án\\web\r\n', stderr: '' } }
    }
    calls.push(e.argv.slice(1))
    if (e.argv[1] === 'pane') return ok({ panes: [] })
    if (e.argv[1] === 'workspace') return ok({ root_pane: { pane_id: 'w1:p1' } })
    return ok({ agents: [] })
  })
  await ready($, on)
  const ui = await $.ui.mount({ ...CODE_PANE, requestId: 'herd', props: { ...CODE_PANE.props, title: 'Herd' } })

  await ui.press({ key: 'browse' })
  await ui.input({ key: 'name-0', text: 'web', kind: 'change' })
  await ui.input({ key: 'task-0', text: '' })

  const created = calls.find(args => args[0] === 'workspace')
  expect(created?.[created.indexOf('--cwd') + 1]).toBe('D:\\dự án\\web')
  await ui.unmount()
})

test('a bad name never reaches herdr', async ($, on) => {
  let ran = 0
  on('process.run', () => {
    ran += 1
    return ok({})
  })
  await ready($, on)

  const answer = await $.tool.call({ tool: 'mcp__herd__spawn', name: 'Bad Name' } as never)

  expect(answer.deny).toMatch(/Tên session/)
  expect(ran).toBe(0)
})

async function editing($: any, on: any, disk: { mtime: number; text: string; written: string[] }) {
  on('fs.list', () => ({ value: [{ name: 'a.txt', kind: 'file', size: 1, mtimeMs: 1, isLink: false }] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: disk.mtime, isLink: false } }))
  on('fs.read', () => ({ value: disk.text }))
  on('fs.write', (_: unknown, e: { text: string }) => {
    disk.written.push(e.text)
    return { value: undefined }
  })
  await ready($, on)
  await $.command.run({ command: 'herd-code', args: 'C:\\proj' })
  const ui = await $.ui.mount(CODE_PANE)
  await ui.press({ key: 'entry-a.txt' })
  await ui.press({ key: 'edit' })
  return ui
}

test('saving keeps CRLF line endings', async ($, on) => {
  const disk = { mtime: 5, text: 'a\r\nb\r\n', written: [] as string[] }
  const ui = await editing($, on, disk)

  await ui.input({ key: 'editor-C:\\proj\\a.txt-5', text: 'a\nc\n' })

  expect(disk.written).toEqual(['a\r\nc\r\n'])
  await ui.unmount()
})

test('a file changed on disk is not overwritten', async ($, on) => {
  const disk = { mtime: 5, text: 'a\n', written: [] as string[] }
  const ui = await editing($, on, disk)

  disk.mtime = 6
  await ui.input({ key: 'editor-C:\\proj\\a.txt-5', text: 'mine\n' })

  expect(disk.written).toEqual([])
  expect((await ui.find({ type: 'Text', text: /Chưa lưu/ }))?.text).toMatch(/Chưa lưu/)
  await ui.unmount()
})
