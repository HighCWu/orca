import { describe, expect, it, vi } from 'vitest'
import type { ZcodeAgentConnection } from '../zcode-protocol-connection'
import { uploadZcodeV4Attachment } from './zcode-v4-attachment-upload'

function connection(request: ZcodeAgentConnection['request']): ZcodeAgentConnection {
  return {
    request,
    respond: vi.fn(),
    respondError: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    probe: vi.fn(async () => {}),
    spawned: Promise.resolve(),
    pid: undefined,
    exited: false,
    stderrTail: () => '',
    onExit: vi.fn(),
    close: vi.fn(async () => true)
  }
}

describe('zcode v4 attachment upload cancellation', () => {
  it('does not stage an attachment when already cancelled', async () => {
    const request = vi.fn()
    const reason = new Error('cancelled before upload')

    await expect(
      uploadZcodeV4Attachment({
        connection: connection(request),
        connectionId: 'connection-1',
        sessionId: 'session-1',
        fileName: 'shot.png',
        mime: 'image/png',
        bytes: Buffer.from('payload'),
        signal: AbortSignal.abort(reason)
      })
    ).rejects.toBe(reason)
    expect(request).not.toHaveBeenCalled()
  })

  it('aborts staging without sending chunks when cancelled after begin', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled during upload')
    const methods: string[] = []
    const request = vi.fn(async (method: string, params?: unknown) => {
      methods.push(method)
      if (method === 'v4/attachment/begin') {
        controller.abort(reason)
        const uploadId =
          params && typeof params === 'object' && 'uploadId' in params ? params.uploadId : null
        return { state: 'staging', uploadId, nextChunkIndex: 0 }
      }
      return {}
    })

    await expect(
      uploadZcodeV4Attachment({
        connection: connection(request),
        connectionId: 'connection-1',
        sessionId: 'session-1',
        fileName: 'shot.png',
        mime: 'image/png',
        bytes: Buffer.from('payload'),
        signal: controller.signal
      })
    ).rejects.toBe(reason)
    expect(methods).toEqual(['v4/attachment/begin', 'v4/attachment/abort'])
  })
})
