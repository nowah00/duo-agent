import { defineConfig } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const STATE_PATH = path.join(ROOT_DIR, 'watcher', 'state.json');
const TASK_PATH = path.join(ROOT_DIR, 'watcher', 'task.txt');
const TASK_DONE_PATH = path.join(ROOT_DIR, 'TASK_DONE.md');
const KICK_TRIGGER_PATH = path.join(ROOT_DIR, 'watcher', '.kick-trigger');
const REVIEWS_DIR = path.join(ROOT_DIR, 'reviews');
const CHECKLIST_PATH = path.join(ROOT_DIR, 'watcher', 'checklist.json');

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

async function readChecklist() {
  try {
    const raw = await fs.readFile(CHECKLIST_PATH, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.items) ? data.items.filter(s => s.trim()) : [];
  } catch {
    return [];
  }
}

async function readState() {
  const checklist = await readChecklist();

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
      checklist,
    };
  } catch {
    return {
      round: 0,
      maxRounds: Number(process.env.AGENT_MAX_ROUNDS || 8),
      lastAgent: null,
      status: 'idle',
      updatedAt: null,
      lastReason: null,
      checklist,
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
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const filePath = path.join(REVIEWS_DIR, entry.name);
          const stats = await fs.stat(filePath);

          return {
            name: entry.name,
            filePath,
            mtimeMs: stats.mtimeMs,
          };
        }),
    );

    const recentFiles = files
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 5);

    return Promise.all(
      recentFiles.map(async (file) => ({
        name: file.name,
        content: await fs.readFile(file.filePath, 'utf8'),
      })),
    );
  } catch {
    return [];
  }
}

function duoAgentApiPlugin() {
  return {
    name: 'duo-agent-api',
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
