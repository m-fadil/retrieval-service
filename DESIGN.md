# DESIGN.md — Retrieval / Assistant Service

## 1. Latar Belakang

Frappe tidak boleh menjalankan model AI lokal, termasuk embedding model seperti `sentence_transformers`, di dalam proses request. Untuk menjaga Frappe tetap ringan dan menghindari dependency model lokal, seluruh logic AI (provider embedding, vector search, LLM provider, tool calling) dipindahkan ke service terpisah bernama **`retrieval-service`** (alias: `assistant-service` / `ai-orchestrator`).

Karena service ini mencakup lebih dari sekadar retrieval — termasuk LLM reasoning dan MCP tool calling — secara domain ini lebih dekat ke **AI gateway / AI orchestration service**. Nama `retrieval-service` tetap bisa dipakai, tapi didefinisikan lingkupnya mencakup RAG + tools + LLM.

## 2. Tujuan

- Frappe dan `retrieval-service` tidak perlu load model embedding lokal.
- Semantic search (RAG) untuk knowledge statis (FAQ, SOP, dokumentasi).
- Tool calling (MCP) untuk data dinamis (job, schedule, staff, payment).
- LLM sebagai reasoning/response layer, bukan sumber data langsung.

## 3. Arsitektur Umum

```
User Request
    |
    v
Frappe Backend
    |
    | HTTP/gRPC
    v
retrieval-service
    |
    | 1. kirim query ke embedding provider
    | 2. search vector ke Qdrant
    | 3. ambil top-k context
    | 4. optional rerank
    | 5. optional tool calling MCP
    | 6. kirim prompt ke LLM
    | 7. return answer + sources
    v
Frappe
```

### Alur Ingestion

```
FAQ / Job / Schedule / Docs
    |
    v
Frappe --(webhook/queue/API)--> retrieval-service
    |
    | chunk text -> embedding provider -> upsert vector
    v
Qdrant
```

## 4. Komponen

### 4.1 retrieval-service

Tanggung jawab utama:

- Terima query dari Frappe
- Panggil embedding provider untuk query/dokumen
- Search ke Qdrant
- Susun context
- Panggil LLM
- MCP tool calling bila perlu
- Return jawaban final + sumber

**Endpoint minimal:**

| Method | Path          | Fungsi               |
| ------ | ------------- | -------------------- |
| POST   | `/v1/query`   | Query RAG + LLM      |
| POST   | `/v1/upsert`  | Index/update dokumen |
| POST   | `/v1/delete`  | Hapus dokumen        |
| POST   | `/v1/reindex` | Reindex ulang        |
| GET    | `/health`     | Liveness check       |
| GET    | `/ready`      | Readiness check      |

**Contoh request `POST /v1/query`:**

```json
{
  "query": "Apa syarat apply job ini?",
  "namespace": "faq",
  "top_k": 5,
  "use_llm": true,
  "use_tools": true,
  "metadata": { "user_id": "S004", "role": "staff" }
}
```

**Contoh response:**

```json
{
  "answer": "Syarat apply job ini adalah ...",
  "sources": [
    {
      "id": "faq-123",
      "score": 0.82,
      "text": "Staff harus memenuhi ...",
      "metadata": { "doctype": "FAQ", "name": "FAQ-0001" }
    }
  ],
  "tool_calls": [{ "tool": "get_job_detail", "status": "success" }]
}
```

### 4.2 Qdrant

- Dijalankan sebagai container terpisah (bukan digabung ke image `retrieval-service`).
- Alasan: storage lifecycle sendiri, backup lebih mudah, scaling independen, aman saat `retrieval-service` restart, upgrade tanpa rebuild app.

### 4.3 Embedding Provider

Embedding **wajib menggunakan provider/API eksternal atau OpenAI-compatible endpoint**, bukan model lokal.

- `retrieval-service` tidak meng-install dependency model lokal.
- `retrieval-service` tidak men-download atau menyimpan model embedding lokal.
- Embedding dokumen dan query dibuat melalui AI SDK/OpenAI-compatible embedding provider.
- Embedding provider boleh sama dengan LLM provider atau terpisah.
- Vector dimension Qdrant harus mengikuti model embedding provider yang dipilih.

