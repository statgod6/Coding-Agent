/**
 * LangChain tools the Data Agent uses inside the ReAct loop.
 *
 * Thin, thread-aware wrappers around the per-thread E2B sandbox. Tools
 * emit structured events (artifact) through a shared event sink so the
 * streaming layer can forward them to the frontend.
 */
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { createArtifact } from './artifactStore';
import { sandboxManager } from './sandboxManager';

// ---------------------------------------------------------------------------
// Artifact storage root (local disk)
// ---------------------------------------------------------------------------
const ARTIFACTS_ROOT = path.resolve(
  process.cwd(),
  'uploads',
  'data-agent',
  'artifacts'
);

function ensureThreadDir(threadId: string): string {
  const dir = path.join(ARTIFACTS_ROOT, threadId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function shortHex(n = 8): string {
  return crypto.randomBytes(n).toString('hex').slice(0, n);
}

function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

/**
 * Heuristic blank-image detector (no image deps).
 *
 * A near-uniform canvas (a blank matplotlib figure) compresses to far fewer
 * bytes-per-pixel than a chart containing data, axes, and text. We parse the
 * PNG's real dimensions and compare the compressed byte count against the
 * pixel count — blanks fall well below ~0.02 bytes/pixel, real charts are
 * many times higher. This catches blank figures that slip past a plain
 * byte-size threshold (e.g. a large empty subplots grid).
 */
function isLikelyBlankImage(buf: Buffer, ext: string): boolean {
  if (buf.length < 2_500) return true; // absolute floor
  if (ext === 'png') {
    const dim = readPngDimensions(buf);
    if (dim) {
      const bytesPerPixel = buf.length / (dim.width * dim.height);
      return bytesPerPixel < 0.02;
    }
    return buf.length < 8_000; // fallback if header unparseable
  }
  if (ext === 'jpg' || ext === 'jpeg') return buf.length < 8_000;
  return false; // svg / others: don't guess
}

export type ArtifactEvent = {
  type: 'artifact';
  data: {
    id: string;
    filename: string;
    kind: string;
    label: string;
    url: string;
    size: number;
  };
};

/**
 * Live sandbox output streamed from run_python while the code executes
 * (stdout / stderr lines arrive incrementally via E2B callbacks).
 */
export type ToolOutputEvent = {
  type: 'tool_output';
  data: {
    stream: 'stdout' | 'stderr';
    delta: string;
  };
};

export type SinkEvent = ArtifactEvent | ToolOutputEvent;

export type EventSink = {
  push: (event: SinkEvent) => void;
};

// ---------------------------------------------------------------------------
// Plot / rich-result auto-capture
// ---------------------------------------------------------------------------
async function persistInlineResults(
  threadId: string,
  userId: string,
  results: Array<any>
): Promise<ArtifactEvent['data'][]> {
  const saved: ArtifactEvent['data'][] = [];
  if (!results || results.length === 0) return saved;

  const threadDir = ensureThreadDir(threadId);

  for (const r of results) {
    let payload: Buffer | null = null;
    let ext = 'png';
    const kind = 'image';

    // e2b Result: properties png / jpeg / svg (base64 strings, svg may be raw text)
    const candidates: Array<[string, string]> = [
      ['png', 'png'],
      ['jpeg', 'jpg'],
      ['svg', 'svg'],
    ];
    for (const [attr, extName] of candidates) {
      const data = r?.[attr];
      if (data) {
        if (attr === 'svg') {
          payload = typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data);
        } else {
          payload = typeof data === 'string' ? Buffer.from(data, 'base64') : Buffer.from(data);
        }
        ext = extName;
        break;
      }
    }
    if (!payload) continue;

    // Skip blank/empty images. A blank matplotlib canvas compresses to a tiny
    // fraction of the bytes a real chart needs; isLikelyBlankImage parses the
    // PNG dimensions and checks bytes-per-pixel so even a large empty subplots
    // grid is rejected (a plain byte threshold missed those).
    if ((ext === 'png' || ext === 'jpg') && isLikelyBlankImage(payload, ext)) {
      console.log(`[data-agent] Skipping likely-blank inline image (${payload.length} bytes)`);
      continue;
    }

    const filename = `plot_${shortHex()}.${ext}`;
    const localPath = path.join(threadDir, filename);
    fs.writeFileSync(localPath, payload);

    const row = await createArtifact({
      threadId,
      userId,
      filename,
      kind,
      label: 'inline plot',
      localPath,
      sandboxPath: null,
      sizeBytes: payload.length,
    });

    saved.push({
      id: row.id,
      filename,
      kind,
      label: 'inline plot',
      url: `/api/data-agent/download/${row.id}`,
      size: payload.length,
    });
  }

  return saved;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
export function buildTools(
  threadId: string,
  userId: string,
  eventSink: EventSink,
  e2bApiKey?: string
): StructuredToolInterface[] {
  const emit = (event: SinkEvent) => {
    try {
      eventSink.push(event);
    } catch {
      // best-effort
    }
  };

  const runPython = tool(
    async ({ code }: { code: string }): Promise<string> => {
      const sandbox = await sandboxManager.getOrCreate(threadId, e2bApiKey);

      // Stream stdout/stderr to the client live, line-by-line, as the code
      // runs — this is what makes the sandbox feel "real time" in the UI.
      const execution = await sandbox.runCode(code, {
        onStdout: (m: any) => {
          const line = m && m.line != null ? String(m.line) : String(m ?? '');
          if (line) emit({ type: 'tool_output', data: { stream: 'stdout', delta: line } });
        },
        onStderr: (m: any) => {
          const line = m && m.line != null ? String(m.line) : String(m ?? '');
          if (line) emit({ type: 'tool_output', data: { stream: 'stderr', delta: line } });
        },
      });

      const stdout = execution.logs?.stdout?.join('') ?? '';
      const stderr = execution.logs?.stderr?.join('') ?? '';
      let errorText = '';
      if (execution.error) {
        errorText = `${execution.error.name}: ${execution.error.value}`;
        // Surface the runtime error live too (exceptions arrive via the
        // error result, not the stderr log stream).
        emit({ type: 'tool_output', data: { stream: 'stderr', delta: `${errorText}\n` } });
      }

      const inline = await persistInlineResults(
        threadId,
        userId,
        Array.from(execution.results ?? [])
      );
      for (const art of inline) {
        emit({ type: 'artifact', data: art });
      }

      const parts: string[] = [];
      if (stdout) parts.push(`[stdout]\n${stdout.trim()}`);
      if (stderr) parts.push(`[stderr]\n${stderr.trim()}`);
      if (errorText) parts.push(`[error]\n${errorText}`);
      if (inline.length > 0) {
        const names = inline.map((a) => a.filename).join(', ');
        parts.push(`[captured_artifacts] ${names}`);
      }
      if (parts.length === 0) parts.push('[ok] (no output)');
      return parts.join('\n\n');
    },
    {
      name: 'run_python',
      description:
        'Execute Python code in the persistent sandbox for this conversation. ' +
        'State (variables, imports, dataframes) persists across calls. Returns a text ' +
        'summary with stdout, stderr, error, and any inline result metadata (plots are ' +
        'captured as downloadable artifacts automatically). On ModuleNotFoundError, call ' +
        'install_package and retry.',
      schema: z.object({
        code: z.string().describe('Python source code to execute in the sandbox.'),
      }),
    }
  );

  const installPackage = tool(
    async ({ packages }: { packages: string[] }): Promise<string> => {
      const sandbox = await sandboxManager.getOrCreate(threadId, e2bApiKey);
      const pkgs = packages
        .map((p) => p.trim())
        .filter(Boolean)
        .join(' ');
      if (!pkgs) return '[error] no packages specified';
      const result = await sandbox.commands.run(`pip install --quiet ${pkgs}`);
      if (result.exitCode === 0) {
        return `[installed] ${pkgs}`;
      }
      return `[pip_error exit=${result.exitCode}]\n${result.stderr || result.stdout || ''}`;
    },
    {
      name: 'install_package',
      description:
        'Install one or more pip packages into the sandbox. Call this when run_python returns ' +
        'a ModuleNotFoundError, then retry. Example: install_package(["pandas", "openpyxl"]).',
      schema: z.object({
        packages: z
          .array(z.string())
          .describe('List of pip package names to install.'),
      }),
    }
  );

  const saveArtifact = tool(
    async ({
      path: sandboxPath,
      label,
      kind = 'other',
    }: {
      path: string;
      label: string;
      kind?: string;
    }): Promise<string> => {
      const sandbox = await sandboxManager.getOrCreate(threadId, e2bApiKey);
      let data: Buffer;
      try {
        const raw = await sandbox.files.read(sandboxPath, { format: 'bytes' });
        data = Buffer.from(raw as Uint8Array);
      } catch (e: any) {
        return `[error] could not read ${sandboxPath}: ${e?.message ?? e}`;
      }

      const baseName = path.posix.basename(sandboxPath) || `artifact_${shortHex()}`;

      // Guard against registering a blank chart. This most commonly happens
      // when the model calls plt.savefig in a SEPARATE run_python call after
      // the figure was already shown/closed — it then saves an empty canvas.
      const extName = (baseName.split('.').pop() || '').toLowerCase();
      if (
        (extName === 'png' || extName === 'jpg' || extName === 'jpeg') &&
        isLikelyBlankImage(data, extName === 'jpeg' ? 'jpg' : extName)
      ) {
        return `[error] "${baseName}" appears to be blank/empty and was NOT saved. This usually means plt.savefig ran after the figure was closed. Re-create the figure and call plt.savefig(...) in the SAME code block BEFORE plt.show()/plt.close(), then retry save_artifact. (Note: figures shown with plt.show() are already downloadable — you often do not need save_artifact at all.)`;
      }

      const threadDir = ensureThreadDir(threadId);
      const unique = `${shortHex()}_${baseName}`;
      const localPath = path.join(threadDir, unique);
      fs.writeFileSync(localPath, data);

      const row = await createArtifact({
        threadId,
        userId,
        filename: baseName,
        kind,
        label,
        localPath,
        sandboxPath,
        sizeBytes: data.length,
      });

      emit({
        type: 'artifact',
        data: {
          id: row.id,
          filename: baseName,
          kind,
          label,
          url: `/api/data-agent/download/${row.id}`,
          size: data.length,
        },
      });
      return `[saved] artifact_id=${row.id} filename=${baseName} url=/api/data-agent/download/${row.id}`;
    },
    {
      name: 'save_artifact',
      description:
        'Register a file from the sandbox as a downloadable artifact. path is an absolute ' +
        'path inside the sandbox (e.g. /home/user/artifacts/report.xlsx). label is a short ' +
        'human-readable label. kind is one of image | excel | word | csv | pdf | other.',
      schema: z.object({
        path: z.string().describe('Absolute path of the file inside the sandbox.'),
        label: z.string().describe('Short human-readable label shown in the UI.'),
        kind: z
          .string()
          .optional()
          .describe('Artifact category: image | excel | word | csv | pdf | other.'),
      }),
    }
  );

  return [runPython, installPackage, saveArtifact] as StructuredToolInterface[];
}
