# retrieval-service

AI gateway untuk Frappe: RAG di atas Qdrant, MCP tool calling ke Frappe, dan LLM
sebagai lapisan penalaran. Frappe tidak menjalankan model apa pun — tidak
embedding, tidak LLM — seluruhnya lewat service ini.

Rasional arsitektur dan model keamanannya ada di [DESIGN.md](DESIGN.md).

## Stack

Node.js 22 · TypeScript · Fastify 5 · Zod 4 · `openai` (chat, OpenAI-compatible)
· `@google/genai` (embedding) · `@qdrant/js-client-rest`.

Tidak ada dependency model lokal, tidak ada GPU.

## Menjalankan

### Docker Compose

```bash
cp .env.example .env      # isi RETRIEVAL_API_KEY, FRAPPE_*, OPENAI_*, EMBEDDING_*
docker compose up -d --build
curl localhost:3000/health
```

Compose menaikkan `retrieval-service` + `qdrant`. Nilai `QDRANT_URL`, `HOST`,
`PORT`, dan `NODE_ENV` di-override di `docker-compose.yml` supaya menunjuk ke
jaringan container, bukan ke nilai `.env` milik mesin developer.

Qdrant sengaja **tidak** dipublish ke host. Kalau perlu dibuka untuk debugging,
buka blok `ports` di compose **dan** isi `QDRANT_API_KEY` — tanpa itu isi
collection terbuka bagi siapa pun yang bisa menjangkau port tersebut.

Bila Frappe berada di compose/network lain:

```bash
docker network connect rag-net <nama-container-frappe>
```

### Lokal

```bash
npm install
cp .env.example .env
npm run dev        # tsx watch, log pino-pretty
```

### Perintah

| Perintah               | Fungsi                                |
| ---------------------- | ------------------------------------- |
| `npm run dev`          | Dev server dengan watch               |
| `npm run build`        | Typecheck + emit ke `dist/`           |
| `npm test`             | `node --test` (59 test)               |
| `npm run check`        | `build` lalu `test` — sama seperti CI |
| `npm run format`       | Prettier tulis                        |
| `npm run format:check` | Prettier verifikasi (dipakai CI)      |

Entry point hasil build ada di `dist/src/server.js` (karena `rootDir` di
`tsconfig.json` adalah `.`), bukan `dist/server.js`.

## Endpoint

Semua endpoint **kecuali `/health`** mewajibkan
`Authorization: Bearer $RETRIEVAL_API_KEY`.

| Method | Path                  | Fungsi                                              |
| ------ | --------------------- | --------------------------------------------------- |
| GET    | `/health`             | Liveness + status Qdrant. Publik.                   |
| POST   | `/chat`               | Orkestrasi penuh: FAQ + MCP tool + LLM              |
| POST   | `/chat/async`         | Seperti `/chat`, tapi 202 + callback ke Frappe      |
| POST   | `/answer`             | Retrieval + jawaban LLM                             |
| POST   | `/query`              | Alias `/answer`, dipertahankan untuk kompatibilitas |
| POST   | `/search`             | Semantic search mentah, filter `min_score`+`source` |
| POST   | `/index`              | Index dokumen generik                               |
| POST   | `/faq/bulk`           | Batch upsert/delete FAQ                             |
| POST   | `/faq/reindex`        | Reindex asinkron, non-destruktif                    |
| GET    | `/faq/reindex/status` | Status reindex terakhir                             |
| POST   | `/faq/generate`       | Susun draft FAQ dari transkrip percakapan           |
| PUT    | `/faq/:id`            | Upsert satu FAQ                                     |
| DELETE | `/faq/:id`            | Hapus satu FAQ                                      |

`/health` selalu mengembalikan 200 selama proses hidup; status Qdrant dibawa di
body (`{"ok":true,"qdrant":false}`). Ini disengaja — dependency yang sedang down
bukan alasan orchestrator me-restart proses.

Contoh:

```bash
curl -X POST localhost:3000/chat \
  -H "authorization: Bearer $RETRIEVAL_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"question":"Bagaimana cara apply job?","type":"staff","actor":"staff@example.com"}'
```

```json
{
  "answer": "...",
  "route": "hybrid",
  "needs_admin": false,
  "reason": "tool_match",
  "tools_used": ["faq_search", "get_environment_context", "get_job_context"],
  "sources": []
}
```

## Konfigurasi

Semua variabel divalidasi Zod saat boot (`src/config.ts`); variabel wajib yang
kosong membuat proses gagal start, bukan gagal pada request pertama. Daftar
lengkap beserta default ada di [`.env.example`](.env.example).

