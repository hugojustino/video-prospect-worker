import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { buildFfmpegArgs } from "./ffmpeg.mjs";
import { createRenderProgress, logJob } from "./progress.mjs";

const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const SECRET = process.env.WORKER_SHARED_SECRET || "";
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 1);
const MAX_RENDER_ATTEMPTS = 3;
if (!APP_URL || !SECRET) { console.error("Defina APP_URL e WORKER_SHARED_SECRET"); process.exit(1); }

const sign = (body) => {
  const ts = Math.floor(Date.now() / 1000).toString();
  return { "x-vp-timestamp": ts, "x-vp-signature": crypto.createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex") };
};
const verify = (req, body) => {
  const ts = req.headers["x-vp-timestamp"] || "", sig = req.headers["x-vp-signature"] || "";
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const exp = crypto.createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
  return sig.length === exp.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp));
};

async function app(action, payload) {
  const body = JSON.stringify(payload ?? {});
  const res = await fetch(`${APP_URL}/api/public/worker/${action}`, { method: "POST", headers: { "content-type": "application/json", ...sign(body) }, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`App ${action} [${res.status}]: ${json.error ?? ""}`);
  return json;
}
const event = (job_id, data) => app("event", { job_id, ...data });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download falhou [${res.status}]`);
  await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

function runFfmpeg(args, jobId, duration) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-progress", "pipe:1", "-nostats", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", createRenderProgress(duration, (message) => logJob(jobId, message)));
    let err = "";
    p.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg saiu com código ${code}: ${err.slice(-800)}`))));
  });
}

async function uploadRender(jobId, file) {
  logJob(jobId, "Salvando MP4 no aplicativo");
  const { signed_url, path: p } = await app("render-upload-url", { job_id: jobId });
  const size = (await fsp.stat(file)).size;
  const res = await fetch(signed_url, { method: "PUT", headers: { "content-type": "video/mp4", "content-length": String(size), "x-upsert": "true" }, body: Readable.toWeb(fs.createReadStream(file)), duplex: "half" });
  if (!res.ok) throw new Error(`Upload do MP4 falhou [${res.status}]: ${(await res.text()).slice(0, 200)}`);
  logJob(jobId, "MP4 salvo");
  return p;
}

async function ytToken() { return (await app("youtube-token")).access_token; }

async function youtubeUpload(jobId, file, tpl) {
  logJob(jobId, "Iniciando envio ao YouTube");
  const size = (await fsp.stat(file)).size;
  const meta = {
    snippet: { title: tpl.title, description: tpl.description, categoryId: "22" },
    status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: !!tpl.made_for_kids, embeddable: true },
  };
  const init = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=false", {
    method: "POST",
    headers: { authorization: `Bearer ${await ytToken()}`, "content-type": "application/json; charset=UTF-8", "x-upload-content-length": String(size), "x-upload-content-type": "video/mp4" },
    body: JSON.stringify(meta),
  });
  if (!init.ok) {
    const t = await init.text();
    if (t.includes("uploadLimitExceeded") || t.includes("quotaExceeded")) throw Object.assign(new Error("Quota diária do YouTube excedida. Tente novamente amanhã."), { noRetry: true });
    throw Object.assign(new Error(`YouTube recusou o início do upload [${init.status}]: ${t.slice(0, 300)}`), { noRetry: true });
  }
  const session = init.headers.get("location");
  await event(jobId, { type: "youtube_session" }); // a partir daqui, nunca reiniciar upload automaticamente
  logJob(jobId, "Sessão do YouTube criada; envio em andamento");

  const CHUNK = 8 * 1024 * 1024;
  const fd = await fsp.open(file, "r");
  let offset = 0, failures = 0;
  try {
    while (true) {
      const len = Math.min(CHUNK, size - offset);
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, offset);
      let res;
      try {
        res = await fetch(session, { method: "PUT", headers: { authorization: `Bearer ${await ytToken()}`, "content-length": String(len), "content-range": `bytes ${offset}-${offset + len - 1}/${size}` }, body: buf });
      } catch (e) { res = null; }
      if (res && (res.status === 200 || res.status === 201)) { logJob(jobId, "Envio ao YouTube: 100%"); return (await res.json()).id; }
      if (res && res.status === 308) { const r = res.headers.get("range"); offset = r ? Number(r.split("-")[1]) + 1 : 0; failures = 0; logJob(jobId, `Envio ao YouTube: ${Math.min(99, Math.floor(offset / size * 100))}%`); continue; }
      if (res && res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw Object.assign(new Error(`Upload YouTube falhou [${res.status}]: ${(await res.text()).slice(0, 300)}`), { uncertain: true });
      if (++failures > 6) throw Object.assign(new Error("Upload ao YouTube interrompido após várias tentativas."), { uncertain: true });
      logJob(jobId, `Envio interrompido; consultando a mesma sessão (tentativa ${failures})`);
      await sleep(2000 * 2 ** failures);
      // consulta o estado da sessão para retomar do ponto certo
      const q = await fetch(session, { method: "PUT", headers: { authorization: `Bearer ${await ytToken()}`, "content-length": "0", "content-range": `bytes */${size}` } }).catch(() => null);
      if (q && (q.status === 200 || q.status === 201)) return (await q.json()).id;
      if (q && q.status === 308) { const r = q.headers.get("range"); offset = r ? Number(r.split("-")[1]) + 1 : 0; }
    }
  } finally { await fd.close(); }
}

