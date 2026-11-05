// Codex on Windows persists project trust into its own CODEX_HOME/config.toml.
// Accept only that metadata in our isolated home. Other settings (especially
// MCP, providers and hooks) must still fail closed, without deleting the file.
export function isCodexTrustConfig(text: string): boolean {
  const quoted = String.raw`"(?:[^"\\\r\n]|\\(?:["\\bfnrt]|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}))*"|'[^'\r\n]*'|[A-Za-z0-9_-]+`
  const trivia = String.raw`(?:[ \t\r\n]|\#[^\r\n]*(?:\r?\n|$))*`
  const trim = new RegExp('^' + trivia)
  const entry = new RegExp(String.raw`^\[projects\.(?:${quoted})\][ \t]*(?:\#[^\r\n]*)?\r?\n${trivia}trust_level[ \t]*=[ \t]*(?:"(?:trusted|untrusted)"|'(?:trusted|untrusted)')[ \t]*(?:\#[^\r\n]*)?(?:\r?\n|$)`)
  let remaining = text.replace(trim, '')
  while (remaining) {
    const match = entry.exec(remaining)
    if (!match) return false
    remaining = remaining.slice(match[0].length).replace(trim, '')
  }
  return true
}
