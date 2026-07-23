# DESIGN.md — Retrieval / Assistant Service

## 1. Latar Belakang

Frappe tidak boleh menjalankan model AI lokal, termasuk embedding model seperti `sentence_transformers`, di dalam proses request. Untuk menjaga Frappe tetap ringan dan menghindari dependency model lokal, seluruh logic AI (provider embedding, vector search, LLM provider, tool calling) dipindahkan ke service terpisah bernama **`retrieval-service`** (alias: `assistant-service` / `ai-orchestrator`).

Karena service ini mencakup lebih dari sekadar retrieval — termasuk LLM reasoning dan MCP tool calling — secara domain ini lebih dekat ke **AI gateway / AI orchestration service**. Nama `retrieval-service` tetap dipakai, dengan lingkup yang didefinisikan mencakup RAG + tools + LLM.

## 2. Tujuan

- Frappe tidak perlu load model embedding lokal.
- Semantic search (RAG) untuk knowledge statis (FAQ, SOP, dokumentasi).
- Tool calling (MCP) untuk data dinamis (job, schedule, staff, payment).
- LLM sebagai reasoning/response layer, bukan sumber data langsung.

## 3. Arsitektur Umum

```
User
  |
  v
Frappe Backend
  |  HTTP + Bearer RETRIEVAL_API_KEY, body { actor }
  v
retrieval-service
  |
  |-- Fastify (guard API key + rate limit di root instance)
  |-- Gemini embedding client
  |-- Qdrant retrieval (difilter per source)
  |-- MCP tool router --> Frappe (header X-Alpha-Actor)
  |-- OpenAI-compatible LLM client
  |
  +--> jawaban + sources + tools_used
```

### Alur `/chat` sesungguhnya

Ini bukan pipeline linear; urutannya berlapis dengan fallback:

```
1. faq_search          -> Qdrant, difilter source = frappe_faq
2. tools/list          -> MCP Frappe. Gagal => tools = [] dan alur lanjut
3. get_environment_context  (wajib, hanya bila ada job_id)
4. native tool calling -> LLM memilih tool lewat tool_calls, lalu replay
5. fallback planner    -> bila provider tak mendukung tools, LLM diminta
                          JSON ketat {"calls":[...]}; output tak valid = 0 call
6. compose             -> LLM menyusun jawaban akhir dari FAQ + hasil tool
```

Route yang dilaporkan di response:

| `route`    | Kondisi                                                |
| ---------- | ------------------------------------------------------ |
| `faq`      | Hanya FAQ yang menjawab, tidak ada tool berhasil       |
| `hybrid`   | FAQ dan/atau environment digabung dengan hasil tool    |
| `fallback` | Tidak ada FAQ dan tidak ada tool — diteruskan ke admin |

Ketika tidak ada konteks memadai, service **tidak** mengarang: ia mengembalikan
`needs_admin: true` dengan `reason` (`no_faq_match` / `insufficient_context`).

### Alur Ingestion

```
FAQ (Frappe doc_events)
    |
    v
retrieval-service  /faq/bulk | /faq/reindex | PUT /faq/:id
    |
    | question+answer -> Gemini embedding -> upsert
    v
Qdrant (payload: text, question, answer, source, content_hash, ...)
```

Upsert FAQ memakai `content_hash`; dokumen yang tidak berubah dilewati tanpa
memanggil embedding, sehingga sinkronisasi berulang tidak berbiaya token.

## 4. Komponen

### 4.1 retrieval-service

**Endpoint yang benar-benar ada.** Semua kecuali `/health` mewajibkan
`Authorization: Bearer $RETRIEVAL_API_KEY`.

