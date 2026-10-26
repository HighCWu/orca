// One validated v4 attachment transaction: begin, resumable chunks, commit, and best-effort abort.

import { createHash, randomUUID } from 'node:crypto'
import type { ZcodeAgentConnection } from '../zcode-protocol-connection'
import {
  V4_METHODS,
  ZCODE_V4_ATTACHMENT_MAX_BYTES,
  ZCODE_V4_ATTACHMENT_MAX_CHUNKS,
  zcodeV4AttachmentBeginResultSchema,
  zcodeV4AttachmentChunkResultSchema,
  zcodeV4AttachmentCommitResultSchema,
  type ZcodeV4AttachmentRef
} from './zcode-v4-protocol-messages'

/** 384KiB divides by 3, so every chunk but the last base64-encodes without padding, and the
 * envelope stays well inside the 1MiB physical frame cap. */
export const ATTACHMENT_UPLOAD_CHUNK_BYTES = 384 * 1024

export async function uploadZcodeV4Attachment(input: {
  connection: ZcodeAgentConnection
  connectionId: string
  sessionId: string
  fileName: string
  mime: string
  bytes: Buffer
  signal?: AbortSignal
}): Promise<ZcodeV4AttachmentRef> {
  input.signal?.throwIfAborted()
  if (input.bytes.byteLength > ZCODE_V4_ATTACHMENT_MAX_BYTES) {
    throw new Error('zcode v4: attachment exceeds the protocol byte limit')
  }
  const uploadId = `upload-${randomUUID()}`
  const common = { connectionId: input.connectionId, uploadId, sessionId: input.sessionId }
  const totalChunks = Math.ceil(input.bytes.byteLength / ATTACHMENT_UPLOAD_CHUNK_BYTES)
  if (totalChunks > ZCODE_V4_ATTACHMENT_MAX_CHUNKS) {
    throw new Error('zcode v4: attachment exceeds the protocol chunk limit')
  }
  const checksum = `sha256:${createHash('sha256').update(input.bytes).digest('hex')}`
  try {
    const begin = zcodeV4AttachmentBeginResultSchema.parse(
      await input.connection.request(
        V4_METHODS.attachmentBegin,
        {
          ...common,
          fileName: input.fileName,
          mime: input.mime,
          totalBytes: input.bytes.byteLength,
          totalChunks,
          checksum
        },
        undefined
      )
    )
    input.signal?.throwIfAborted()
    if (begin.uploadId !== uploadId || begin.nextChunkIndex > totalChunks) {
      throw new Error('zcode v4: attachment begin returned an invalid upload cursor')
    }
    if (begin.state === 'committed') {
      if (begin.nextChunkIndex !== totalChunks) {
        throw new Error('zcode v4: committed attachment did not confirm every chunk')
      }
      return attachmentRef(input, begin.ref)
    }
    for (let index = begin.nextChunkIndex; index < totalChunks; index += 1) {
      input.signal?.throwIfAborted()
      const chunk = zcodeV4AttachmentChunkResultSchema.parse(
        await input.connection.request(
          V4_METHODS.attachmentChunk,
          {
            ...common,
            chunkIndex: index,
            dataBase64: input.bytes
              .subarray(
                index * ATTACHMENT_UPLOAD_CHUNK_BYTES,
                (index + 1) * ATTACHMENT_UPLOAD_CHUNK_BYTES
              )
              .toString('base64')
          },
          undefined
        )
      )
      input.signal?.throwIfAborted()
      if (chunk.uploadId !== uploadId || chunk.nextChunkIndex !== index + 1) {
        throw new Error('zcode v4: attachment chunk did not advance its upload cursor')
      }
    }
    input.signal?.throwIfAborted()
    const commit = zcodeV4AttachmentCommitResultSchema.parse(
      await input.connection.request(V4_METHODS.attachmentCommit, common, undefined)
    )
    return attachmentRef(input, commit.ref)
  } catch (error) {
    await abortZcodeV4Attachment({ ...common, connection: input.connection })
    throw error
  }
}

export async function abortZcodeV4Attachment(input: {
  connection: ZcodeAgentConnection
  connectionId: string
  uploadId: string
  sessionId: string
}): Promise<void> {
  await input.connection
    .request(
      V4_METHODS.attachmentAbort,
      {
        connectionId: input.connectionId,
        uploadId: input.uploadId,
        sessionId: input.sessionId
      },
      undefined
    )
    .catch(() => undefined)
}

function attachmentRef(
  input: { fileName: string; mime: string; bytes: Buffer },
  ref: string
): ZcodeV4AttachmentRef {
  return { ref, fileName: input.fileName, mime: input.mime, bytes: input.bytes.byteLength }
}
