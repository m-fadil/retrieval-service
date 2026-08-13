# retrieval-service

AI gateway untuk Frappe: RAG di atas Qdrant, MCP tool calling ke Frappe, dan LLM
sebagai lapisan penalaran. Frappe tidak menjalankan model apa pun — tidak
embedding, tidak LLM — seluruhnya lewat service ini.

Rasional arsitektur dan model keamanannya ada di [DESIGN.md](DESIGN.md).

## Stack

Node.js 22 · TypeScript · Fastify 5 · Zod 4 · `openai` (chat & embedding,
OpenAI-compatible) · `@qdrant/js-client-rest`.

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
| `npm test`             | `node --test` (124 test)              |
| `npm run check`        | `build` lalu `test` — sama seperti CI |
| `npm run format`       | Prettier tulis                        |
| `npm run format:check` | Prettier verifikasi (dipakai CI)      |

Entry point hasil build ada di `dist/src/server.js` (karena `rootDir` di
`tsconfig.json` adalah `.`), bukan `dist/server.js`.

## Endpoint

Semua endpoint **kecuali `/health`** mewajibkan
`Authorization: Bearer $RETRIEVAL_API_KEY`.

| Method | Path                  | Fungsi                                               |
| ------ | --------------------- | ---------------------------------------------------- |
| GET    | `/health`             | Liveness + status Qdrant. Publik.                    |
| GET    | `/health/live`        | Proses hidup. Selalu 200. Publik.                    |
| GET    | `/health/ready`       | Siap menerima trafik: 503 bila Qdrant tak terjangkau |
| POST   | `/chat`               | Orkestrasi penuh: FAQ + MCP tool + LLM               |
| POST   | `/chat/async`         | Seperti `/chat`, tapi 202 + callback ke Frappe       |
| POST   | `/answer`             | Retrieval + jawaban LLM                              |
| POST   | `/query`              | Alias `/answer`, dipertahankan untuk kompatibilitas  |
| POST   | `/search`             | Semantic search mentah, filter `min_score`+`source`  |
| POST   | `/index`              | Index dokumen generik                                |
| POST   | `/faq/bulk`           | Batch upsert/delete FAQ                              |
| POST   | `/faq/reindex`        | Reindex asinkron, non-destruktif                     |
| POST   | `/faq/recreate`       | Drop collection (semua source) lalu reindex asinkron |
| GET    | `/faq/reindex/status` | Status reindex terakhir                              |
| POST   | `/faq/generate`       | Susun draft FAQ dari transkrip percakapan            |
| PUT    | `/faq/:id`            | Upsert satu FAQ                                      |
| DELETE | `/faq/:id`            | Hapus satu FAQ                                       |

`/health` selalu mengembalikan 200 selama proses hidup; status Qdrant dibawa di
body (`{"ok":true,"qdrant":false}`). Ini disengaja — dependency yang sedang down
bukan alasan orchestrator me-restart proses, dan healthcheck container memakai
route ini.

Yang perlu dibedakan adalah **liveness** dan **readiness**: pakai `/health/live`
untuk restart policy dan `/health/ready` untuk keputusan routing. Replica yang
tidak bisa menjangkau Qdrant menjawab setiap pertanyaan dengan "tidak ada match",
jadi `/health/ready` menjawab 503 supaya load balancer bisa menariknya.

Body yang tidak lolos skema dijawab **400** beserta daftar field yang salah
(`{"statusCode":400,"error":"Bad Request","message":"body failed validation",
"issues":[…]}`), bukan 500: validasi berjalan di dalam pipeline Fastify sebelum
handler — dan sebelum satu pun panggilan berbayar — dijalankan.

`/chat/async` menjawab **503** bila backlog job latar penuh
(`CHAT_ASYNC_MAX_QUEUED`). Menerima dengan 202 lalu membuang job berarti member
menunggu jawaban yang tidak akan pernah datang.

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

## Uji manual

`npm test` men-stub setiap dependensi luar, jadi tiga hal hanya bisa dibuktikan
dari luar proses: kredensial embedding benar, kredensial LLM benar, dan Qdrant
benar-benar menyimpan apa yang di-embed. Urutan di bawah membuktikannya dengan
`curl`, seluruhnya **sinkron** — `/chat` mengembalikan jawaban di response body,
jadi `/chat/async` (yang jawabannya dikirim sebagai callback ke Frappe, tidak
pernah ke `curl`) tidak dipakai di sini.