| Method | Path                  | Fungsi                                              |
| ------ | --------------------- | --------------------------------------------------- |
| GET    | `/health`             | Liveness + status Qdrant. Publik.                   |
| POST   | `/chat`               | Orkestrasi penuh: FAQ + MCP tool + LLM              |
| POST   | `/answer`             | Retrieval + jawaban LLM                             |
| POST   | `/query`              | Alias `/answer` (kompatibilitas)                    |
| POST   | `/search`             | Semantic search mentah, filter `min_score`+`source` |
| POST   | `/index`              | Index dokumen generik                               |
| POST   | `/faq/bulk`           | Batch upsert/delete FAQ                             |
| POST   | `/faq/reindex`        | Reindex asinkron, non-destruktif                    |
| GET    | `/faq/reindex/status` | Status reindex terakhir                             |
| POST   | `/faq/generate`       | Draft FAQ dari transkrip                            |
| PUT    | `/faq/:id`            | Upsert satu FAQ                                     |
| DELETE | `/faq/:id`            | Hapus satu FAQ                                      |

Tidak ada prefix `/v1` dan tidak ada `/ready` — `/health` merangkap keduanya.
`/health` mengembalikan 200 selama proses hidup, dengan status dependency di
body:

```json
{ "ok": true, "qdrant": true }
```

Qdrant yang sedang down menghasilkan `"qdrant": false`, bukan 503. Ini disengaja:
orchestrator tidak boleh me-restart proses yang sehat karena dependency-nya
sedang bermasalah.

**Contoh request `POST /chat`:**

```json
{
  "question": "Apa syarat apply job ini?",
  "type": "staff",
  "actor": "staff@example.com",
  "job_id": "JOB-0001",
  "limit": 5,
  "min_score": 0.7
}
```

`message` diterima sebagai alias `question`. `type` memilih katalog tool
(`staff` / `manager`) tetapi **bukan** kontrol otorisasi — lihat §17.3.

**Contoh response:**

```json
{
  "answer": "Syarat apply job ini adalah ...",
  "route": "hybrid",
  "needs_admin": false,
  "reason": "tool_match",
  "tools_used": ["faq_search", "get_environment_context", "get_job_context"],
  "sources": [
    {
      "id": "…",
      "score": 0.82,
      "payload": { "text": "…", "source": "frappe_faq", "question": "…" }
    }
  ]
}
```

### 4.2 Qdrant

- Container terpisah, bukan digabung ke image `retrieval-service`.
- Alasan: storage lifecycle sendiri, backup lebih mudah, scaling independen, aman saat `retrieval-service` restart, upgrade tanpa rebuild app.

Detail implementasi yang relevan:

- **Point ID deterministik.** ID dokumen di-hash SHA-256 lalu diformat sebagai
  UUID (`pointId`), karena Qdrant hanya menerima UUID atau integer. Efeknya
  upsert bersifat idempoten, dan `original_id` disimpan di payload agar ID asal
  tetap bisa dipakai untuk filter.
- **Collection dibuat otomatis** pada upsert pertama, dengan ukuran vector
  mengikuti model embedding yang aktif.
- **Perubahan dimensi ditolak eksplisit.** Bila `EMBEDDING_MODEL` diganti ke
  model dengan dimensi berbeda, upsert gagal dengan pesan yang menyebut ukuran
  lama dan baru — bukan error opaque jauh di kemudian hari.
- **Payload index `source`** dibuat agar filter per-source (dipakai FAQ search
  dan reindex) tetap cepat.

### 4.3 Embedding Provider — Gemini

Embedding dihitung lewat **Gemini** (`@google/genai`), bukan model lokal dan
bukan endpoint OpenAI-compatible.

- Dikonfigurasi oleh `EMBEDDING_API_KEY` dan `EMBEDDING_MODEL` saja; **tidak ada
  `EMBEDDING_API_URL`**.
- `retrieval-service` tidak meng-install, men-download, maupun menyimpan model
  embedding lokal.
- Dimensi collection Qdrant mengikuti model yang dipilih (lihat §4.2).
- Setiap panggilan dibatasi `EMBEDDING_TIMEOUT_MS`.

Embedding dan LLM sengaja memakai provider berbeda: keduanya dipilih atas
kriteria yang berbeda (biaya per token vs kualitas penalaran) dan tidak ada
alasan mengikatnya jadi satu.

### 4.4 LLM Provider

LLM memakai SDK `openai` terhadap endpoint **OpenAI-compatible** mana pun
(`OPENAI_API_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`).

