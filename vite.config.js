import { defineConfig } from 'vite';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import os from 'node:os';
import crypto from 'node:crypto';

const ROOT_DIR = process.cwd();
const SRC_DIR = path.join(ROOT_DIR, 'src');
const STATE_PATH = path.join(ROOT_DIR, 'watcher', 'state.json');
const TASK_PATH = path.join(ROOT_DIR, 'watcher', 'task.txt');
const TASK_DONE_PATH = path.join(ROOT_DIR, 'TASK_DONE.md');
const KICK_TRIGGER_PATH = path.join(ROOT_DIR, 'watcher', '.kick-trigger');
const REVIEWS_DIR = path.join(ROOT_DIR, 'reviews');
const CHECKLIST_PATH = path.join(ROOT_DIR, 'watcher', 'checklist.json');
const FEEDBACK_PATH = path.join(ROOT_DIR, 'watcher', 'feedback.txt');
const PROJECT_PATH = path.join(ROOT_DIR, 'watcher', 'project.txt');

function sendJson(res, payload, statusCode = 200) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      resolve(body);
    });

    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const rawBody = await readRequestBody(req);
  if (!rawBody.trim()) return {};

  try {
    return JSON.parse(rawBody);
  } catch {
    return {};
  }
}

async function readPendingFeedback() {
  try {
    const text = await fs.readFile(FEEDBACK_PATH, 'utf8');
    return text.trim() || null;
  } catch {
    return null;
  }
}

async function readChecklist() {
  try {
    const raw = await fs.readFile(CHECKLIST_PATH, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.items) ? data.items.filter(s => s.trim()) : [];
  } catch {
    return [];
  }
}

async function readCurrentTask() {
  try {
    const text = await fs.readFile(TASK_PATH, 'utf8');
    return text.trim() || null;
  } catch {
    return null;
  }
}

async function readProjectName() {
  try {
    const text = await fs.readFile(PROJECT_PATH, 'utf8');
    return text.trim() || null;
  } catch {
    return null;
  }
}

async function readState() {
  const [checklist, pendingFeedback, currentTask, projectName] = await Promise.all([
    readChecklist(),
    readPendingFeedback(),
    readCurrentTask(),
    readProjectName(),
  ]);

  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    const state = JSON.parse(raw);

    return {
      round: Number(state.round || 0),
      maxRounds: Number(process.env.AGENT_MAX_ROUNDS || 8),
      lastAgent: state.lastAgent ?? null,
      status: state.status || 'idle',
      updatedAt: state.updatedAt ?? null,
      lastReason: state.lastReason ?? null,
      lastSummary: state.lastSummary ?? null,
      lastChangedFiles: Array.isArray(state.lastChangedFiles) ? state.lastChangedFiles : [],
      checklist,
      hasPendingFeedback: Boolean(pendingFeedback),
      currentTask,
      projectName,
    };
  } catch {
    return {
      round: 0,
      maxRounds: Number(process.env.AGENT_MAX_ROUNDS || 8),
      lastAgent: null,
      status: 'idle',
      updatedAt: null,
      lastReason: null,
      lastSummary: null,
      lastChangedFiles: [],
      checklist,
      hasPendingFeedback: Boolean(pendingFeedback),
      currentTask,
      projectName,
    };
  }
}

async function writeJsonFile(filePath, payload) {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function kickAgent(req) {
  const body = await readJsonBody(req);
  const task = typeof body.task === 'string' ? body.task.trim() : '';

  if (!task) {
    return { payload: { ok: false, error: 'task is required' }, statusCode: 400 };
  }

  const existingProject = await readProjectName();
  if (!existingProject) {
    const projectName = typeof body.projectName === 'string' ? body.projectName.trim() : '';
    if (!projectName) {
      return { payload: { ok: false, error: 'project name is required' }, statusCode: 400 };
    }
    await fs.writeFile(PROJECT_PATH, projectName, 'utf8');
  }

  const checklist = Array.isArray(body.checklist)
    ? body.checklist.map(s => String(s).trim()).filter(Boolean)
    : [];

  await fs.rm(TASK_DONE_PATH, { force: true });
  await writeJsonFile(STATE_PATH, {
    round: 0,
    lastAgent: null,
    status: 'idle',
    retries: 0,
  });
  await writeJsonFile(CHECKLIST_PATH, { items: checklist });
  await fs.writeFile(TASK_PATH, task, 'utf8');
  await fs.writeFile(KICK_TRIGGER_PATH, new Date().toISOString(), 'utf8');
  await fs.mkdir(REVIEWS_DIR, { recursive: true });
  const kickTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.writeFile(path.join(REVIEWS_DIR, `${kickTimestamp}_task.md`), task, 'utf8');

  return { payload: { ok: true }, statusCode: 200 };
}

async function stopAgent() {
  let state;

  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    state = JSON.parse(raw);
  } catch {
    state = {
      round: 0,
      lastAgent: null,
      status: 'idle',
      retries: 0,
    };
  }

  await writeJsonFile(STATE_PATH, {
    ...state,
    status: 'paused',
    lastReason: 'user stopped',
    updatedAt: new Date().toISOString(),
  });
  await fs.writeFile(
    TASK_DONE_PATH,
    '# Stopped\n\nUser manually stopped the agent loop.',
    'utf8',
  );

  return { payload: { ok: true }, statusCode: 200 };
}