<details>
<summary><b>Tutorial uji manual — 7 step curl (klik untuk buka)</b></summary>

Siapkan sekali:

```bash
export BASE=http://localhost:3000
export KEY="$(grep -E '^RETRIEVAL_API_KEY=' .env | cut -d= -f2-)"
export AUTH="authorization: Bearer $KEY"
export JSON='content-type: application/json'
```

`jq` opsional di semua contoh; tambahkan `-i` bila ingin melihat status code.
Menjalankan seluruh urutan ini berulang kali bisa menyentuh `RATE_LIMIT_MAX`
(default 60/menit per `actor`) dan dijawab **429** — itu limiter bekerja, bukan
service rusak.

### 1. Proses hidup, Qdrant terjangkau

```bash
curl -s $BASE/health                     # {"ok":true,"qdrant":true}
curl -so /dev/null -w '%{http_code}\n' $BASE/health/ready   # 200 siap, 503 Qdrant mati
```

`"qdrant":false` membuat step 3 dan 5 pasti kosong. Perbaiki `QDRANT_URL` dulu —
di dalam compose nilainya `http://qdrant:6333`, bukan `localhost`.

### 2. Guard API key terpasang

```bash
curl -so /dev/null -w '%{http_code}\n' -X POST $BASE/search \
  -H "$JSON" -d '{"question":"ping"}'    # 401
```

**401 adalah hasil yang benar.** 200 di sini berarti guard tidak aktif.

### 3. Embedding berhasil — tulis lalu baca kembali

Menguji jalur embedding tanpa menyentuh LLM: `/index` meng-embed teks dan
menyimpan vektornya, `/search` meng-embed pertanyaan lalu mencocokkan.

```bash
curl -s -X POST $BASE/index -H "$AUTH" -H "$JSON" -d '{
  "documents": [{
    "id": "smoke-1",
    "text": "Kucing kantor bernama Mochi, diberi makan tiga kali sehari oleh tim office.",
    "source": "smoke_test"
  }]
}'
# {"indexed":1}
```

```bash
curl -s -X POST $BASE/search -H "$AUTH" -H "$JSON" -d '{
  "question": "siapa yang memberi makan kucing di kantor?",
  "source": "smoke_test",
  "min_score": 0
}'
```

Yang dibaca adalah `matches[0].score` (`min_score: 0` dipasang supaya skor
mentahnya kelihatan, bukan tersaring lebih dulu):

| Hasil                              | Artinya                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `score` di kisaran 0.3–0.9         | embedding dan Qdrant sehat: parafrase mendarat di dokumen yang benar        |
| `matches: []` padahal `indexed: 1` | vektor tersimpan tapi tidak match — cek `min_score`, lalu `EMBEDDING_MODEL` |
| 500 berisi pesan provider          | `EMBEDDING_API_URL` / `_KEY` / `_MODEL` salah → step 6                      |
| 500 menyebut dimensi vektor        | `EMBEDDING_MODEL` pindah ke dimensi lain; jalankan `POST /faq/recreate`     |

`source: "smoke_test"` menjaga dokumen uji ini tidak pernah ikut di jalur FAQ,
yang selalu memfilter `source: "frappe_faq"`. Point-nya tetap tinggal di
collection (tidak ada endpoint hapus untuk dokumen generik); bersihkan lewat
Qdrant langsung bila perlu.

### 4. LLM berhasil — `/answer`

`/answer` adalah retrieval + satu panggilan LLM, tanpa MCP dan tanpa triage: cara
termurah memastikan kredensial chat model benar.

```bash
curl -s -X POST $BASE/answer -H "$AUTH" -H "$JSON" \
  -d '{"question":"siapa yang memberi makan kucing di kantor?","limit":3}'
```

`answer` berisi kalimat yang menyebut tim office (dari dokumen step 3) → blok
`OPENAI_*` benar. Gagal di sini sementara step 3 hijau mengisolasi masalah ke
chat model, bukan ke embedding. `route`/`reason` di response `/answer` konstan
(`"hybrid"`/`"tool_match"`) — jangan dibaca sebagai keputusan routing.

### 5. `/chat` penuh

```bash
curl -s -X POST $BASE/chat -H "$AUTH" -H "$JSON" -d '{
  "question": "Bagaimana cara apply job?",
  "type": "staff",
  "actor": "staff@example.com"
}'
```

