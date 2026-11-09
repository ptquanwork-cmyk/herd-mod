import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agent, Entry, OpenFile } from '../types'

type E = EngineInterface

const HERD = 'herd'
const CODE = 'herd-code'
const POLL_MS = 2500
// ponytail: an Input draws 100k chars at most; editing past that would save a cut file
const MAX_EDIT = 90_000

const agents = atom({ plugin: 'herd', key: 'agents' } as const, [] as Agent[])
const selected = atom({ plugin: 'herd', key: 'selected' } as const, '')
const output = atom({ plugin: 'herd', key: 'output' } as const, '')
const note = atom({ plugin: 'herd', key: 'note' } as const, '')
const formFolder = atom({ plugin: 'herd', key: 'formFolder' } as const, '')
const formName = atom({ plugin: 'herd', key: 'formName' } as const, '')
const formNonce = atom({ plugin: 'herd', key: 'formNonce' } as const, 0)
const formPicked = atom({ plugin: 'herd', key: 'formPicked' } as const, '')
const folders = atom({ plugin: 'herd', key: 'folders' } as const, [] as string[])
const active = atom({ plugin: 'herd', key: 'active' } as const, '')
const pending = atom({ plugin: 'herd', key: 'pending' } as const, {} as Record<string, string>)
const dir = atom({ plugin: 'herd', key: 'dir' } as const, '')
const entries = atom({ plugin: 'herd', key: 'entries' } as const, [] as Entry[])
const file = atom({ plugin: 'herd', key: 'file' } as const, null as OpenFile | null)
const isEditing = atom({ plugin: 'herd', key: 'isEditing' } as const, false)
const isStale = atom({ plugin: 'herd', key: 'isStale' } as const, false)
const draft = atom({ plugin: 'herd', key: 'draft' } as const, '')
const codeNote = atom({ plugin: 'herd', key: 'codeNote' } as const, '')

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))
const clean = (path: string) => path.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
const baseOf = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
const parentOf = (path: string) => path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '') || path
const join = (folder: string, name: string) => {
  const sep = folder.includes('\\') ? '\\' : '/'
  return folder.replace(/[\\/]+$/, '') + sep + name
}

async function herdr($: E, args: string[], timeoutMs = 30_000) {
  let ran
  try {
    ran = await $.process.run(['herdr', ...args], { timeoutMs })
  } catch (err) {
    throw new Error(`Không chạy được herdr (đã cài chưa?): ${messageOf(err)}`)
  }
  if (ran.exitCode !== 0) {
    throw new Error(ran.stderr.trim() || ran.stdout.trim() || `herdr thoát với mã ${ran.exitCode}`)
  }
  return ran.stdout
}

const herdrJson = async ($: E, args: string[]) => JSON.parse(await herdr($, args)).result

async function listAgents($: E): Promise<Agent[]> {
  const result = await herdrJson($, ['agent', 'list'])
  return (result.agents ?? []).map((one: Record<string, string>) => ({
    name: one.name ?? one.pane_id,
    paneId: one.pane_id,
    cwd: one.cwd ?? '',
    status: one.agent_status ?? 'unknown',
  }))
}

async function refresh($: E) {
  try {
    const list = await listAgents($)
    await update($, agents, old => (JSON.stringify(old) === JSON.stringify(list) ? old : list))
    await update($, note, old => (old.startsWith('herdr: ') ? '' : old))
    const waiting = await read($, pending)
    for (const one of list) {
      const task = waiting[one.name]
      if (task === undefined || (one.status !== 'idle' && one.status !== 'done')) continue
      // Drop it first: polls overlap, and a task must never be sent twice.
      await update($, pending, old => Object.fromEntries(Object.entries(old).filter(([key]) => key !== one.name)))
      await submit($, one.name, task)
    }
    const name = await read($, selected)
    if (name && list.some(one => one.name === name)) {
      const text = await herdr($, ['agent', 'read', name, '--source', 'recent-unwrapped', '--lines', '60'])
      await update($, output, () => text)
    }
  } catch (err) {
    await update($, note, () => `herdr: ${messageOf(err)}`)
  }
}

/** Puts a folder at the top of the recents. Never worth failing the real work over. */
async function remember($: E, path: string) {
  try {
    const old = ((await $.store.get('recent')) ?? []) as string[]
    await $.store.set('recent', [path, ...old.filter(one => clean(one) !== clean(path))].slice(0, 40))
  } catch {
    // ponytail: recents are a convenience
  }
}