async function readRecentReviews() {
  try {
    const entries = await fs.readdir(REVIEWS_DIR, { withFileTypes: true });
    const names = entries.filter((e) => e.isFile()).map((e) => e.name);

    const promptFileSet = new Set(names.filter((n) => n.endsWith('_prompt.md')));
    const outputFiles = names.filter((n) => !n.endsWith('_prompt.md'));

    const withStats = await Promise.all(
      outputFiles.map(async (name) => {
        const filePath = path.join(REVIEWS_DIR, name);
        const stats = await fs.stat(filePath);
        return { name, filePath, mtimeMs: stats.mtimeMs };
      }),
    );

    const recent = withStats.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 5);

    return Promise.all(
      recent.map(async ({ name, filePath }) => {
        const content = await fs.readFile(filePath, 'utf8');
        const promptFileName = name.replace(/\.md$/, '_prompt.md');
        const promptSummary = promptFileSet.has(promptFileName)
          ? await fs.readFile(path.join(REVIEWS_DIR, promptFileName), 'utf8').catch(() => null)
          : null;
        return { name, content, promptSummary };
      }),
    );
  } catch {
    return [];
  }
}

async function readHistory() {
  function parseMs(name) {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d+)Z/);
    if (!m) return 0;
    const [, date, hh, mm, ss, ms] = m;
    return new Date(`${date}T${hh}:${mm}:${ss}.${ms}Z`).getTime();
  }

  try {
    await fs.mkdir(REVIEWS_DIR, { recursive: true });
    const entries = await fs.readdir(REVIEWS_DIR, { withFileTypes: true });
    const names = entries.filter((e) => e.isFile()).map((e) => e.name);

    const taskFiles = names
      .filter((n) => n.endsWith('_task.md'))
      .map((n) => ({ name: n, ms: parseMs(n) }))
      .sort((a, b) => b.ms - a.ms);

    const promptFileSet = new Set(names.filter((n) => n.endsWith('_prompt.md')));
    const outputFiles = names
      .filter((n) => !n.endsWith('_task.md') && !n.endsWith('_prompt.md'))
      .map((n) => ({ name: n, ms: parseMs(n) }));

    if (!taskFiles.length) return [];

    return Promise.all(
      taskFiles.map(async (task, index) => {
        const prevTask = index > 0 ? taskFiles[index - 1] : null;
        const sessionOutputs = outputFiles
          .filter((f) => f.ms >= task.ms && (!prevTask || f.ms < prevTask.ms))
          .sort((a, b) => b.ms - a.ms);

        const taskContent = await fs.readFile(
          path.join(REVIEWS_DIR, task.name), 'utf8',
        ).catch(() => '');

        const reviews = await Promise.all(
          sessionOutputs.map(async ({ name }) => {
            const content = await fs.readFile(
              path.join(REVIEWS_DIR, name), 'utf8',
            ).catch(() => '(empty)');
            const promptFileName = name.replace(/\.md$/, '_prompt.md');
            const promptSummary = promptFileSet.has(promptFileName)
              ? await fs.readFile(path.join(REVIEWS_DIR, promptFileName), 'utf8').catch(() => null)
              : null;
            return { name, content, promptSummary };
          }),
        );

        return {
          taskName: task.name,
          taskTimestamp: task.ms,
          taskContent: taskContent.trim(),
          reviews,
        };
      }),
    );
  } catch {
    return [];
  }
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>duo-agent 대시보드</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; background: #faf8f5; font-family: ui-sans-serif, system-ui, sans-serif; }
      #app { width: min(100% - 40px, 1120px); margin: 0 auto; padding: 28px 0; }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>`;

const RETURN_BUTTON_HTML = `
<div id="_duo-agent-return" style="position:fixed;bottom:20px;right:20px;z-index:2147483647;font-family:ui-sans-serif,system-ui,sans-serif;">
  <a href="/_dashboard" style="display:flex;align-items:center;gap:6px;padding:10px 16px;background:#836942;color:#fff;text-decoration:none;font-size:12px;font-weight:700;letter-spacing:0.05em;box-shadow:0 4px 16px rgba(0,0,0,.22);">duo-agent 대시보드 →</a>
</div>`;