Berhasil atau tidak bukan ditentukan HTTP 200 saja:

- `usage.llm_calls` > 0 — panggilan LLM benar-benar terjadi **dan selesai**.
  `llm_calls: 0` pada request yang seharusnya memanggil LLM (ada `history`, atau
  retrieval kosong sehingga triage jalan) berarti setiap panggilan gagal lalu
  didegradasi diam-diam: `/chat` tetap **200** dengan `needs_admin: true` dan
  jawaban "diteruskan ke admin". Itu bukan keputusan routing — lanjut ke step 6.
  `usage.total_tokens` sendiri boleh 0 walau `llm_calls` > 0, pada backend yang
  tidak melaporkan `usage`.
- `duration_ms` — bandingkan dengan `CHAT_DEADLINE_MS` (default 75000). Yang
  mendekati batas akan mati di produksi.
- `route` dan `reason`:

| `route`        | `reason`                                                 | Artinya                                                         |
| -------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| `faq`          | `faq_match`                                              | dijawab dari FAQ hasil retrieval                                |
| `mcp`/`hybrid` | `tool_match`                                             | tool MCP Frappe terpanggil — isinya di `tools_used`             |
| `fallback`     | `conversational`                                         | triage menilai pesan sebagai basa-basi, dijawab tanpa retrieval |
| `fallback`     | `no_faq_match` / `insufficient_context` / `out_of_scope` | `needs_admin: true`, dieskalasi ke admin                        |

Pertanyaan yang jelas in-scope tapi selalu berakhir `out_of_scope` menandakan
`ASSISTANT_SCOPE` kosong atau terlalu sempit.

Untuk menguji jalur FAQ end-to-end, tanam satu FAQ lalu tanyakan dengan kata
lain — `route` harus `faq`:

```bash
curl -s -X PUT $BASE/faq/SMOKE-1 -H "$AUTH" -H "$JSON" -d '{
  "question": "Berapa lama proses verifikasi sertifikat?",
  "answer": "Dua hari kerja setelah dokumen diunggah.",
  "enabled": true
}'

curl -s -X POST $BASE/chat -H "$AUTH" -H "$JSON" -d '{
  "question": "verifikasi sertifikat butuh waktu berapa lama ya?",
  "type": "staff", "actor": "staff@example.com"
}'
```

Hasil yang benar: `route: "faq"`, `reason: "faq_match"`, `answer` berisi isi FAQ
tadi, dan `sources[0].payload.source_id` = `SMOKE-1`.

Memori percakapan diuji dengan FAQ yang sama, lewat `history` (paling lama di
depan). Pertanyaannya dipilih supaya **tidak bisa** dijawab tanpa condense —
"berapa lama tadi?" sendirian tidak mengandung kata kunci apa pun untuk
retrieval:

```bash
curl -s -X POST $BASE/chat -H "$AUTH" -H "$JSON" -d '{
  "question": "berapa lama tadi?",
  "history": [
    {"role": "user", "content": "soal verifikasi sertifikat"},
    {"role": "assistant", "content": "Silakan, mau tanya apa soal verifikasi sertifikat?"}
  ],
  "type": "staff", "actor": "staff@example.com"
}'

curl -s -X DELETE $BASE/faq/SMOKE-1 -H "$AUTH"     # {"deleted":1}
```

Condense berhasil bila hasilnya sama dengan pertanyaan penuh di atas
(`route: "faq"`): step itu menulis ulang "berapa lama tadi?" menjadi pertanyaan
berdiri sendiri sebelum retrieval. `route: "fallback"` dengan `llm_calls: 0`
bukan berarti `history` tidak didukung — itu panggilan condense yang ditolak
provider; cek step 6 dulu sebelum menyalahkan flow.

### 6. Menyalahkan yang benar: panggil provider langsung

Bila step 3 atau 4 gagal, lewati service supaya error asli provider terlihat.
`openAiBaseURL` menambahkan `/v1` hanya pada URL **tanpa** path, jadi base URL
untuk `curl` disusun dengan aturan yang sama (`https://openrouter.ai/api/v1`
dipakai apa adanya, `https://api.example.com` menjadi `.../v1`):

