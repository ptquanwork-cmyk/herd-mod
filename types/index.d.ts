export type Agent = {
  name: string
  paneId: string
  cwd: string
  status: string
}
export type Entry = { name: string; isDir: boolean }
export type OpenFile = { path: string; text: string; mtimeMs: number }

declare module 'claude-code' {
  interface PluginState {
    herd: {
      agents: Agent[]
      selected: string
      output: string
      note: string
      formFolder: string
      formName: string
      formNonce: number
      formPicked: string
      folders: string[]
      active: string
      pending: Record<string, string>
      dir: string
      entries: Entry[]
      file: OpenFile | null
      isEditing: boolean
      isStale: boolean
      draft: string
      codeNote: string
    }
  }
}