function duoAgentApiPlugin() {
  return {
    name: 'duo-agent-api',
    transformIndexHtml(html, ctx) {
      if (ctx.path === '/_dashboard' || ctx.path === '/') return html;
      return html.replace('</body>', `${RETURN_BUTTON_HTML}\n  </body>`);
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0];

        if (req.method === 'GET' && url === '/api/state') {
          sendJson(res, await readState());
          return;
        }

        if (req.method === 'GET' && url === '/api/reviews') {
          sendJson(res, await readRecentReviews());
          return;
        }

        if (req.method === 'GET' && url === '/api/history') {
          sendJson(res, await readHistory());
          return;
        }

        if (req.method === 'POST' && url === '/api/kick') {
          try {
            const result = await kickAgent(req);
            sendJson(res, result.payload, result.statusCode);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'kick failed';
            sendJson(res, { ok: false, error: message }, 500);
          }
          return;
        }

        if (req.method === 'POST' && url === '/api/feedback') {
          try {
            const body = await readJsonBody(req);
            const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : '';
            if (!feedback) {
              sendJson(res, { ok: false, error: 'feedback is required' }, 400);
              return;
            }
            await fs.writeFile(FEEDBACK_PATH, feedback, 'utf8');
            sendJson(res, { ok: true });
          } catch (error) {
            const message = error instanceof Error ? error.message : 'feedback failed';
            sendJson(res, { ok: false, error: message }, 500);
          }
          return;
        }

        if (req.method === 'POST' && url === '/api/stop') {
          try {
            const result = await stopAgent();
            sendJson(res, result.payload, result.statusCode);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'stop failed';
            sendJson(res, { ok: false, error: message }, 500);
          }
          return;
        }

        if (req.method === 'GET' && url === '/_dashboard') {
          try {
            const transformed = await server.transformIndexHtml('/_dashboard', DASHBOARD_HTML);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(transformed);
          } catch {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(DASHBOARD_HTML);
          }
          return;
        }

        if (req.method === 'GET' && url === '/game') {
          const gamePath = path.join(SRC_DIR, 'index.html');
          try {
            const gameHtml = await fs.readFile(gamePath, 'utf8');
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(gameHtml);
          } catch {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>미리보기</title><style>body{font-family:ui-sans-serif,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#faf8f5;color:#8d7868;}</style></head><body><p>아직 게임이 없습니다. 작업을 먼저 시작해 주세요.</p></body></html>`);
          }
          return;
        }

        if (req.method === 'GET' && url === '/api/download-src') {
          const tmpZip = path.join(os.tmpdir(), `duo-agent-${crypto.randomUUID()}.zip`);
          try {
            execSync(`zip -r "${tmpZip}" src/ -x "src/main.js"`, { cwd: ROOT_DIR, stdio: 'pipe' });
            const stat = await fs.stat(tmpZip);
            const projectName = await readProjectName();
            const zipFilename = projectName
              ? `${projectName.replace(/[^a-zA-Z0-9가-힣._-]/g, '_')}.zip`
              : 'game.zip';
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);
            res.setHeader('Content-Length', stat.size);
            const stream = createReadStream(tmpZip);
            stream.pipe(res);
            stream.on('close', () => fs.rm(tmpZip, { force: true }).catch(() => {}));
          } catch (error) {
            await fs.rm(tmpZip, { force: true }).catch(() => {});
            sendJson(res, { ok: false, error: error instanceof Error ? error.message : 'zip failed' }, 500);
          }
          return;
        }

        if (req.method === 'POST' && url === '/api/reset') {
          try {
            const srcEntries = await fs.readdir(SRC_DIR, { withFileTypes: true }).catch(() => []);
            await Promise.all(
              srcEntries
                .filter((e) => e.name !== 'main.js')
                .map((e) => fs.rm(path.join(SRC_DIR, e.name), { recursive: true, force: true })),
            );
            try {
              execSync('git checkout HEAD -- src/main.js index.html', { cwd: ROOT_DIR, stdio: 'pipe' });
            } catch {}
            await fs.rm(TASK_DONE_PATH, { force: true });
            await writeJsonFile(STATE_PATH, { round: 0, lastAgent: null, status: 'idle', retries: 0, lastRole: null });
            await fs.rm(TASK_PATH, { force: true });
            await fs.rm(CHECKLIST_PATH, { force: true });
            await fs.rm(KICK_TRIGGER_PATH, { force: true });
            await fs.rm(FEEDBACK_PATH, { force: true });
            await fs.rm(path.join(ROOT_DIR, 'watcher', 'task-goals.json'), { force: true });
            await fs.rm(PROJECT_PATH, { force: true });
            await fs.rm(REVIEWS_DIR, { recursive: true, force: true });
            await fs.mkdir(REVIEWS_DIR, { recursive: true });
            sendJson(res, { ok: true });
          } catch (error) {
            sendJson(res, { ok: false, error: error instanceof Error ? error.message : 'reset failed' }, 500);
          }
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [duoAgentApiPlugin()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
  server: {
    port: 3000,
    open: true,
  },
});
