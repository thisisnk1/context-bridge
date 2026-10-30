# Context Bridge

Context Bridge is a **zero-cost, local-first knowledge transfer workspace**. It turns chat exports, message dumps, online-meeting notes/transcripts and offline audio recordings into auditable handovers: a recap, decisions, owned action items, a catch-up brief, and a small linked knowledge base.

It is designed for the DigiPlus assessment's core problem: when work changes hands, the person taking over should not have to reconstruct context from WhatsApp, Slack, recordings, and personal notes.

## What it delivers

- **Capture:** paste a message dump; load `.txt`, `.md`, `.csv`, or Slack-export `.json`; add a knowledge note; or attach an online-meeting or offline voice recording.
- **Structure:** a local AI turns raw content into a title, summary, decisions, actions, owners, due dates, evidence snippets, and questions. A deterministic safety fallback creates a useful draft when the AI is unavailable.
- **Follow through:** action items have owner, due date, status, outcome, history, and a link back to their source handover. Open items can be carried forward into the next handover.
- **Transfer knowledge:** each handover gets a short catch-up brief for a teammate who missed it. Related past handovers and knowledge notes are linked automatically.
- **Keep provenance:** the special feature, **Context Ledger**, attaches an evidence quote and source label to every extracted decision/action. It also raises a Transfer Risk when an action has no owner or due date, or when the AI had to fall back.
- **Operate reliably:** validation errors are returned clearly; raw files are size/type checked; every API request has a correlation ID; JSONL logs record lifecycle events, AI timing/outcome, and errors without body content or secrets.

## Architecture

```text
Browser (static UI)
        |
Node 24 HTTP API + SQLite (both local, no account)
        |---------------------|
local uploads          Google Gemini API

Optional: Gemini can transcribe uploaded or browser-recorded voice notes, or whisper.cpp / whisper-cli can transcribe audio locally.
```

Nothing leaves the machine by default. There are no API keys, paid SDKs, SaaS databases, or metered calls. The default model is `llama3:latest` when it is installed locally. The default data path is `data/context-bridge.sqlite`; uploads stay in `data/uploads`; structured logs stay in `logs/app.jsonl`.

## Quick start

