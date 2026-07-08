/**
 * Express routes for the Data Agent.
 *
 *   POST /api/data-agent/chat          -> SSE stream of one agent turn
 *   POST /api/data-agent/upload        -> upload a file into the thread's sandbox
 *   GET  /api/data-agent/download/:id  -> download a saved artifact
 *   GET  /api/data-agent/threads?userId= -> list a user's conversations
 *   GET  /api/data-agent/threads/:id/messages  -> reload a conversation's history
 *   DELETE /api/data-agent/threads/:id -> delete a conversation from the list
 *   GET  /api/data-agent/threads/:id/artifacts -> list artifacts for a thread
 */
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';

import { getArtifact, listByThread } from './artifactStore';
import {
  deriveTitle,
  listConversations,
  upsertConversation,
  deleteConversation,
} from './conversationStore';
import { getThreadMessages } from './graph';
import { runAgentStream } from './streaming';
import { sandboxManager, UPLOADS_DIR_IN_SANDBOX } from './sandboxManager';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

export const dataAgentRouter = Router();

// ---------------------------------------------------------------------------
// POST /chat — stream one agent turn as Server-Sent Events.
// Body: { threadId?, userId?, message, model? }
// ---------------------------------------------------------------------------
dataAgentRouter.post('/chat', async (req: Request, res: Response) => {
  const {
    threadId: bodyThreadId,
    userId: bodyUserId,
    message,
    model,
  } = (req.body ?? {}) as {
    threadId?: string;
    userId?: string;
    message?: string;
    model?: string;
  };

  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const threadId = bodyThreadId?.trim() || crypto.randomUUID();
  const userId = bodyUserId?.trim() || 'anonymous';

  // Register (or bump) this conversation so it shows up in the sidebar list.
  // Title is set once, from the first message. Fire-and-forget so it never
  // delays the stream.
  void upsertConversation({
    id: threadId,
    userId,
    title: deriveTitle(message),
  }).catch((e) => console.error('[data-agent] upsertConversation failed', e));

  // BYOK: keys arrive from the UI as headers; env is the fallback (see llm.ts /
  // sandboxManager.ts). Never logged, never persisted.
  const keys = {
    openrouterKey: (req.header('x-openrouter-key') || '').trim() || undefined,
    e2bKey: (req.header('x-e2b-key') || '').trim() || undefined,
  };

  // SSE headers.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders?.();

  // Advertise the resolved thread id so the client can persist it.
  res.write(`event: meta\ndata: ${JSON.stringify({ threadId, userId })}\n\n`);

  // If the client disconnects mid-stream, stop pumping.
  //
  // NOTE: we listen on `res`, not `req`. On a POST, `req.on('close')` fires as
  // soon as the request BODY has been fully read (express.json() consumes it
  // immediately), which would falsely signal a disconnect before we stream a
  // single byte. `res.on('close')` fires only when the response socket is
  // actually torn down — the correct disconnect signal for SSE.
  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  try {
    for await (const chunk of runAgentStream(threadId, userId, message, model, keys)) {
      if (closed) break;
      res.write(chunk);
      // flush exists when compression middleware is present
      (res as any).flush?.();
    }
  } catch (e: any) {
    if (!closed) {
      res.write(
        `event: error\ndata: ${JSON.stringify({
          message: e?.message ?? String(e),
        })}\n\n`
      );
      res.write('event: done\ndata: {}\n\n');
    }
  } finally {
    if (!closed) res.end();
  }
});

// ---------------------------------------------------------------------------
// POST /upload — push an uploaded file into the thread's sandbox.
// multipart/form-data: field `file`, plus `threadId` (and optional `userId`).
// ---------------------------------------------------------------------------
dataAgentRouter.post(
  '/upload',
  upload.single('file'),
  async (req: Request, res: Response) => {
    const threadId = (req.body?.threadId as string | undefined)?.trim();
    const file = req.file;

    if (!threadId) {
      res.status(400).json({ error: 'threadId is required' });
      return;
    }
    if (!file) {
      res.status(400).json({ error: 'file is required (multipart field "file")' });
      return;
    }

    try {
      const e2bKey = (req.header('x-e2b-key') || '').trim() || undefined;
      const sandbox = await sandboxManager.getOrCreate(threadId, e2bKey);
      const safeName = file.originalname.replace(/[^\w.\- ]+/g, '_');
      const sandboxPath = `${UPLOADS_DIR_IN_SANDBOX}/${safeName}`;
      // E2B files.write accepts ArrayBuffer; convert the Node Buffer's
      // underlying bytes into a standalone ArrayBuffer slice.
      const arrayBuffer = file.buffer.buffer.slice(
        file.buffer.byteOffset,
        file.buffer.byteOffset + file.buffer.byteLength
      ) as ArrayBuffer;
      await sandbox.files.write(sandboxPath, arrayBuffer);

      res.json({
        ok: true,
        threadId,
        filename: safeName,
        sandboxPath,
        size: file.size,
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /download/:id — stream a saved artifact from local disk.
// ---------------------------------------------------------------------------
dataAgentRouter.get('/download/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const artifact = await getArtifact(id);
    if (!artifact) {
      res.status(404).json({ error: 'artifact not found' });
      return;
    }
    res.download(artifact.localPath, artifact.filename, (err?: Error) => {
      if (err && !res.headersSent) {
        res.status(500).json({ error: 'could not read artifact file' });
      }
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// ---------------------------------------------------------------------------
// GET /threads?userId= — list a user's conversations (most recently used first).
// ---------------------------------------------------------------------------
dataAgentRouter.get('/threads', async (req: Request, res: Response) => {
  const userId = ((req.query.userId as string | undefined) || '').trim() || 'anonymous';
  try {
    const rows = await listConversations(userId);
    res.json(
      rows.map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }))
    );
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// ---------------------------------------------------------------------------
// GET /threads/:id/messages — reconstruct a conversation's history from the
// checkpointer so the UI can reload a past chat.
// ---------------------------------------------------------------------------
dataAgentRouter.get(
  '/threads/:id/messages',
  async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const messages = await getThreadMessages(id);
      res.json({ threadId: id, messages });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE /threads/:id — remove a conversation from the sidebar list. (The
// checkpointer state is left in place; it is simply no longer listed.)
// ---------------------------------------------------------------------------
dataAgentRouter.delete('/threads/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await deleteConversation(id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// ---------------------------------------------------------------------------
// GET /threads/:id/artifacts — list artifacts for a thread (most recent first).
// ---------------------------------------------------------------------------
dataAgentRouter.get(
  '/threads/:id/artifacts',
  async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const rows = await listByThread(id);
      res.json(
        rows.map((r: any) => ({
          id: r.id,
          filename: r.filename,
          kind: r.kind,
          label: r.label,
          url: `/api/data-agent/download/${r.id}`,
          size: r.sizeBytes,
          createdAt: r.createdAt,
        }))
      );
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  }
);