```bash
# .env tidak di-source: FRAPPE_AUTH_TOKEN memuat spasi, dan `. ./.env` gagal di sana.
val() { grep -E "^$1=" .env | cut -d= -f2-; }
base() { case "${1%/}" in */v1) echo "${1%/}" ;; *) echo "${1%/}/v1" ;; esac; }

curl -s "$(base "$(val EMBEDDING_API_URL)")/embeddings" \
  -H "authorization: Bearer $(val EMBEDDING_API_KEY)" -H "$JSON" \
  -d "{\"model\":\"$(val EMBEDDING_MODEL)\",\"input\":[\"ping\"],\"encoding_format\":\"float\"}" \
  | head -c 300

curl -s "$(base "$(val OPENAI_API_URL)")/chat/completions" \
  -H "authorization: Bearer $(val OPENAI_API_KEY)" -H "$JSON" \
  -d "{\"model\":\"$(val OPENAI_MODEL)\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" \
  | head -c 300
```

Balasan yang benar diawali `{"object":"list","data":[{"object":"embedding"…` dan
`{"id":"…","object":"chat.completion"…`.

401/404 di sini berarti kredensial atau URL, bukan kode service. Kuota habis
muncul sebagai body 200 berisi error, mis.

```json
{
  "type": "error",
  "error": { "type": "FreeUsageLimitError", "message": "Rate limit exceeded." }
}
```

Itu penyebab paling sering dari `/chat` yang 200 tapi `llm_calls: 0`: embedding
tetap jalan (provider-nya beda), setiap panggilan LLM gagal, dan chat
didegradasi ke eskalasi admin.

### 7. Melihat langkahnya

Semua baris per-langkah ditulis di level `info`, jadi `LOG_LEVEL` default sudah
menampilkannya — `debug` tidak menambah apa pun di jalur chat. Yang dicari saat
menelusuri kegagalan:

| Baris log                                                 | Isinya                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `chat.condense` / `chat.triage` / `answer.compose`        | satu baris per langkah, dengan `ms`                                             |
| `stage: "<langkah>"`, `status: "error"`                   | panggilan LLM langkah itu gagal — inilah sebab `llm_calls` tidak bertambah      |
| `stage: "<langkah>"`, `status: "json_schema_unsupported"` | provider menolak Structured Outputs; diulang mode prompt-only (wajar di `auto`) |
| `chat.usage_total`                                        | token seluruh chat + `duration_ms`                                              |
| `chat.total`                                              | ringkasan per request: `route`, `tools_used`, jumlah `sources`                  |

`LOG_CHAT_REQUEST_BODY=true` menambahkan body request, termasuk pertanyaan asli
member: hanya untuk lokal, jangan di produksi.

</details>

## Konfigurasi

Semua variabel divalidasi Zod saat boot (`src/config.ts`); variabel wajib yang
kosong membuat proses gagal start, bukan gagal pada request pertama. Daftar
lengkap beserta default ada di [`.env.example`](.env.example).

Wajib: `QDRANT_URL`, `FRAPPE_URL`, `FRAPPE_AUTH_TOKEN`, `RETRIEVAL_API_KEY`,
`OPENAI_API_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `EMBEDDING_API_URL`,
`EMBEDDING_API_KEY`, `EMBEDDING_MODEL`.

Prioritas: `process.env` menang atas file `.env`.

Catatan yang mudah terlewat:

- `EMBEDDING_*` memakai endpoint **OpenAI-compatible** (mis. OpenRouter,
  `https://openrouter.ai/api/v1`) dan boleh berbeda dari `OPENAI_API_URL`. URL
  tanpa path otomatis diberi akhiran `/v1`.
- Mengganti `EMBEDDING_MODEL` ke model dengan dimensi berbeda akan ditolak saat
  upsert pertama dengan pesan eksplisit, bukan gagal diam-diam.
- `LOG_CHAT_REQUEST_BODY=true` mencatat pertanyaan asli member. Jangan aktif di
  produksi.
- `ASSISTANT_SCOPE` mendeskripsikan cakupan asisten dalam satu kalimat, mis.
  `"pertanyaan staff dan manager soal job, shift, dan jadwal"`. Dipakai step
  triage untuk memutuskan apakah pesan yang tidak menghasilkan retrieval itu
  sekadar percakapan (dijawab sendiri, `reason: "conversational"`) atau memang
  harus naik ke admin (`reason: "out_of_scope"` / `"no_faq_match"`). Boleh
  kosong — cakupan lalu disimpulkan dari katalog tool MCP dan kutipan FAQ,
  dengan hasil yang lebih mudah meleset.