Contoh model provider:

- `text-embedding-3-small`
- model embedding lain dari OpenAI-compatible provider

### 4.4 LLM Provider

LLM **wajib menggunakan provider/API eksternal atau OpenAI-compatible endpoint** melalui AI SDK, bukan local model.

- (+) Service ringan, tanpa GPU, tanpa runtime model lokal.
- (+) Deployment lebih sederhana.
- (–) Ada biaya token dan data dikirim ke provider.

**Rekomendasi awal:** embedding provider + Qdrant + LLM provider. Tidak ada model AI lokal di `retrieval-service`.

## 5. Stack Teknologi

**Pilihan: TypeScript + Fastify**

Alasan: kebutuhan final adalah API gateway + provider embedding + provider LLM + tool calling HTTP/MCP. Tidak ada model lokal, sehingga TypeScript lebih sederhana dan cocok memakai AI SDK untuk OpenAI-compatible provider, embedding, structured output, dan tool calling.

```
Node.js 22 LTS
TypeScript
Fastify
Zod
AI SDK
@ai-sdk/openai-compatible
@qdrant/js-client-rest
```

Alternatif yang dipertimbangkan dan alasan tidak dipilih:

- **Local-model stack**: cocok jika menjalankan embedding/model sendiri, tapi tidak dibutuhkan karena semua model memakai provider API.
- **Go**: bagus untuk API service, tapi integrasi LLM/tool calling provider lebih praktis dengan AI SDK di TypeScript.

## 6. Struktur Proyek

```
retrieval-service/
├── Dockerfile
├── package.json
├── tsconfig.json
├── docker-compose.yml
└── src/
    ├── server.ts
    ├── config.ts
    ├── schemas.ts
    ├── embedding.ts
    ├── qdrant-store.ts
    ├── rag.ts
    ├── llm.ts
    └── tools.ts
```

## 7. Docker Compose (blueprint)

```yaml
services:
  retrieval-service:
    build:
      context: ./retrieval-service
      dockerfile: Dockerfile
    container_name: retrieval-service
    restart: unless-stopped
    ports:
      - "8008:8000"
    environment:
      APP_ENV: production
      QDRANT_URL: http://qdrant:6333
      QDRANT_COLLECTION: knowledge_base
      FRAPPE_URL: http://localhost:8000
      FRAPPE_AUTH_TOKEN: ${FRAPPE_AUTH_TOKEN}
      OPENAI_API_URL: ${OPENAI_API_URL}
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      OPENAI_MODEL: ${OPENAI_MODEL}
      EMBEDDING_API_URL: ${EMBEDDING_API_URL}
      EMBEDDING_API_KEY: ${EMBEDDING_API_KEY}
      EMBEDDING_MODEL: ${EMBEDDING_MODEL}
    depends_on:
      - qdrant
    networks:
      - rag-net

  qdrant:
    image: qdrant/qdrant:latest
    container_name: qdrant
    restart: unless-stopped
    ports:
      - "6333:6333"
      - "6334:6334"
    volumes:
      - qdrant-storage:/qdrant/storage
    networks:
      - rag-net

volumes:
  qdrant-storage:

networks:
  rag-net:
    name: rag-net
```

Jika Frappe berada di compose/network lain:

```bash
docker network connect rag-net frappe-container-name
```

Atau deklarasikan network eksternal:

```yaml
networks:
  rag-net:
    external: true
```

## 8. Environment Variables

```env
# Qdrant vector database endpoint
QDRANT_URL=http://qdrant:6333

# Qdrant collection name
QDRANT_COLLECTION=knowledge_base

# Frappe backend base URL
FRAPPE_URL=http://localhost:8000

# Frappe API auth token, format: token api_key:api_secret
FRAPPE_AUTH_TOKEN=token 02672f80b4a841b:dff90bf72c2aead

# OpenAI-compatible chat/completion API base URL
OPENAI_API_URL=

# OpenAI-compatible chat/completion API key
OPENAI_API_KEY=

# OpenAI-compatible chat model name
OPENAI_MODEL=

# OpenAI-compatible embedding API base URL; can reuse OPENAI_API_URL
EMBEDDING_API_URL=

# OpenAI-compatible embedding API key; can reuse OPENAI_API_KEY
EMBEDDING_API_KEY=

# OpenAI-compatible embedding model name
EMBEDDING_MODEL=
```

