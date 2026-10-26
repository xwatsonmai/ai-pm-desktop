import { describe, expect, it } from 'vitest'
import { commandLine } from '../src/core/executors/process.js'
import { findExecutor, type Machine } from '../src/main/find-executor.js'

describe('starting CLIs on Windows', () => {
  it('runs npm .cmd wrappers through cmd.exe with each argument escaped', () => {
    const cmd = commandLine('C:\\Users\\Ann Lee\\AppData\\Roaming\\npm\\claude.cmd', ['-p', '--json-schema', '{"type":"object","a":"x y"}', '--model', 'opus'], 'win32')
    expect(cmd.verbatim).toBe(true)
    expect(cmd.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    const line = cmd.args[3]
    // The program: spaces escaped for cmd.exe.
    expect(line.startsWith('"C:\\Users\\Ann^ Lee\\AppData\\Roaming\\npm\\claude.cmd ')).toBe(true)
    // Each argument quoted, inner quotes escaped, cmd.exe metacharacters escaped twice for the shim.
    expect(line).toContain('^^^"-p^^^"')
    expect(line).toContain('^^^"{\\^^^"type\\^^^":\\^^^"object\\^^^"^^^,\\^^^"a\\^^^":\\^^^"x^^^ y\\^^^"}^^^"')
    expect(line.endsWith('^^^"opus^^^""')).toBe(true)
  })

  it('starts .exe files and every program elsewhere directly', () => {
    expect(commandLine('C:\\tools\\codex.exe', ['exec', '-'], 'win32')).toEqual({ file: 'C:\\tools\\codex.exe', args: ['exec', '-'], verbatim: false })
    expect(commandLine('/usr/local/bin/claude.cmd', ['-p'], 'darwin')).toEqual({ file: '/usr/local/bin/claude.cmd', args: ['-p'], verbatim: false })
  })
})

describe('finding executors', () => {
  const windows = (files: string[], path = ''): Machine => ({
    platform: 'win32', home: 'C:\\Users\\ann',
    env: { LOCALAPPDATA: 'C:\\Users\\ann\\AppData\\Local', APPDATA: 'C:\\Users\\ann\\AppData\\Roaming', PATH: path },
    exists: (file) => files.includes(file),
  })

  it('finds Windows installs in their usual places', () => {
    expect(findExecutor('claude', windows(['C:\\Users\\ann\\.local\\bin\\claude.exe']))).toEqual({ binary: 'C:\\Users\\ann\\.local\\bin\\claude.exe' })
    expect(findExecutor('codex', windows(['C:\\Users\\ann\\AppData\\Roaming\\npm\\codex.cmd']))).toEqual({ binary: 'C:\\Users\\ann\\AppData\\Roaming\\npm\\codex.cmd' })
    const zcode = 'C:\\Users\\ann\\AppData\\Local\\Programs\\ZCode'
    expect(findExecutor('zcode', windows([zcode + '\\resources\\glm\\zcode.cjs', zcode + '\\ZCode.exe'])))
      .toEqual({ binary: zcode + '\\resources\\glm\\zcode.cjs', runtime: zcode + '\\ZCode.exe' })
  })

  it('falls back to PATH, with Windows executable extensions', () => {
    expect(findExecutor('codex', windows(['D:\\bin\\codex.exe'], 'C:\\Windows;D:\\bin'))).toEqual({ binary: 'D:\\bin\\codex.exe' })
    expect(findExecutor('claude', { platform: 'linux', home: '/home/ann', env: { PATH: '/usr/bin:/opt/claude/bin' }, exists: (f) => f === '/opt/claude/bin/claude' }))
      .toEqual({ binary: '/opt/claude/bin/claude' })
    expect(findExecutor('codex', windows([]))).toBeNull()
  })
})