Requires Node 24+ (uses Node's built-in SQLite).

```powershell
npm start
```

Open `http://localhost:3333`. The app seeds realistic demo records at first launch so every feature is visible immediately. Delete `data/context-bridge.sqlite` if you want a blank local database.

### Enable Gemini text and voice

Copy `.env.example` to `.env` and set `GEMINI_API_KEY` to a newly generated key. You can use separate models for normal text analysis and voice transcription:

```dotenv
GEMINI_API_KEY=replace-with-your-key
GEMINI_MODEL=gemini-2.5-flash-lite
GEMINI_VOICE_MODEL=gemini-2.5-flash-lite
```

When `GEMINI_API_KEY` is present, normal text analysis, catch-up briefs, and voice transcription use Gemini. The API key remains server-side; it is never sent to the browser or written to logs. Do not commit `.env` or paste a real key into `.env.example`. The voice flow supports uploaded audio and browser microphone recordings; audio is sent to Google only when **Transcribe** is pressed.

### Local audio transcription

Attach `.mp3`, `.m4a`, `.wav`, or `.ogg` to retain an offline recording, or use **Record voice** in a browser that supports `MediaRecorder`. With Gemini configured, press **Transcribe** to use Gemini voice transcription. Without Gemini, install `whisper.cpp`, set `WHISPER_CLI` and `WHISPER_MODEL` in `.env`, then press **Transcribe** to process the recording locally. The app runs the executable only with the stored file path and configured model path.

Audio is intentionally a two-step capture: recording ingestion succeeds even when transcription tooling is absent, and the UI tells the user how to add a transcript manually. This avoids pretending an uploaded recording was analysed when it was not.

## API at a glance

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/dashboard` | activity, handovers, tasks, knowledge, recordings |
| `POST` | `/api/intakes/text` | create and analyse a pasted/imported message dump |
| `POST` | `/api/knowledge` | persist a knowledge note and link it to related work |
| `POST` | `/api/recordings` | save a local audio recording |
| `POST` | `/api/recordings/:id/transcribe` | invoke Gemini voice transcription or optional local Whisper |
| `POST` | `/api/handoffs/:id/brief` | create a catch-up brief |
| `POST` | `/api/handoffs/:id/reanalyze` | upgrade a review draft with the local Llama 3 model |
| `POST` | `/api/handoffs/:id/carry-forward` | create next agenda with open actions intact |
| `PATCH` | `/api/actions/:id` | update ownership, due date, status, or outcome |

All responses include `X-Correlation-Id`. Send your own header with that name to trace a request across an upstream client and `logs/app.jsonl`.

## Data model

- `handoffs`: meeting/transfer metadata, raw source, AI summary, decisions, briefs, and AI mode.
- `actions`: owner, due date, status (`open`, `in_progress`, `blocked`, `done`), outcome, source handover, and carry-forward history.
- `knowledge_items`: team notes/documents and searchable extracted text.
- `recordings`: file metadata and transcript state for online-meeting and offline voice audio; stored audio never enters the database.
- `links`: weighted relationships between handovers and knowledge items.
- `events`: immutable lifecycle trail displayed in the UI and written to structured logs.

## AI data flow and reliability

1. The browser gives the API raw text (or a text file read locally). Slack JSON is normalized into readable messages.
2. The API retrieves up to five locally stored knowledge snippets by token overlap and asks Gemini for strict JSON.
3. The response is validated and normalized before persistence. Each action/decision receives source evidence so a human can correct it.
4. If model access, timeouts, or JSON validation fail, a visible fallback records the raw source and produces an editable recap; `ai_mode` is `fallback` and a Transfer Risk is shown. Gemini audio transcription errors are returned explicitly and do not claim that a recording was transcribed.

No hidden claim is made that AI output is fact. Review ownership and dates before committing work.

## Logging

`logs/app.jsonl` contains one JSON object per event: timestamp, level, correlation ID, event name, safe identifiers, and (for AI) latency/outcome. Request bodies, recordings, model prompts, and environment values are never logged. Events include creation, reassignment, status changes, closure, transcription, AI success/fallback, and errors.

## Deployment at zero spend

The reliable zero-cost deployment is to keep this service on a team-controlled laptop, old mini-PC, or internal VM, then access it on the LAN. For remote demos, a free Cloudflare Tunnel may expose the local port with a generated `trycloudflare.com` URL; do not use it for confidential work without your organisation's approval.

Cloud free tiers change and may sleep, cap storage, or require a card. The app itself is self-contained apart from Gemini API usage and local audio storage.

## Assumptions and known limits

- One trusted team uses the local instance; authentication and role-based access are the first production addition.
- Slack/WhatsApp official APIs are not used: exports/pastes avoid paid plans, token setup, and permission issues. A connector can be added later only after obtaining workspace/user consent.
- Audio transcription requires locally installed Whisper and enough CPU/RAM. In the meantime, attach a recording and paste its transcript.
- Token-overlap links are lightweight retrieval, not semantic vector search. A local embedding model is the logical next upgrade when the knowledge base grows.
- SQLite is intentionally chosen for a small team and a portable demo. Back up `data/context-bridge.sqlite` before moving machines.

## Suggested next changes

1. Add sign-in plus role-based visibility before exposing it beyond a trusted team.
2. Agree on a single owner/due-date convention and make missing fields require confirmation, rather than guessing.
3. Add approved Slack/WhatsApp/Teams connectors only after consent and retention policies are documented.
4. For 50+ knowledge items, add local embeddings (e.g. Ollama `nomic-embed-text`) and hybrid retrieval.
5. Add a calendar/notification connector for due-date reminders; do not notify people from unreviewed AI extraction.

## Assessment mapping

| Assessment need | Implementation |
| --- | --- |
| Persist meetings/transfers | SQLite-backed handoffs, sources, actions, events |
| Action lifecycle/outcome | editable task board + immutable history + outcome field |
| Carry forward | creates a next transfer with open action IDs/history preserved |
| Meaningful AI | Gemini structured extraction, knowledge context and catch-up briefs |
| AI failure handling | timeout, validation, usable fallback, visible mode/risk |
| Knowledge base/linking | persisted notes plus relevance-scored links |
| Structured logging | correlation ID, JSONL, lifecycle/AI/error events |
| Originality | Context Ledger: evidence, transfer-risk flags, source traceability |