- (+) Service ringan, tanpa GPU, tanpa runtime model lokal.
- (+) Provider bisa ditukar tanpa perubahan kode.
- (–) Ada biaya token dan data dikirim ke provider.

Service tidak berasumsi provider mendukung native tool calling. Bila panggilan
dengan `tools` ditolak, error dideteksi dan alur turun ke planner berbasis JSON
(§3). Ini yang membuat provider OpenAI-compatible sederhana tetap bisa dipakai.

## 5. Stack Teknologi

```
Node.js 22 LTS
TypeScript
Fastify 5
Zod 4
openai              (chat / tool calling, OpenAI-compatible)
@google/genai       (embedding)
@qdrant/js-client-rest
```

Test memakai `node --test` bawaan Node dengan `tsx` sebagai loader — tanpa
framework test tambahan.

Alternatif yang dipertimbangkan dan alasan tidak dipilih:

- **Local-model stack**: hanya masuk akal bila menjalankan model sendiri, yang
  justru merupakan hal yang dihindari desain ini.
- **Go**: bagus untuk API service, tapi ekosistem klien LLM/embedding lebih matang
  di TypeScript.
- **AI SDK (`ai` + `@ai-sdk/*`)**: sempat direncanakan, tidak jadi dipakai. SDK
  `openai` dan `@google/genai` langsung memberi kontrol lebih eksplisit atas
  bentuk request tool calling dan atas deteksi provider yang tidak mendukungnya —
  justru titik yang paling butuh penanganan khusus di service ini.

## 6. Struktur Proyek

```
retrieval-service/
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── package.json
├── tsconfig.json
├── .env.example
├── .github/
│   ├── dependabot.yml
│   └── workflows/
│       ├── verify.yml     # checks yang dipakai ulang
│       ├── ci.yml         # PR + push develop/master
│       └── release.yml    # publish image ke GHCR
├── src/
│   ├── server.ts          # buildApp, hook global, graceful shutdown
│   ├── config.ts          # skema env Zod + loader .env
│   ├── routes/
│   │   ├── auth.ts        # guard API key + rate limiter
│   │   ├── health.ts
│   │   ├── index.ts       # /index /search /answer /chat /query
│   │   └── faq.ts         # /faq/*
│   ├── schemas/
│   │   ├── query.ts
│   │   └── faq.ts
│   └── services/
│       ├── embeddings.ts
│       ├── qdrant.ts
│       ├── rag.ts
│       ├── faq.ts
│       ├── mcp.ts
│       └── frappe.ts
└── test/
    ├── config.test.ts
    ├── faq.test.ts
    ├── qdrant.test.ts
    ├── security.test.ts
    └── server.test.ts
```

Setiap service diekspos lewat factory (`createRagService`, `createQdrantStore`,
…) dan di-inject melalui `buildApp({ … })`. Test mengganti dependency dengan
fake dan tidak pernah menyentuh jaringan.

`rootDir` di `tsconfig.json` adalah `.`, sehingga hasil build berada di
`dist/src/server.js` — bukan `dist/server.js`.

## 7. Deployment

`docker-compose.yml` di repo ini adalah sumber kebenaran; yang berikut hanya
catatan atas keputusannya.

- Container selalu listen di port 3000. Hanya port yang dipublish yang
  dikonfigurasi (`PUBLISHED_PORT`), agar healthcheck di image tetap valid.
- `env_file: .env` membawa seluruh secret, lalu blok `environment` meng-override
  `QDRANT_URL`, `HOST`, `PORT`, `NODE_ENV`. Compose memberi prioritas pada
  `environment`, dan itulah tujuannya: `.env` milik developer biasanya menunjuk
  `localhost`, yang salah di dalam jaringan container.
- Qdrant **tidak** dipublish ke host secara default. Membukanya tanpa mengisi
  `QDRANT_API_KEY` berarti seluruh isi collection terbuka bagi siapa pun yang
  bisa menjangkau port tersebut.
- Log dibatasi rotasi (`max-size`, `max-file`) agar disk tidak habis.