/** Folders worked in: this mod's recents first, then every project Claude Code knows. */
async function loadFolders($: E) {
  const home = await $.env.get('USERPROFILE')
  if (home === undefined) return
  const config = JSON.parse(await $.fs.read(join(home, '.claude.json')))
  // ponytail: key order is first-seen, so newest-first is approximate past the recents
  const known = Object.keys(config.projects ?? {}).reverse().map(path => path.replaceAll('/', '\\'))
  const recent = ((await $.store.get('recent')) ?? []) as string[]
  const seen = new Set<string>()
  const unique = [...recent, ...known].filter(path => {
    if (seen.has(clean(path)) || /scratch-workspaces|\\Temp\\|worktrees/i.test(path)) return false
    seen.add(clean(path))
    return true
  })
  const alive = await Promise.all(unique.slice(0, 60).map(path => $.fs.exists(path)))
  await update($, folders, () => unique.slice(0, 60).filter((_, index) => alive[index]))
}

/** Sends a prompt and confirms the agent took it: a plain `agent prompt` can leave it unsent. */
async function submit($: E, name: string, text: string) {
  try {
    await herdr($, ['agent', 'prompt', name, text, '--wait', '--until', 'working', '--until', 'blocked', '--timeout', '20000'], 25_000)
  } catch (err) {
    if (!messageOf(err).includes('agent_prompt_stalled')) throw err
    // Seen right after startup: the text reaches the box and Enter is lost. Never resend the text.
    await herdr($, ['agent', 'send-keys', name, 'enter'])
  }
}

const WORKFLOW = `# Herd workflow

This is the user's standing instruction. When the user gives a task that changes files and has parts that can run independently, do it with parallel herdr sessions instead of alone. Answer questions and make small single-file changes directly.

1. Split the task into 2 to 4 parts that touch different files or regions.
2. In a git repository, make one worktree per part: git worktree add <project>/.worktrees/<name> -b herd/<name>, with .worktrees/ listed in .git/info/exclude. Worktrees start from the last commit, so ask before committing uncommitted work. If the folder is not a git repository, ask before running git init.
3. If herdr is not running, start \`herdr\` with the Terminal panel tool. Call mcp__herd__spawn once per part, with folder set to its worktree and a task that names its scope and says: commit on the current branch when done; do not merge or push.
4. Call mcp__herd__wait with all the names, again while any is still working. A blocked session needs the user: tell them to answer it in the Herd pane.
5. Read each result with mcp__herd__read and review each branch's commits. Run the project's tests or checks on each branch.
6. Merge the branches that pass into the starting branch one at a time with --no-ff, resolving conflicts. Run the tests again on the merged result. Report what each part did, the test results and anything left unmerged. Never push unless asked.`

type PaneRow = { cwd?: string; workspace_id: string; tab_id: string; pane_id: string }

// A worktree under <project>/.worktrees/ belongs on its project's grid.
const projectOf = (path: string) => clean(path).replace(/\\\.worktrees\\[^\\]+$/, '')

// Chats spawn several at once; each placement must see the panes the last one made.
let placing: Promise<unknown> = Promise.resolve()
function inOrder<T>(work: () => Promise<T>) {
  const run = placing.then(work, work)
  placing = run.catch(() => undefined)
  return run
}

/** A shell pane for the next session: a 2×2 grid in the project's last tab, then a new tab. */
async function placePane($: E, cwd: string, name: string): Promise<{ paneId: string; workspaceId?: string }> {
  const { panes = [] } = (await herdrJson($, ['pane', 'list'])) as { panes?: PaneRow[] }
  const home = panes.find(one => one.cwd && projectOf(one.cwd) === projectOf(cwd))
  if (home === undefined) {
    const made = await herdrJson($, ['workspace', 'create', '--cwd', cwd, '--label', baseOf(cwd), '--no-focus'])
    return { paneId: made.root_pane.pane_id, workspaceId: made.root_pane.workspace_id }
  }
  const workspaceId = home.workspace_id
  const inWorkspace = panes.filter(one => one.workspace_id === workspaceId)
  const lastTab = inWorkspace[inWorkspace.length - 1]?.tab_id
  const inTab = inWorkspace.filter(one => one.tab_id === lastTab)
  if (inTab.length >= 4) {
    const made = await herdrJson($, ['tab', 'create', '--workspace', workspaceId, '--cwd', cwd, '--label', name, '--no-focus'])
    return { paneId: made.root_pane.pane_id, workspaceId }
  }
  // 1 pane: a column to its right. 2: under the left one. 3: under the right one.
  const target = inTab[inTab.length === 3 ? 1 : 0] as PaneRow
  const direction = inTab.length === 1 ? 'right' : 'down'
  const made = await herdrJson($, ['pane', 'split', target.pane_id, '--direction', direction, '--cwd', cwd, '--no-focus'])
  return { paneId: made.pane.pane_id, workspaceId }
}

