// Keep the SDK's standard discovery first. A reverse proxy may expose only
// /<mount>/, so retry its 404 at the equivalent metadata URL inside that mount.
// Return OAuth metadata through the OAuth discovery request: the platform's
// metadata is not an OpenID provider document (it has no ID-token fields).
export function platformOAuthFetch(serverUrl: string, fetchFn: typeof fetch = fetch): typeof fetch {
  const server = new URL(serverUrl)
  const resourcePath = server.pathname.replace(/\/+$/, '')
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    let mountedPath: string | undefined
    if (method.toUpperCase() === 'GET') {
      if (url.origin === server.origin && resourcePath.endsWith('/mcp') && resourcePath !== '/mcp'
        && url.pathname === '/.well-known/oauth-protected-resource' + resourcePath) {
        mountedPath = resourcePath.slice(0, -'/mcp'.length) + '/.well-known/oauth-protected-resource/mcp'
      }
      const issuerPath = /^\/\.well-known\/oauth-authorization-server(\/.+)$/.exec(url.pathname)?.[1]
      if (issuerPath) mountedPath = issuerPath.replace(/\/+$/, '') + '/.well-known/oauth-authorization-server'
    }
    const response = await fetchFn(input, init)
    if (response.status !== 404 || !mountedPath) return response
    await response.body?.cancel()
    url.pathname = mountedPath
    return fetchFn(url, init)
  }
}