Bila Frappe berada di compose/network lain:

```bash
docker network connect rag-net <nama-container-frappe>
```

Atau deklarasikan `rag-net` sebagai network eksternal.

## 8. Environment Variables

Divalidasi Zod saat boot (`src/config.ts`). Variabel wajib yang kosong membuat
proses **gagal start**, bukan gagal pada request pertama. `process.env` menang
atas file `.env`.

**Wajib**

| Variable            | Keterangan                                      |
| ------------------- | ----------------------------------------------- |
| `QDRANT_URL`        | Endpoint Qdrant                                 |
| `FRAPPE_URL`        | Base URL Frappe                                 |
| `FRAPPE_AUTH_TOKEN` | Format `token api_key:api_secret`               |
| `RETRIEVAL_API_KEY` | Shared key untuk semua endpoint kecuali /health |
| `OPENAI_API_URL`    | Endpoint OpenAI-compatible                      |
| `OPENAI_API_KEY`    | —                                               |
| `OPENAI_MODEL`      | Nama model chat                                 |
| `EMBEDDING_API_KEY` | API key Gemini                                  |
| `EMBEDDING_MODEL`   | Nama model embedding Gemini                     |

**Opsional (dengan default)**

| Variable                | Default            | Keterangan                                            |
| ----------------------- | ------------------ | ----------------------------------------------------- |
| `PORT` / `HOST`         | `3000` / `0.0.0.0` |                                                       |
| `QDRANT_COLLECTION`     | `knowledge_base`   |                                                       |
| `QDRANT_API_KEY`        | —                  | Wajib bila Qdrant terjangkau dari luar                |
| `LOG_LEVEL`             | `info`             |                                                       |
| `LOG_CHAT_REQUEST_BODY` | `false`            | Mencatat pertanyaan member — jangan aktif di produksi |
| `LLM_TIMEOUT_MS`        | `60000`            |                                                       |
| `LLM_MAX_RETRIES`       | `2`                |                                                       |
| `EMBEDDING_TIMEOUT_MS`  | `30000`            |                                                       |
| `FRAPPE_TIMEOUT_MS`     | `30000`            |                                                       |
| `QDRANT_TIMEOUT_MS`     | `10000`            |                                                       |
| `MAX_BODY_BYTES`        | `1048576`          |                                                       |
| `RATE_LIMIT_MAX`        | `60`               | Per proses, bukan per cluster                         |
| `RATE_LIMIT_WINDOW_MS`  | `60000`            |                                                       |

Setiap panggilan keluar punya timeout. Ini bukan kosmetik: upstream yang
menggantung akan menahan background worker Frappe selama umur request tersebut.

`OPENAI_API_URL` dinormalisasi — base URL tanpa path akan diberi `/v1`.

## 9. Dockerfile

Multi-stage, empat stage: `deps` → `build` → `prod-deps` → `runtime`.

Keputusan yang perlu dicatat:

- **Dependency di-install sekali** dan dibagikan ke stage build, sehingga
  perubahan pada `src/` tidak memicu `npm ci` ulang.
- **`prod-deps` terpisah** menyelesaikan tree produksi dari lockfile yang sama,
  sehingga image akhir tidak pernah bersinggungan dengan devDependency.
- **`COPY` eksplisit per direktori**, bukan `COPY . .`. Ditambah `.dockerignore`,
  ini memastikan `.env`, `.git`, dan `node_modules` lokal tidak pernah masuk ke
  layer mana pun — termasuk stage antara yang tidak terkirim ke image akhir tapi
  tetap ada di cache builder.
- **`USER node`** — tidak ada yang butuh root saat runtime.
- **`HEALTHCHECK`** memakai `fetch` bawaan Node, karena `node:22-slim` tidak
  punya `curl`. Menyasar `/health` yang memang dikecualikan dari guard API key.
- **Tanpa init process.** Node jalan sebagai PID 1 dan `server.ts` memasang
  handler `SIGTERM`/`SIGINT` sehingga `docker stop` menuntaskan request yang
  sedang berjalan. Service ini tidak men-spawn child process, jadi zombie reaping
  tidak dibutuhkan; `--init` tetap bisa dipakai bila diinginkan.