async function waitAvailable(jobId, videoId) {
  logJob(jobId, "Aguardando processamento do YouTube");
  let delay = 15000;
  const deadline = Date.now() + 90 * 60_000;
  while (Date.now() < deadline) {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=${videoId}`, { headers: { authorization: `Bearer ${await ytToken()}` } });
    if (res.ok) {
      const item = (await res.json()).items?.[0];
      const st = item?.status ?? {};
      const knownStatus = ["uploaded", "processed", "rejected", "failed", "deleted"].includes(st.uploadStatus) ? st.uploadStatus : "pendente";
      logJob(jobId, `Processamento do YouTube: ${knownStatus}`);
      const summary = { uploadStatus: st.uploadStatus, privacyStatus: st.privacyStatus, rejectionReason: st.rejectionReason ?? null, failureReason: st.failureReason ?? null, processingStatus: item?.processingDetails?.processingStatus ?? null };
      if (["rejected", "failed", "deleted"].includes(st.uploadStatus)) return event(jobId, { type: "youtube_status", youtube_status: summary, rejected: true, message: `YouTube: ${st.uploadStatus} ${st.rejectionReason ?? st.failureReason ?? ""}`.trim() });
      if (st.uploadStatus === "processed") { logJob(jobId, "Vídeo disponível; notificando DataCrazy"); return event(jobId, { type: "youtube_status", youtube_status: summary, available: true }); }
      await event(jobId, { type: "youtube_status", youtube_status: summary });
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 5 * 60_000);
  }
  throw new Error("Tempo esgotado aguardando o processamento do YouTube.");
}

async function scheduleWebhookRetry(jobId, result) {
  let r = result;
  while (r && r.retry_in_ms) {
    logJob(jobId, `Nova tentativa de notificação ao DataCrazy em ${Math.ceil(r.retry_in_ms / 1000)}s`);
    await sleep(r.retry_in_ms);
    r = await app("webhook", { job_id: jobId }).catch(() => { logJob(jobId, "Falha ao notificar DataCrazy; consulte o erro no aplicativo"); return null; });
  }
}

async function processJob(jobId) {
  logJob(jobId, "Carregando tarefa");
  const spec = await app("job", { job_id: jobId });
  const { job, template } = spec;
  if (["finalizado", "video_disponivel", "enviando_crm", "aceito_crm"].includes(job.status)) { logJob(jobId, "Tarefa já concluída; ignorada"); return; }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `vp-${jobId}-`));
  try {
    let videoId = job.youtube_video_id;
    if (!videoId) {
      if (job.upload_state !== "nao_iniciado") return event(jobId, { type: "error", upload_uncertain: true, message: "Upload anterior em estado incerto. Revisão manual necessária." });
      const out = path.join(dir, "out.mp4");
      if (job.render_path && spec.render_url) {
        logJob(jobId, "Baixando MP4 já gerado para reaproveitar");
        await download(spec.render_url, out); // reaproveita MP4 já renderizado
      } else {
        let attempt = 0;
        while (true) {
          attempt++;
          logJob(jobId, `Geração: tentativa ${attempt}/${MAX_RENDER_ATTEMPTS}`);
          await event(jobId, { type: "status", status: "gerando", attempt });
          try {
            const base = path.join(dir, "base.mp4");
            logJob(jobId, "Baixando vídeo base");
            await download(spec.base_video_url, base);
            logJob(jobId, "Vídeo base baixado; baixando imagens");
            const imgs = [];
            for (const im of spec.images) { const p = path.join(dir, `img${im.slot_index}`); await download(im.url, p); imgs[im.slot_index] = p; }
            logJob(jobId, "Imagens baixadas; iniciando renderização");
            await runFfmpeg(buildFfmpegArgs({ basePath: base, imagePaths: imgs, template, outPath: out }), jobId, template.duration);
            logJob(jobId, "Renderização concluída");
            break;
          } catch (e) {
            logJob(jobId, `Falha na geração (tentativa ${attempt}); ${attempt >= MAX_RENDER_ATTEMPTS ? "consulte o erro no aplicativo" : "preparando nova tentativa"}`);
            if (attempt >= MAX_RENDER_ATTEMPTS) throw e;
            await sleep(5000 * attempt);
          }
        }
        const p = await uploadRender(jobId, out);
        await event(jobId, { type: "render_uploaded", render_path: p });
      }
      await event(jobId, { type: "status", status: "enviando_youtube" });
      try {
        videoId = await youtubeUpload(jobId, out, template);
      } catch (e) {
        logJob(jobId, "Falha no envio ao YouTube; consulte o erro no aplicativo");
        return event(jobId, { type: "error", upload_uncertain: !!e.uncertain, message: e.message });
      }
      await event(jobId, { type: "youtube_uploaded", video_id: videoId });
    }
    const r = await waitAvailable(jobId, videoId);
    logJob(jobId, "Consulta do YouTube concluída; resposta de notificação recebida");
    if (r?.webhook?.retry_in_ms) scheduleWebhookRetry(jobId, r.webhook);
  } catch (e) {
    logJob(jobId, "Tarefa interrompida por erro; consulte os detalhes no aplicativo");
    await event(jobId, { type: "error", message: String(e.message ?? e).slice(0, 1500) }).catch(() => {});
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
    logJob(jobId, "Arquivos temporários removidos");
  }
}

// Fila em memória com controle de concorrência e sem duplicatas
const queue = []; const running = new Set();
function enqueue(id) {
  if (running.has(id) || queue.includes(id)) { logJob(id, "Tarefa já está na fila ou em execução; pedido duplicado ignorado"); return; }
  logJob(id, `Tarefa recebida; ${queue.length} na fila e ${running.size} em execução`);
  queue.push(id); pump();
}
function pump() {
  while (running.size < CONCURRENCY && queue.length) {
    const id = queue.shift(); running.add(id);
    processJob(id).catch(() => logJob(id, "Falha ao carregar tarefa; consulte a conexão com o aplicativo")).finally(() => { running.delete(id); logJob(id, "Processamento encerrado; liberando fila"); pump(); });
  }
}

http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") { res.writeHead(200).end("ok"); return; }
  if (req.method !== "POST" || req.url !== "/jobs") { res.writeHead(404).end(); return; }
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 10_000) req.destroy(); });
  req.on("end", () => {
    if (!verify(req, body)) { res.writeHead(401).end("assinatura inválida"); return; }
    let id;
    try { id = JSON.parse(body).job_id; } catch {}
    if (!/^[0-9a-f-]{36}$/i.test(id || "")) { res.writeHead(400).end("job_id inválido"); return; }
    enqueue(id);
    res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ queued: true }));
  });
}).listen(Number(process.env.PORT || 8080), () => console.log(`${new Date().toISOString()} Worker pronto — logs de progresso ativos; concorrência ${CONCURRENCY}`));
