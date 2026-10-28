import net from 'node:net'

// Node 24.22's bundled fetch (undici 7.29) sets the type of service on the first
// request of every new connection and lets a failure escape as an uncaught
// exception. macOS fails it with EINVAL when the server has already reset the
// connection, so a platform restart could pop an error dialog in the app. The
// setting is best effort: ignore the failure and let the request fail and retry.
export function guardTypeOfService(proto: { setTypeOfService?(tos: number): unknown }) {
  const set = proto.setTypeOfService
  if (!set) return
  proto.setTypeOfService = function (this: unknown, tos: number) {
    try {
      return set.call(this, tos)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.syscall !== 'setTypeOfService') throw error
      return this
    }
  }
}

guardTypeOfService(net.Socket.prototype)