Graceful shutdown penting di sini secara spesifik: memutus request di tengah
jalan berarti membuang panggilan LLM dan embedding yang **sudah dibayar**.

## 10. Dependencies

```bash
npm install fastify zod openai @google/genai @qdrant/js-client-rest
npm install -D typescript tsx @types/node prettier pino-pretty
```

Tidak ada dependency model lokal.

## 11. Alur Indexing FAQ dari Frappe

Frappe mengirim FAQ lewat `doc_events`. Payload `PUT /faq/FAQ-0001`:

```json
{
  "question": "Bagaimana cara apply job?",
  "answer": "Staff dapat apply melalui ...",
  "category": "job",
  "enabled": true,
  "modified": "2026-07-03T10:00:00+07:00"
}
```

Internal: `question + answer -> content_hash -> (bila berubah) Gemini embedding
-> Qdrant upsert`.

Untuk dokumen non-FAQ, `POST /index` menerima `{ documents: [{ id, text, source,
metadata }] }`.

## 12. Alur Query

`POST /search` — dedup dan retrieval mentah:

```json
{
  "question": "Bagaimana cara apply job?",
  "limit": 5,
  "min_score": 0.7,
  "source": "frappe_faq"
}
```

`source` opsional dan membatasi hasil ke satu payload `source`. Collection
dipakai bersama dokumen `/index`, jadi pemanggil yang FAQ-oriented (dedup dan
tool MCP `faq_search`) harus mengirim `"source": "frappe_faq"` — tanpa itu
dokumen non-FAQ bisa muncul sebagai match tanpa question/answer.

Internal: `question -> Gemini embedding -> Qdrant search (filter source) ->
filter min_score`.

`POST /chat` menjalankan alur lengkap di §3.

## 13. Batasan RAG vs MCP Tool Calling

MCP **tidak** dipakai untuk semua query — hanya untuk data dinamis yang tidak cocok disimpan sebagai vector statis.

### Masuk Qdrant (RAG)

Data yang **jarang berubah**, berbasis teks, butuh semantic search:

- FAQ, SOP, dokumentasi, policy, knowledge base
- Deskripsi fitur & panduan penggunaan

### Masuk MCP / Tool Calling

Data yang **sering berubah**, butuh filter akurat, permission, dan real-time:

- Job aktif, schedule, staff availability, replacement status
- Attendance, payment status, capacity, user permission

### Transport MCP

MCP di sini **bukan** transport stdio/SSE standar. Klien
(`src/services/mcp.ts`) membungkus JSON-RPC 2.0 di atas satu whitelisted method
Frappe:

| `type`    | Method Frappe                          |
| --------- | -------------------------------------- |
| `staff`   | `alpha_fitness.mcp.handle_staff_mcp`   |
| `manager` | `alpha_fitness.mcp.handle_manager_mcp` |

Method yang didukung: `tools/list` dan `tools/call`. Klien menyaring argumen
terhadap `inputSchema` yang diiklankan tool dan memvalidasi field `required`
sebelum memanggil — jadi argumen halusinasi dari LLM ditolak di sisi klien,
bukan diteruskan ke Frappe.

### Diagram keputusan

```
query
  |
  v
retrieval-service
  |-- faq_search              -> Qdrant (source = frappe_faq)
  |-- get_environment_context -> MCP, wajib bila ada job_id
  |-- tool pilihan LLM        -> MCP (native tool calling / planner JSON)
  v
LLM compose -> answer + sources + tools_used
```

## 14. Skema Data di Qdrant

Qdrant menyimpan **vector + payload metadata + text chunk** — jangan hanya vector tanpa teks, agar tidak perlu lookup ulang ke Frappe saat retrieval.

Payload FAQ (`source: "frappe_faq"`):