Jika embedding dan LLM memakai provider yang sama, `EMBEDDING_API_URL` dan `EMBEDDING_API_KEY` boleh diisi sama dengan `OPENAI_API_URL` dan `OPENAI_API_KEY`.

## 9. Dockerfile

```dockerfile
FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist ./dist

EXPOSE 8000

CMD ["node", "dist/server.js"]
```

Untuk development image, build TypeScript sebelum menjalankan container production.

## 10. package.json dependencies

```bash
npm install fastify zod ai @ai-sdk/openai-compatible @qdrant/js-client-rest
npm install -D typescript tsx @types/node
```

Tidak ada dependency model lokal. Embedding dan LLM dipanggil lewat provider API menggunakan AI SDK dan OpenAI-compatible provider.

## 11. Alur Indexing dari Frappe

Contoh dokumen FAQ:

```
FAQ-0001
question: Bagaimana cara apply job?
answer: Staff dapat apply melalui ...
```

Payload ke `POST /v1/upsert`:

```json
{
  "documents": [
    {
      "id": "FAQ-0001",
      "text": "Pertanyaan: Bagaimana cara apply job?\nJawaban: Staff dapat apply melalui ...",
      "metadata": {
        "doctype": "FAQ",
        "name": "FAQ-0001",
        "source": "frappe",
        "module": "job"
      }
    }
  ]
}
```

Proses internal: `text -> embedding provider -> qdrant upsert`.

## 12. Alur Query

Payload ke `POST /v1/query`:

```json
{
  "query": "Bagaimana cara apply job?",
  "top_k": 5,
  "use_llm": true
}
```

Proses internal: `query -> embedding provider -> qdrant search -> context -> LLM provider -> answer`.

## 13. Batasan RAG vs MCP Tool Calling

MCP **tidak** dipakai untuk semua query — hanya untuk data dinamis yang tidak cocok disimpan sebagai vector statis.

### Masuk Qdrant (RAG)

Cocok untuk data yang **jarang berubah**, berbasis teks, butuh semantic search:

- FAQ
- SOP
- Dokumentasi
- Policy
- Help center / Knowledge base
- Deskripsi fitur & panduan penggunaan

### Masuk MCP / Tool Calling

Cocok untuk data yang **sering berubah**, butuh filter akurat, permission, dan real-time:

- Job aktif
- Schedule
- Staff availability
- Replacement status
- Attendance
- Payment status
- Capacity
- User permission

### Contoh Tools

```
get_job_detail(job_id)
search_available_jobs(date, location)
get_staff_schedule(staff_id)
get_replacement_status(job_id)
```

### Diagram keputusan

```
query
  |
  v
retrieval-service
  |
  |-- detect intent
  |-- FAQ/static knowledge -> Qdrant
  |-- dynamic data -> MCP tool call ke Frappe
```

```
Static knowledge:
Frappe -> retrieval-service -> embedding provider -> Qdrant -> LLM provider

Dynamic data:
Frappe -> retrieval-service -> MCP tool -> Frappe API/DB -> LLM provider
```

## 14. Skema Data di Qdrant

Qdrant menyimpan: **vector + payload metadata + text chunk** — jangan hanya vector tanpa teks, agar tidak perlu lookup ulang ke Frappe saat retrieval.

Contoh payload:

```json
{
  "text": "Staff dapat apply job melalui halaman Job Detail...",
  "doctype": "FAQ",
  "docname": "FAQ-0001",
  "source": "frappe",
  "module": "job",
  "updated_at": "2026-07-03T10:00:00+07:00"
}
```

Untuk data dinamis seperti Job Schedule: simpan metadata minimal saja di Qdrant, ambil detail terbaru dari Frappe via MCP tool.

## 15. Penamaan Service

| Lingkup                         | Nama yang direkomendasikan              |
| ------------------------------- | --------------------------------------- |
| Hanya embedding + Qdrant search | `retrieval-service`                     |
| Termasuk LLM + MCP tool calling | `assistant-service` / `ai-orchestrator` |