Wajib: `QDRANT_URL`, `FRAPPE_URL`, `FRAPPE_AUTH_TOKEN`, `RETRIEVAL_API_KEY`,
`OPENAI_API_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `EMBEDDING_API_KEY`,
`EMBEDDING_MODEL`.

Prioritas: `process.env` menang atas file `.env`.

Catatan yang mudah terlewat:

- `EMBEDDING_*` memakai **Gemini**, bukan endpoint OpenAI-compatible. Tidak ada
  `EMBEDDING_API_URL`.
- Mengganti `EMBEDDING_MODEL` ke model dengan dimensi berbeda akan ditolak saat
  upsert pertama dengan pesan eksplisit, bukan gagal diam-diam.
- `LOG_CHAT_REQUEST_BODY=true` mencatat pertanyaan asli member. Jangan aktif di
  produksi.

## Keamanan

- Guard API key terpasang sebagai hook `onRequest` di instance root, sehingga
  route baru ikut terlindungi secara default. `test/security.test.ts` menahan
  regresi ini.
- Identitas end-user dibawa lewat body `actor` lalu diteruskan ke Frappe sebagai
  header `X-Alpha-Actor` — tidak pernah masuk ke argumen tool atau ke prompt,
  jadi prompt injection tidak punya jalur memalsukannya.
- Rate limit bersifat per-proses. Dengan N replica batas efektifnya
  `RATE_LIMIT_MAX * N`; untuk kuota lintas-replica pindahkan ke reverse proxy.
- Seluruh hasil retrieval (FAQ, environment, tool) diperlakukan sebagai data
  untrusted di dalam prompt.

Selengkapnya di [DESIGN.md §17](DESIGN.md#17-model-keamanan--otorisasi).

## CI/CD

| Workflow      | Pemicu                          | Isi                                                  |
| ------------- | ------------------------------- | ---------------------------------------------------- |
| `verify.yml`  | dipanggil workflow lain         | format, typecheck + test (Node 22 & 24), `npm audit` |
| `ci.yml`      | PR & push ke `master`/`develop` | `verify` + build image + smoke test container        |
| `release.yml` | push `master`, tag `v*.*.*`     | `verify` lalu push multi-arch ke GHCR + attestation  |

`release.yml` menjalankan `verify.yml` yang sama persis dengan CI dan
menjadikannya `needs` dari job publish — image tidak pernah terbit dari commit
yang belum lolos test.

Smoke test di `ci.yml` menjalankan image hasil build, lalu memverifikasi tiga
hal yang tidak tercakup unit test: container benar-benar boot dengan environment
nyata, `/chat` tanpa kredensial tetap 401, dan SIGTERM membuat container berhenti
sebelum kill timeout 10 detik.

### Tag image

Push ke `master` → `:edge` dan `:sha-<commit>`.
Tag `v1.2.3` → `:1.2.3`, `:1.2`, `:1`, `:latest`.

```bash
docker pull ghcr.io/m-fadil/retrieval-service:edge
```

### Guard branch master

Workflow tidak bisa memasang proteksi branch atas dirinya sendiri — itu setting
repositori. `ci.yml` menyediakan satu job agregat bernama **`CI`** supaya aturan
proteksi tidak perlu diubah tiap kali ada job atau entri matrix baru:

```bash
gh api -X PUT repos/m-fadil/retrieval-service/branches/master/protection \
  -H "Accept: application/vnd.github+json" \
  -f 'required_status_checks[strict]=true' \
  -f 'required_status_checks[contexts][]=CI' \
  -F 'enforce_admins=true' \
  -F 'required_pull_request_reviews[required_approving_review_count]=1' \
  -F 'restrictions=null' \
  -F 'allow_force_pushes=false' \
  -F 'allow_deletions=false'
```

`strict=true` mewajibkan branch up-to-date dengan `master` sebelum merge,
sehingga dua PR yang masing-masing hijau tidak bisa merge menjadi kombinasi yang
merah.

## Struktur

```
src/
├── server.ts              # buildApp: wiring, hook global, graceful shutdown
├── config.ts              # skema env Zod + loader .env
├── routes/
│   ├── auth.ts            # guard API key + rate limiter
│   ├── health.ts
│   ├── index.ts           # /index /search /answer /chat /query
│   └── faq.ts             # /faq/*
├── schemas/               # skema request/response Zod
│   ├── query.ts
│   └── faq.ts
└── services/
    ├── embeddings.ts      # embedding Gemini
    ├── qdrant.ts          # vector store, point ID deterministik
    ├── rag.ts             # orkestrasi: retrieval, planner, tool, komposisi
    ├── faq.ts             # siklus hidup FAQ + reindex
    ├── mcp.ts             # klien MCP JSON-RPC
    └── frappe.ts          # transport HTTP Frappe
```

Semua service diekspos lewat factory dan di-inject di `buildApp`, jadi test
menggantinya dengan fake tanpa menyentuh jaringan.