## Keamanan

- Guard API key terpasang sebagai hook `onRequest` di instance root, sehingga
  route baru ikut terlindungi secara default. `test/security.test.ts` menahan
  regresi ini.
- Identitas end-user dibawa lewat body `actor` lalu diteruskan ke Frappe sebagai
  header `X-Alpha-Actor` — tidak pernah masuk ke argumen tool atau ke prompt,
  jadi prompt injection tidak punya jalur memalsukannya.
- Rate limit (`@fastify/rate-limit`) di-key per **end-user** (`actor`), jatuh ke
  alamat klien bila tidak ada. Alasannya: semua trafik chat datang dari satu
  server Frappe, jadi key berbasis alamat berarti satu bucket global di mana satu
  member menghabiskan kuota semua orang. Karena key-nya ada di body, limiter
  berjalan di hook `preValidation` — setelah body diparse, tetap sebelum
  handler.
- Store rate limit ada di dalam proses. Dengan N replica batas efektifnya
  `RATE_LIMIT_MAX * N`; untuk kuota lintas-replica pasang store Redis pada plugin
  atau pindahkan ke reverse proxy. Lihat juga batasan single-replica di
  [DESIGN.md §7](DESIGN.md#7-deployment).
- `TRUST_PROXY` default `false`. Aktifkan hanya di belakang proxy yang menulis
  ulang `X-Forwarded-For`: kalau tidak, klien bisa memalsukan bucket-nya sendiri.
- Jalur sinkronisasi FAQ (`/faq/*` kecuali `/faq/generate`) punya bucket sendiri,
  `FAQ_RATE_LIMIT_MAX`. Jalur itu tidak membawa `actor` dan dipanggil sekali per
  baris FAQ oleh doc_events Frappe, jadi impor massal tidak boleh menghabiskan
  kuota yang dipakai pertanyaan member — dan sebaliknya.
- Setiap `/chat` punya deadline menyeluruh (`CHAT_DEADLINE_MS`), disetel di bawah
  timeout caller (90 detik di Frappe). Timeout per-call tidak membatasi apa pun
  secara total: enam panggilan LLM berurutan yang masing-masing diretry melewati
  kesabaran caller mana pun.
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
├── plugins/
│   └── zod.ts             # validator compiler Zod + error handler global
├── routes/
│   ├── auth.ts            # guard API key + key rate limit
│   ├── health.ts          # /health, /health/live, /health/ready
│   ├── index.ts           # /index /search /answer /chat /query
│   └── faq.ts             # /faq/*
├── schemas/               # skema request/response Zod
│   ├── query.ts
│   └── faq.ts
├── chat/                  # alur /chat, dipecah per tanggung jawab
│   ├── orchestrator.ts    # urutan langkah + akuntansi + deadline
│   ├── tools.ts           # argumen tool, validasi rencana, eksekusi MCP
│   ├── triage.ts          # klasifikasi pesan saat retrieval kosong
│   ├── prompts.ts         # semua prompt + kontrak JSON schema
│   ├── parse.ts           # pembacaan defensif output model
│   └── log.ts             # ChatLog, timer bertahap, error tipikal
└── services/
    ├── llm.ts             # klien chat completions + negosiasi kapabilitas
    ├── embeddings.ts      # embedding OpenAI-compatible (batch)
    ├── qdrant.ts          # vector store, point ID deterministik
    ├── rag.ts             # fasad: index, search, answer, chat, generateFaq
    ├── faq-generate.ts    # draft FAQ dari transkrip
    ├── faq.ts             # siklus hidup FAQ + reindex
    ├── mcp.ts             # klien MCP JSON-RPC (paginasi, filter argumen)
    ├── dispatch.ts        # job /chat/async: semaphore, retry, drain
    └── frappe.ts          # transport HTTP Frappe
```

Prompt semuanya berkumpul di `chat/prompts.ts` supaya guard "data untrusted" dan
"jangan bocorkan ID mentah" tidak berbeda antar jalur — kalau berbeda, guard itu
tidak bernilai apa-apa.

Semua service diekspos lewat factory dan di-inject di `buildApp`, jadi test
menggantinya dengan fake tanpa menyentuh jaringan.
