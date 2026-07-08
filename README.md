# Data Agent

An AI data-analyst you chat with. Upload a dataset (CSV/Excel), ask questions in plain
English, and the agent writes and runs Python in a secure cloud sandbox to clean data,
compute statistics, and generate charts — streaming every step live and letting you
download the results.

Built with **LangGraph.js** + **OpenRouter** (LLM) + **E2B** (code sandbox) on an
Express server. Runs **fully local** by default — no database or cloud account required.

---

## ✅ What you need first (one-time)

1. **Node.js 18 or newer** — download from <https://nodejs.org> (pick the **LTS** installer).
   - Verify it's installed by opening a terminal and running:
     ```bash
     node --version
     ```
     You should see something like `v20.x.x`.
2. **Two free API keys** (each student needs their own — see [Get your API keys](#-get-your-api-keys)).

That's it. You do **not** need a database, Docker, or any cloud account.

---

## 🚀 Quick start

```bash
# 1. Clone the repo (or download the ZIP from GitHub and unzip it)
git clone <your-repo-url>
cd "Data Agent"

# 2. Install dependencies
npm install

# 3. Start the server
npm run dev
```

Then open **<http://localhost:8080>** in your browser. 🎉

> **Tip:** If you're using Qoder, you can simply ask the agent to *"install dependencies
> and start the server"* and it will run steps 2–3 for you.

---

## 🔑 Get your API keys

The app uses **BYOK** ("Bring Your Own Key") — you paste your keys into the app's
**⚙ Settings** panel, and they're stored **only in your own browser** (never uploaded,
never committed to Git).

| Key | Where to get it | Notes |
|-----|-----------------|-------|
| **OpenRouter** (`sk-or-v1-…`) | <https://openrouter.ai/keys> | Powers the LLM. Needs a small credit balance. |
| **E2B** (`e2b_…`) | <https://e2b.dev/dashboard> | Runs the Python sandbox. Has a free tier. |

**Steps:**
1. Open <http://localhost:8080>.
2. Click **⚙ Settings** (top of the sidebar).
3. Paste your **OpenRouter** and **E2B** keys.
4. Save. Start chatting!

---

## 💡 What works out of the box (local mode)

With zero configuration, the app automatically uses a **local SQLite file**
(`data-agent.sqlite`) for storage. You get:

- ✅ Real-time streaming of the agent's Python execution
- ✅ Persistent **conversation history** (past chats appear in the sidebar and reload)
- ✅ Downloadable **artifacts** (charts, cleaned CSVs) saved locally
- ✅ Multiple LLM models to choose from in the dropdown

No database setup, no `.env` file needed for local use.

---

## 🗂️ Useful commands

| Command | What it does |
|---------|--------------|
| `npm run dev` | Start the server with hot-reload (recommended for development) |
| `npm start` | Start the server once (no watch) |
| `npm run typecheck` | Check TypeScript types |

The server runs on port **8080** by default. To change it, set `PORT` in a `.env` file
(e.g. `PORT=3000`).

---

## 🛠️ Troubleshooting

**"node is not recognized" / "command not found"**
Node.js isn't installed or your terminal needs a restart. Install the LTS from
<https://nodejs.org> and open a fresh terminal.

**Port 8080 is already in use**
Another process (or an old server) is holding the port. Close it, or start on a
different port by creating a `.env` file with `PORT=3000`.

**The chat says a key is missing**
Open **⚙ Settings** and make sure both the OpenRouter and E2B keys are pasted and saved.

**`npm install` shows a Prisma warning**
That's fine in local SQLite mode — Prisma is only used if you connect a Postgres/Supabase
database. The install still succeeds.

---

## 🐘 Optional: use Postgres / Supabase instead of SQLite

Local SQLite is perfect for learning and classroom use. If you later want a shared,
cloud-hosted database (so conversations persist across machines), you can switch to
Postgres/Supabase:

1. Copy the template:
   ```bash
   cp .env.example .env
   ```
2. Fill in your Supabase connection strings in `.env` (see the comments in
   [`.env.example`](.env.example) — the direct vs. pooled connection distinction matters).
3. Generate the Prisma client and push the schema:
   ```bash
   npm run prisma:generate
   npm run prisma:push
   ```
4. Start the server as usual — it auto-detects the database and uses it instead of SQLite.

> The app decides automatically: if a real `DATABASE_URL` (or `CHECKPOINT_DATABASE_URL`)
> is set, it uses Postgres; otherwise it falls back to the local SQLite file.

---

## 📁 Project layout

```
Data Agent/
├── src/
│   ├── server.ts              # Express server + graceful shutdown
│   ├── dataAgent/
│   │   ├── routes.ts          # API endpoints (chat, threads, artifacts)
│   │   ├── graph.ts           # LangGraph agent + checkpointer
│   │   ├── tools.ts           # Python sandbox tools
│   │   ├── prompts.ts         # System prompts
│   │   ├── llm.ts             # OpenRouter model config
│   │   ├── sandboxManager.ts  # E2B sandbox lifecycle
│   │   ├── artifactStore.ts   # Chart/file storage (SQLite or Postgres)
│   │   └── conversationStore.ts # Conversation registry
│   └── utils/prisma.ts        # Prisma client (only loaded in Postgres mode)
├── public/                    # Web UI (chat + settings)
├── prisma/schema.prisma       # Database schema (Postgres mode)
├── .env.example               # Environment template (for Postgres/Supabase)
└── README.md
```

---

Happy analyzing! 🦁