```json
{
  "original_id": "frappe_faq:FAQ-0001",
  "text": "Bagaimana cara apply job?\nStaff dapat apply melalui ...",
  "source": "frappe_faq",
  "source_id": "FAQ-0001",
  "question": "Bagaimana cara apply job?",
  "answer": "Staff dapat apply melalui ...",
  "category": "job",
  "enabled": true,
  "modified": "2026-07-03T10:00:00+07:00",
  "content_hash": "…"
}
```

Collection dipakai bersama oleh FAQ dan dokumen `/index`. Karena itu FAQ search
**selalu** difilter `source = frappe_faq`: tanpa filter, dokumen `/index` yang
tidak punya field `question`/`answer` akan muncul sebagai FAQ match kosong.

Untuk data dinamis seperti Job Schedule: jangan disimpan di Qdrant sama sekali;
ambil dari Frappe via MCP tool.

## 15. Penamaan Service

| Lingkup                         | Nama yang direkomendasikan              |
| ------------------------------- | --------------------------------------- |
| Hanya embedding + Qdrant search | `retrieval-service`                     |
| Termasuk LLM + MCP tool calling | `assistant-service` / `ai-orchestrator` |

Nama `retrieval-service` dipertahankan dengan lingkup terdokumentasi mencakup RAG + tools + LLM.

## 16. Ringkasan Desain Final

**Rule utama:**

- FAQ / SOP / static docs → Qdrant
- Job / schedule / staff / payment / live data → MCP tool call ke Frappe
- Embedding → selalu via Gemini API, bukan local model
- LLM → selalu via provider API, hanya untuk reasoning & natural language response
- Konteks tidak cukup → `needs_admin: true`, bukan jawaban karangan

Desain ini dipilih karena paling ringan untuk server aplikasi, scalable, dan tidak membebani Frappe maupun `retrieval-service` dengan workload model AI lokal.

## 17. Model Keamanan & Otorisasi

### 17.1 Autentikasi transport

Setiap endpoint **kecuali `/health`** mewajibkan `Authorization: Bearer $RETRIEVAL_API_KEY`.
Guard didaftarkan sebagai hook `onRequest` di instance root (`src/routes/auth.ts`),
bukan di dalam plugin route. Ini disengaja: Fastify meng-enkapsulasi hook yang
didaftarkan di dalam plugin, sehingga guard per-plugin hanya melindungi route
plugin tersebut dan menyisakan `/chat`, `/search`, `/index`, `/answer`, `/query`
terbuka.

Perbandingan key memakai `timingSafeEqual`, dengan pengecekan panjang terpisah
karena fungsi tersebut melempar pada panjang berbeda (panjang key bukan rahasia).

Regresi ini dijaga oleh `test/security.test.ts`, yang menegaskan seluruh daftar
route menolak caller tanpa kredensial maupun dengan key salah, dan oleh smoke
test di `ci.yml` yang menguji hal sama terhadap image hasil build.

### 17.2 Identitas end-user (`X-Alpha-Actor`)

retrieval-service terhubung ke Frappe dengan **satu** service account
(`FRAPPE_AUTH_TOKEN`). Artinya `frappe.session.user` bernilai sama untuk semua
caller dan tidak dapat dipakai untuk otorisasi.

Identitas asli dibawa terpisah:

```
Frappe (set actor = frappe.session.user, server-side)
   -> retrieval-service  (body: { actor })          [auth: RETRIEVAL_API_KEY]
   -> Frappe MCP         (header: X-Alpha-Actor)    [auth: FRAPPE_AUTH_TOKEN]
   -> tool: _get_actor() -> _require_*()
```

Header ini layak dipercaya justru karena kedua hop di depannya terautentikasi.

`actor` **tidak pernah** dimasukkan ke argumen tool atau ke prompt — hanya ke
header — sehingga tidak ada jalur bagi prompt injection untuk memalsukannya.
Header ini juga di-redact dari log, bersama `authorization` dan `cookie`.

### 17.3 Otorisasi di level tool

| Helper (`tools/mcp_shared.py`) | Dipakai oleh                         |
| ------------------------------ | ------------------------------------ |
| `_require_user()`              | tool general (FAQ, konteks waktu)    |
| `_require_staff_access(id)`    | tool `staff/context.py` ber-staff_id |
| `_require_job_access(id)`      | tool ber-job_id                      |
| `_require_manager()`           | seluruh tool `manager/*`             |