Nama `retrieval-service` tetap bisa dipertahankan selama definisi lingkupnya didokumentasikan mencakup RAG + tools + LLM (bukan sekadar retrieval murni).

## 16. Ringkasan Desain Final

```
frappe
  |
  v
retrieval-service (a.k.a assistant-service)
  |
  |-- Fastify API
  |-- AI SDK embedding provider client
  |-- qdrant retrieval
  |-- context builder
  |-- MCP tool router
  |-- AI SDK LLM provider client
  |
  +--> embedding provider
  +--> qdrant
  +--> frappe tools/API
  +--> LLM provider
```

**Rule utama:**

- FAQ / SOP / static docs → Qdrant
- Job / Schedule / staff / payment / live data → MCP tool call ke Frappe
- Embedding → selalu via provider/API, bukan local model
- LLM → selalu via provider/API, hanya untuk reasoning & natural language response

Desain ini dipilih karena paling ringan untuk server aplikasi, scalable, dan tidak membebani Frappe maupun `retrieval-service` dengan workload model AI lokal.

## 17. Model Keamanan & Otorisasi

### 17.1 Autentikasi transport

Setiap endpoint **kecuali `/health`** mewajibkan `Authorization: Bearer $RETRIEVAL_API_KEY`.
Guard didaftarkan sebagai hook `onRequest` di instance root (`src/routes/auth.ts`),
bukan di dalam plugin route. Ini disengaja: Fastify meng-enkapsulasi hook yang
didaftarkan di dalam plugin, sehingga guard per-plugin hanya melindungi route
plugin tersebut dan menyisakan `/chat`, `/search`, `/index`, `/answer`, `/query`
terbuka.

Regresi ini dijaga oleh `test/security.test.ts`, yang menegaskan seluruh daftar
route menolak caller tanpa kredensial maupun dengan key salah.

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

### 17.3 Otorisasi di level tool

| Helper (`tools/mcp_shared.py`) | Dipakai oleh                        |
| ------------------------------ | ----------------------------------- |
| `_require_user()`              | tool general (FAQ, konteks waktu)   |
| `_require_staff_access(id)`    | tool `staff/context.py` ber-staff_id |
| `_require_job_access(id)`      | tool ber-job_id                     |
| `_require_manager()`           | seluruh tool `manager/*`            |

Field `type` (`staff` / `manager`) yang memilih katalog tool berasal dari **body
request**, sehingga tidak boleh menjadi satu-satunya kontrol. Otorisasi
sesungguhnya terjadi di tool lewat `_require_manager()`.

### 17.4 Catatan operasional

- **Qdrant**: set `QDRANT_API_KEY` bila Qdrant dapat dijangkau di luar jaringan
  container. Tanpa itu, isolasi jaringan menjadi satu-satunya kontrol.
- **Rate limit bersifat per-proses.** Dengan N replica, batas efektifnya
  `RATE_LIMIT_MAX * N`. Untuk kuota lintas-replica yang benar, pindahkan ke
  reverse proxy atau backing store bersama.
- **Status reindex disimpan in-memory**, jadi hilang saat restart dan tidak
  dibagi antar replica. Ini dapat diterima karena reindex kini bersifat
  non-destruktif dan idempoten (lihat 17.5): menjalankannya ulang aman.
  Menjalankan lebih dari satu replica hanya membuat pekerjaan mubazir, bukan
  merusak index.

### 17.5 Reindex non-destruktif

Urutan sebelumnya adalah *hapus semua → embed ulang satu per satu*, yang
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

| Kebutuhan lama (lokal)          | Sekarang                                  |
| ------------------------------- | ----------------------------------------- |
| `generate_embedding` + scan FAQ | `POST /search` (dedup & retrieval)        |
| `generate_faq_from_chat` + OpenAI langsung | `POST /faq/generate`           |
| `regenerate_embedding` (hook FAQ) | dihapus — sinkronisasi Qdrant via doc_events |

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

### Tidak dibuat: endpoint embedding mentah

Endpoint yang mengembalikan vektor sengaja **tidak** disediakan. Kalau nanti ada
konsumen yang benar-benar butuh vektor (mis. clustering di luar Qdrant), itu
baru alasan menambahkannya — bukan sebelumnya.