/** Sessions of a project share a grid, so they are all on screen at once. */
async function spawn($: E, input: { name: string; task?: string; folder?: string }) {
  const { name, task } = input
  // Spawned sessions load this mod too; without this stop they could spawn without end.
  if (await $.env.get('HERDR_ENV')) throw new Error('Session trong herdr không được tạo thêm session.')
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
    throw new Error('Tên session phải khớp [a-z][a-z0-9_-]{0,31}.')
  }
  const cwd = input.folder?.trim() || (await read($, active)) || (await $.session.root())
  if (!(await $.fs.exists(cwd))) throw new Error(`Không có thư mục ${cwd}.`)
  await remember($, cwd)

  const { paneId, workspaceId } = await inOrder(() => placePane($, cwd, name))
  if (workspaceId) await herdr($, ['workspace', 'focus', workspaceId])

  try {
    await herdr($, ['agent', 'start', name, '--kind', 'claude', '--pane', paneId, '--timeout', '60000'], 70_000)
  } catch (err) {
    if (!messageOf(err).includes('agent_not_ready')) throw err
    if (task) await update($, pending, old => ({ ...old, [name]: task }))
    return `${name} đã mở ở ${cwd} nhưng đang chờ người dùng xác nhận trong pane Herd (ví dụ tin cậy thư mục).${task ? ' Task sẽ tự gửi khi session sẵn sàng, miễn là pane Herd còn mở.' : ''}`
  }
  if (task) await submit($, name, task)
  return `${name} đang chạy ở ${cwd}${task ? ' và đã nhận task' : ''}.`
}

// A mod's own $.tool.call gets no auto-mode verdict, so Claude makes these calls in a normal
// turn, reviewed like any other. ponytail: costs one small turn per /herd.
const TUI_PROMPT =
  "Show herdr's UI in the Terminal panel, and do nothing else. Load these tools with ToolSearch if needed. " +
  "Call mcp__terminal__list_terminal_tabs. If a tab titled herdr has is_running_command not false, use it. " +
  "Otherwise call mcp__terminal__run_in_terminal with command herdr and title herdr. " +
  'Then call mcp__ccd_view__show_pane with pane terminal and that tab_id. Reply in one short line.'

const showTui = ($: E) => $.prompt.submit({ text: TUI_PROMPT })

// ponytail: Windows only; another OS needs its own picker command here
const PICK_FOLDER =
  'Add-Type -AssemblyName System.Windows.Forms;' +
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog;' +
  '$d.SelectedPath = $env:HERD_START;' +
  '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true };' +
  "if ($d.ShowDialog($owner) -eq 'OK') {" +
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write($d.SelectedPath) }'

/** The folder picked in Windows' own dialog, or '' when cancelled. */
async function pickFolder($: E, start: string) {
  const ran = await $.process.run(['powershell', '-NoProfile', '-STA', '-Command', PICK_FOLDER], {
    env: { HERD_START: start },
    timeoutMs: 600_000,
  })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || 'Không mở được hộp chọn thư mục.')
  return ran.stdout.trim()
}