Field `type` (`staff` / `manager`) yang memilih katalog tool berasal dari **body
request**, sehingga tidak boleh menjadi satu-satunya kontrol. Otorisasi
sesungguhnya terjadi di tool lewat `_require_manager()`.

### 17.4 Prompt injection

Seluruh konten hasil retrieval — FAQ, hasil environment, hasil tool, dan
transkrip di `/faq/generate` — diperlakukan sebagai **data untrusted** dan
diberi label demikian di dalam prompt. Konteks request yang tepercaya
dipisahkan secara eksplisit dari data untrusted.

Penjagaan tambahan:

- Planner diinstruksikan tidak menyimpulkan kemampuan tool dari namanya, hanya
  dari `description` yang diiklankan.
- Output planner diparse ketat: bukan JSON, ada key berlebih, jumlah call
  melebihi batas, atau nama tool tak dikenal ⇒ **nol** tool dieksekusi.
- Maksimum 3 optional tool call per request; duplikat (nama + argumen sama)
  ditolak.
- Argumen dari konteks request selalu meng-override argumen usulan LLM, dan
  `type` selalu dibuang dari argumen tool.
- Prompt komposisi melarang membocorkan ID internal mentah dan melarang
  mengarang label untuk ID yang tidak dikenal.

### 17.5 Catatan operasional

- **Qdrant**: set `QDRANT_API_KEY` bila Qdrant dapat dijangkau di luar jaringan
  container. Tanpa itu, isolasi jaringan menjadi satu-satunya kontrol. Karena
  itu compose tidak mempublish port Qdrant secara default.
- **Rate limit bersifat per-proses.** Dengan N replica, batas efektifnya
  `RATE_LIMIT_MAX * N`. Untuk kuota lintas-replica yang benar, pindahkan ke
  reverse proxy atau backing store bersama.
- **Status reindex disimpan in-memory**, jadi hilang saat restart dan tidak
  dibagi antar replica. Ini dapat diterima karena reindex bersifat
  non-destruktif dan idempoten (lihat 17.6): menjalankannya ulang aman.
  Menjalankan lebih dari satu replica hanya membuat pekerjaan mubazir, bukan
  merusak index.
- **`MAX_BODY_BYTES` dan rate limit adalah kontrol biaya**, bukan sekadar
  higiene: endpoint ini membelanjakan uang per panggilan (LLM + embedding),
  sehingga body atau laju request tak terbatas adalah vektor cost-DoS.

### 17.6 Reindex non-destruktif

Urutan sebelumnya adalah _hapus semua → embed ulang satu per satu_, yang
mengosongkan index selama seluruh proses dan meninggalkannya rusak permanen jika
ada satu panggilan embedding yang gagal.

Urutan sekarang:

1. upsert seluruh generasi baru (ID deterministik, jadi menimpa in-place);
2. baru hapus point `frappe_faq` yang tidak tercakup generasi baru
   (`deleteBySourceExcept`).

Index tidak pernah kosong, dan kegagalan di tengah jalan menyisakan generasi
sebelumnya tetap utuh.

## 18. Embedding & LLM: satu pintu

Aplikasi Frappe **tidak lagi menghitung embedding sendiri**. Stack lokal
(`sentence_transformers` + `all-MiniLM-L6-v2` + cosine similarity numpy) sudah
dicabut beserta `embedding_service.py` dan `rag_service.py`.

Alasan mencabutnya, bukan sekadar memindahkannya ke belakang endpoint:

- **Model drift.** Dua tempat yang menghitung embedding berarti dua konfigurasi
  model. Begitu keduanya berbeda, vektornya tidak sebanding dan dedup rusak
  tanpa error — kelas bug yang persis terjadi sebelumnya.
- **Konsumennya tidak butuh vektor.** Satu-satunya pemakai yang masih hidup
  (`check_duplicate_faq`) hanya perlu jawaban "mirip atau tidak", yang sudah
  dijawab `/search`. Mengirim ribuan float lewat HTTP untuk direduksi jadi satu
  boolean tidak ada gunanya.