async function openDir($: E, path: string) {
  const listed = await $.fs.list(path)
  const rows = listed
    .filter(one => one.name !== '.git')
    .map(one => ({ name: one.name, isDir: one.kind === 'dir' }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
  await update($, dir, () => path)
  await update($, entries, () => rows)
}

async function openFile($: E, path: string) {
  // stat before read: a write between the two reads as a conflict, never a lost edit
  const { mtimeMs } = await $.fs.stat(path)
  const text = await $.fs.read(path)
  if (text.includes('\0')) throw new Error('File nhị phân, không mở được ở đây.')
  await update($, file, () => ({ path, text, mtimeMs }))
  await update($, isEditing, () => false)
  await update($, isStale, () => false)
  await update($, codeNote, () => '')
}

async function save($: E, value: string, force: boolean) {
  const open = await read($, file)
  if (open === null) return
  const { mtimeMs } = await $.fs.stat(open.path)
  if (!force && mtimeMs !== open.mtimeMs) {
    await update($, isStale, () => true)
    await update($, codeNote, () => 'File vừa bị sửa ở nơi khác (có thể là một agent). Chưa lưu.')
    return
  }
  await $.fs.write(open.path, open.text.includes('\r\n') ? value.replace(/\r?\n/g, '\r\n') : value)
  await openFile($, open.path)
  await update($, codeNote, () => `Đã lưu ${baseOf(open.path)}.`)
}

async function openVsCode($: E, path: string) {
  // ponytail: code is a .cmd, so it needs cmd; a metacharacter in the path would be parsed
  if (/[&|<>^%"]/.test(path)) throw new Error('Đường dẫn có ký tự đặc biệt, hãy mở VS Code thủ công.')
  const ran = await $.process.run(['cmd', '/c', 'code', path])
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || 'Không mở được VS Code.')
}

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const isPlain = !e.traits.some(trait => ['bare', 'lean', 'teammate', 'analysis'].includes(trait))
    if (!isPlain || !e.tools.includes('mcp__herd__spawn') || (await $.env.get('HERDR_ENV'))) return composed
    return { sections: [...composed.sections, { id: 'herd:workflow', text: WORKFLOW, scope: 'session' as const }] }
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'herd', description: 'Mở pane điều phối các session herdr' })
    await $.command.register({
      name: 'herd-code',
      description: 'Mở pane xem và sửa code',
      argumentHint: '[thư mục]',
    })
    await $.tool.register({
      name: 'spawn',
      description:
        'Start a new interactive Claude session on the project\'s herdr grid (2×2 per tab). Use when the user asks for parallel Claude sessions or herdr work. folder defaults to this session\'s folder. When sessions will edit the same project in parallel, give each its own git worktree at <project>/.worktrees/<name> and merge the branches afterwards. Requires the herdr server: if it is not running, start `herdr` with the Terminal panel tool, then retry.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Unique name: [a-z][a-z0-9_-]{0,31}' },
          task: { type: 'string', description: 'First prompt to send to the session' },
          folder: { type: 'string', description: 'Absolute folder to work in' },
        },
        required: ['name'],
      },
    })
    await $.tool.register({
      name: 'wait',
      description:
        'Wait until the named herdr sessions settle (done, idle or blocked), up to 9 minutes. Returns each status; call again for any still working.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: { names: { type: 'array', items: { type: 'string' } } },
        required: ['names'],
      },
    })
    await $.tool.register({
      name: 'list',
      description: 'List herdr agent sessions with folder and status (working, blocked, idle, done).',
      isDeferred: false,
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'read',
      description: 'Read the recent terminal output of a herdr session.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, lines: { type: 'number' } },
        required: ['name'],
      },
    })
    await $.tool.register({
      name: 'prompt',
      description:
        'Send a prompt to a herdr session. With wait, returns when it settles (up to 10 minutes). Fails on a session blocked at an approval: the user answers those in the herd pane.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          text: { type: 'string' },
          wait: { type: 'boolean' },
        },
        required: ['name', 'text'],
      },
    })
    $.clock.every(POLL_MS, async () => {
      const panes = await $.ui.panes()
      if (panes.some(one => one.id === HERD)) await refresh($)
    })
    return started
  })

  on('command.run', { command: 'herd' }, async $ => {
    await $.ui.open({ id: HERD, title: 'Herd' })
    await loadFolders($).catch(err => update($, note, () => `Chưa đọc được danh sách folder: ${messageOf(err)}`))
    // A command.run hook may not submit a prompt: the turn it would start waits on this hook.
    $.clock.after(100, () => {
      void showTui($).catch(err => update($, note, () => `Chưa hiện được herdr: ${messageOf(err)}`))
    })
    return { text: 'Đã mở pane Herd, đang bật herdr trong Terminal.' }
  })

  on('command.run', { command: 'herd-code' }, async ($, e) => {
    await openDir($, e.args.trim() || (await read($, dir)) || (await $.session.root()))
    await $.ui.open({ id: CODE, title: 'Code' })
    return { text: 'Đã mở pane Code.' }
  })

  const answer = async (run: () => Promise<string>) => {
    try {
      return { result: await run() }
    } catch (err) {
      return { deny: messageOf(err) }
    }
  }

  on('tool.call', { tool: 'mcp__herd__spawn' }, ($, e) =>
    answer(async () => {
      const text = await spawn($, e as unknown as { name: string; task?: string; folder?: string })
      void $.ui.open({ id: HERD, title: 'Herd' })
      await loadFolders($).catch(() => undefined)
      await refresh($)
      return text
    }),
  )
  on('tool.call', { tool: 'mcp__herd__wait' }, ($, e) =>
    answer(async () => {
      const { names } = e as unknown as { names: string[] }
      const settled = await Promise.all(
        names.map(async name => {
          try {
            const args = ['agent', 'wait', name, '--until', 'done', '--until', 'idle', '--until', 'blocked', '--timeout', '540000']
            const { result } = JSON.parse(await herdr($, args, 560_000))
            return { name, status: result.agent.agent_status as string }
          } catch (err) {
            return messageOf(err).includes('timeout')
              ? { name, status: 'still working' }
              : { name, status: 'error', detail: messageOf(err) }
          }
        }),
      )
      return JSON.stringify(settled)
    }),
  )
  on('tool.call', { tool: 'mcp__herd__list' }, $ =>
    answer(async () => JSON.stringify(await listAgents($))),
  )
  on('tool.call', { tool: 'mcp__herd__read' }, ($, e) =>
    answer(() => {
      const input = e as unknown as { name: string; lines?: number }
      return herdr($, ['agent', 'read', input.name, '--source', 'recent-unwrapped', '--lines', String(input.lines ?? 120)])
    }),
  )
  on('tool.call', { tool: 'mcp__herd__prompt' }, ($, e) =>
    answer(async () => {
      const input = e as unknown as { name: string; text: string; wait?: boolean }
      await submit($, input.name, input.text)
      return input.wait
        ? herdr($, ['agent', 'wait', input.name, '--timeout', '590000'], 600_000)
        : `Đã gửi cho ${input.name}.`
    }),
  )

  on('ui.render', { component: 'Pane', requestId: HERD }, async ($, e) => {
    const ui = $.ui.resolve(e)
    if (!('Input' in ui)) return <ui.Text>Pane này cần bản desktop hoặc terminal.</ui.Text>
    const { Box, Text, Button, Input, Code } = ui
    const list = await read($, agents)
    const chosen = await read($, selected)
    const shown = await read($, output)
    const message = await read($, note)
    const nonce = await read($, formNonce)
    const picked = await read($, formPicked)
    const worked = await read($, folders)
    const activeFolder = await read($, active)
    const root = activeFolder || (await $.session.root())
    // Subfolders count, so sessions in a project's worktrees show under the project.
    const inFolder = (path: string) =>
      list.filter(one => clean(one.cwd) === clean(path) || clean(one.cwd).startsWith(`${clean(path)}\\`))
    const visible = activeFolder ? inFolder(activeFolder) : list
    const moveTo = (path: string) =>
      act(async () => {
        await update($, active, () => path)
        await update($, selected, () => '')
        await update($, output, () => '')
        await update($, formPicked, () => '')
        await update($, formFolder, () => '')
        if (path === '') return
        await remember($, path)
        await openDir($, path)
        const { panes = [] } = await herdrJson($, ['pane', 'list'])
        const home = panes.find((one: { cwd?: string }) => one.cwd && clean(one.cwd) === clean(path))
        if (home) await herdr($, ['workspace', 'focus', home.workspace_id])
      })
    const current = list.find(one => one.name === chosen)
    const act = (work: () => Promise<unknown>) => () =>
      void work().catch(err => update($, note, () => messageOf(err)))
    const keys = (name: string, key: string) =>
      act(async () => {
        await herdr($, ['agent', 'send-keys', name, key])
        await refresh($)
      })
    const submitSpawn = (task: string) =>
      void (async () => {
        const name = await read($, formName)
        const folder = (await read($, formFolder)) || root
        try {
          await update($, note, () => `Đang tạo ${name}...`)
          const text = await spawn($, { name, folder, task: task || undefined })
          await update($, note, () => text)
          await update($, formName, () => '')
          await update($, formFolder, () => '')
          await update($, formPicked, () => '')
          await update($, formNonce, n => n + 1)
          await refresh($)
        } catch (err) {
          await update($, note, () => messageOf(err))
        }
      })()

    return (
      <Box flexDirection="column" gap={1}>
        {message !== '' && <Text color="warning">{message}</Text>}
        <Box flexDirection="row" gap={1}>
          <Button
            key="tui"
            label="Hiện herdr trong Terminal"
            onPress={act(() => showTui($))}
          />
        </Box>

        <Input
          key={`team-${nonce}`}
          label="Giao việc cho cả đội"
          placeholder="Claude tự chia thành nhiều session, chạy, kiểm tra rồi merge"
          submitLabel="giao"
          onSubmit={value => {
            if (value.trim() === '') return
            void $.prompt
              .submit({ text: `Làm task này theo quy trình Herd, trong folder ${root}:\n\n${value.trim()}` })
              .then(() => update($, formNonce, n => n + 1))
              .catch(err => update($, note, () => messageOf(err)))
          }}
        />

        <Box flexDirection="column">
          <Text bold>Sessions{activeFolder ? ` · ${baseOf(activeFolder)}` : ''}</Text>
          {visible.length === 0 && <Text dimColor>Chưa có session nào.</Text>}
          {visible.map(one => (
            <Button
              key={`agent-${one.name}`}
              plain
              onPress={act(async () => {
                await update($, selected, () => one.name)
                await update($, output, () => '')
                await refresh($)
              })}
            >
              {one.status === 'blocked' ? '! ' : one.name === chosen ? '> ' : '  '}
              {one.name} <Text dimColor>{one.status} · {baseOf(one.cwd)}</Text>
            </Button>
          ))}
        </Box>

        {current !== undefined && (
          <Box flexDirection="column" gap={1}>
            <Code source={shown || '(chưa có output)'} language="text" wrap="truncate-end" />
            <Box flexDirection="row" gap={1}>
              <Button key="up" label="↑" onPress={keys(current.name, 'up')} />
              <Button key="down" label="↓" onPress={keys(current.name, 'down')} />
              <Button key="enter" label="Enter" onPress={keys(current.name, 'enter')} />
              <Button key="esc" label="Esc" onPress={keys(current.name, 'esc')} />
              <Button key="ctrlc" label="Ctrl+C" onPress={keys(current.name, 'ctrl+c')} />
            </Box>
            <Input
              key={`send-${current.name}-${nonce}`}
              label="Gửi"
              placeholder="Nhập prompt cho session này"
              submitLabel="gửi"
              onSubmit={value =>
                void submit($, current.name, value)
                  .then(() => update($, formNonce, n => n + 1))
                  .catch(err => update($, note, () => messageOf(err)))
              }
            />
          </Box>
        )}

        <Box flexDirection="column">
          <Text bold>Session mới</Text>
          <Input
            key={`name-${nonce}`}
            label="Tên"
            placeholder="vd. frontend"
            onInput={value => void update($, formName, () => value.trim())}
            onSubmit={() => undefined}
          />
          <Box flexDirection="row" gap={1}>
            <Input
              key={`folder-${nonce}-${picked}`}
              label="Thư mục"
              value={picked || root}
              onInput={value => void update($, formFolder, () => value.trim())}
              onSubmit={() => undefined}
            />
            <Button
              key="browse"
              label="Duyệt…"
              onPress={act(async () => {
                const path = await pickFolder($, picked || root)
                if (path === '') return
                await update($, formPicked, () => path)
                await update($, formFolder, () => path)
              })}
            />
          </Box>
          <Input
            key={`task-${nonce}`}
            label="Task"
            placeholder="Enter để tạo session"
            submitLabel="tạo"
            onSubmit={submitSpawn}
          />
        </Box>

        <Box flexDirection="column">
          <Text bold>Folder đã làm việc</Text>
          {activeFolder !== '' && (
            <Button key="all-folders" plain onPress={moveTo('')}>
              ← Tất cả folder
            </Button>
          )}
          {worked.length === 0 && <Text dimColor>Chưa có folder nào.</Text>}
          {worked.map(path => (
            <Button key={`folder-${path}`} plain onPress={moveTo(path)}>
              {clean(path) === clean(activeFolder) ? '> ' : '  '}
              {baseOf(path)} <Text dimColor>{inFolder(path).length || ''} {path}</Text>
            </Button>
          ))}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: CODE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    if (!('Input' in ui)) return <ui.Text>Pane này cần bản desktop hoặc terminal.</ui.Text>
    const { Box, Text, Button, Input, Code } = ui
    const folder = await read($, dir)
    const rows = await read($, entries)
    const open = await read($, file)
    const editing = await read($, isEditing)
    const stale = await read($, isStale)
    const message = await read($, codeNote)
    const room = Math.max(10, (e.viewport?.rows ?? 30) - 8)
    const act = (work: () => Promise<unknown>) => () =>
      void work().catch(err => update($, codeNote, () => messageOf(err)))

    return (
      <Box flexDirection="column" gap={1}>
        <Input
          key={`dir-${folder}`}
          label="Thư mục"
          value={folder}
          submitLabel="mở"
          onSubmit={value =>
            void openDir($, value.trim()).catch(err => update($, codeNote, () => messageOf(err)))
          }
        />
        <Box flexDirection="row" gap={1}>
          <Button
            key="browse"
            label="Duyệt…"
            onPress={act(async () => {
              const path = await pickFolder($, folder)
              if (path !== '') await openDir($, path)
            })}
          />
          <Button key="up" label="Lên trên" onPress={act(() => openDir($, parentOf(folder)))} />
          <Button key="vscode" label="Mở bằng VS Code" onPress={act(() => openVsCode($, folder))} />
        </Box>
        {message !== '' && <Text color="warning">{message}</Text>}
        <Box flexDirection="row" gap={2}>
          <Box flexDirection="column" width="30%">
            {rows.slice(0, 300).map(one => (
              <Button
                key={`entry-${one.name}`}
                plain
                onPress={act(() =>
                  one.isDir ? openDir($, join(folder, one.name)) : openFile($, join(folder, one.name)),
                )}
              >
                {one.isDir ? `${one.name}/` : one.name}
              </Button>
            ))}
          </Box>
          <Box flexDirection="column" flexGrow={1} gap={1}>
            {open === null && <Text dimColor>Chọn một file để xem.</Text>}
            {open !== null && !editing && (
              <Box flexDirection="column" gap={1}>
                <Box flexDirection="row" gap={1}>
                  <Text bold>{baseOf(open.path)}</Text>
                  <Button
                    key="edit"
                    label="Sửa"
                    variant="primary"
                    onPress={act(async () => {
                      if (open.text.length > MAX_EDIT) {
                        throw new Error('File quá lớn để sửa ở đây, hãy dùng VS Code.')
                      }
                      await update($, draft, () => open.text)
                      await update($, isEditing, () => true)
                    })}
                  />
                  <Button key="reload" label="Tải lại" onPress={act(() => openFile($, open.path))} />
                </Box>
                <Code source={open.text} path={open.path} startLine={1} />
              </Box>
            )}
            {open !== null && editing && (
              <Box flexDirection="column" gap={1}>
                <Text bold>Đang sửa {baseOf(open.path)} <Text dimColor>Enter để lưu, Shift+Enter xuống dòng</Text></Text>
                <Input
                  key={`editor-${open.path}-${open.mtimeMs}`}
                  rows={room}
                  value={open.text}
                  autoFocus
                  submitLabel="lưu"
                  onInput={value => void update($, draft, () => value)}
                  onSubmit={value =>
                    void save($, value, false).catch(err => update($, codeNote, () => messageOf(err)))
                  }
                />
                <Box flexDirection="row" gap={1}>
                  <Button
                    key="save"
                    label="Lưu"
                    variant="primary"
                    onPress={act(async () => save($, await read($, draft), false))}
                  />
                  {stale && (
                    <Button key="force" label="Vẫn ghi đè" onPress={act(async () => save($, await read($, draft), true))} />
                  )}
                  <Button key="cancel" label="Huỷ" onPress={act(() => openFile($, open.path))} />
                </Box>
              </Box>
            )}
          </Box>
        </Box>
      </Box>
    )
  })
}