- **Satu index of record.** Qdrant menjadi satu-satunya penyimpan vektor;
  kolom `FAQ.embedding` tidak lagi dibaca maupun ditulis.

### Pemetaan

| Kebutuhan lama (lokal)                     | Sekarang                                     |
| ------------------------------------------ | -------------------------------------------- |
| `generate_embedding` + scan FAQ            | `POST /search` (dedup & retrieval)           |
| `generate_faq_from_chat` + OpenAI langsung | `POST /faq/generate`                         |
| `regenerate_embedding` (hook FAQ)          | dihapus — sinkronisasi Qdrant via doc_events |

### `POST /faq/generate`

```
{ "messages": [ { "sender_type": "User", "message": "..." } ] }
->
{ "question": string, "answer": string, "is_useful": boolean }
```

Prompt, pilihan model, dan validasi respons semuanya di sini — pemanggil hanya
menerima field yang sudah tervalidasi lewat `FaqDraftSchema`. Balasan model
yang tidak sesuai bentuk ditolak, bukan diteruskan. Model tidak lagi
di-hardcode `gpt-4o-mini`; mengikuti `OPENAI_MODEL`.

Transkrip diperlakukan sebagai **untrusted data** di dalam prompt.
`is_useful: false` berarti percakapan tersebut tidak layak jadi FAQ.

### Tidak dibuat: endpoint embedding mentah

Endpoint yang mengembalikan vektor sengaja **tidak** disediakan. Kalau nanti ada
konsumen yang benar-benar butuh vektor (mis. clustering di luar Qdrant), itu
baru alasan menambahkannya — bukan sebelumnya.

## 19. CI/CD

| Workflow      | Pemicu                       | Isi                                                  |
| ------------- | ---------------------------- | ---------------------------------------------------- |
| `verify.yml`  | dipanggil workflow lain      | format, typecheck + test (Node 22 & 24), `npm audit` |
| `ci.yml`      | PR & push `master`/`develop` | `verify` + build image + smoke test container        |
| `release.yml` | push `master`, tag `v*.*.*`  | `verify` lalu push multi-arch ke GHCR + attestation  |

Keputusan yang perlu dicatat:

- **`verify.yml` reusable, bukan disalin.** `release.yml` menjadikannya `needs`
  dari job publish, sehingga tag yang di-push tidak bisa menerbitkan image dari
  commit yang belum lolos test. Menyalin langkah-langkahnya akan membuat kedua
  jalur perlahan menyimpang.
- **Job agregat `CI`.** Branch protection menunjuk satu context bernama `CI`,
  bukan tiap job. Menambah job atau entri matrix tidak menuntut perubahan aturan
  proteksi — kelalaian yang biasanya baru ketahuan setelah ada yang merge kode
  merah.
- **Smoke test terhadap image, bukan hanya source.** Menguji tiga hal yang tidak
  tercakup unit test: container boot dengan environment nyata (jadi kesalahan
  skema config tertangkap), `/chat` tanpa kredensial tetap 401 di image jadi, dan
  SIGTERM menghentikan container sebelum kill timeout 10 detik.
- **`npm audit --omit=dev`.** Advisory yang hanya menyentuh devDependency tidak
  boleh memblokir rilis image yang tidak memuat paket tersebut.
- **Matrix Node 22 & 24.** 22 adalah versi runtime image; 24 memberi peringatan
  dini sebelum base image naik versi.
- **Push hanya dari `release.yml`.** `ci.yml` membangun image tapi tidak pernah
  mendorongnya, sehingga PR dari fork tidak butuh kredensial registry.

Tag image: push `master` → `:edge` + `:sha-<commit>`; tag `v1.2.3` → `:1.2.3`,
`:1.2`, `:1`, `:latest`.

Branch protection tidak bisa dipasang oleh workflow atas dirinya sendiri; itu
setting repositori. Perintah `gh` untuk memasangnya ada di
[README](README.md#guard-branch-master).
