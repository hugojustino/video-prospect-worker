import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { buildFfmpegArgs } from "./ffmpeg.mjs";

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

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg saiu com código ${code}: ${err.slice(-800)}`))));
  });
}

async function uploadRender(jobId, file) {
  const { signed_url, path: p } = await app("render-upload-url", { job_id: jobId });
  const size = (await fsp.stat(file)).size;
  const res = await fetch(signed_url, { method: "PUT", headers: { "content-type": "video/mp4", "content-length": String(size), "x-upsert": "true" }, body: Readable.toWeb(fs.createReadStream(file)), duplex: "half" });
  if (!res.ok) throw new Error(`Upload do MP4 falhou [${res.status}]: ${(await res.text()).slice(0, 200)}`);
  return p;
}

async function ytToken() { return (await app("youtube-token")).access_token; }

async function youtubeUpload(jobId, file, tpl) {
  const size = (await fsp.stat(file)).size;
  const meta = {
    snippet: { title: tpl.title, description: tpl.description, categoryId: "22" },
    status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: !!tpl.made_for_kids, embeddable: true },
  };
  const init = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?qploadType=resumable&part=snippet,status&notifySubscribers=false", {
    method: "POST",
    headers: { authorization: `Bearer ${await ytToken()}` } });
    if (res.ok) {
      const item = (await res.json()).items?.[0];
      const st = item?.status ?? {};
      const summary = { uploadStatus: st.uploadStatus, privacyStatus: st.privacyStatus, rejectionReason: st.rejectionReason ?? null, failureReason: st.failureReason ?? null, processingStatus: item?.processingDetails?.processingStatus ?? null };
      if (["rejected", "failed", "deleted"].includes(st.uploadStatus)) return event(jobId, { type: "youtube_status", youtube_status: summary, rejected: true, message: `YouTube: ${st.uploadStatus} ${st.rejectionReason ?? st.failureReason ?? ""}`.trim() });
      if (st.uploadStatus === "processed") return event(jobId, { type: "youtube_status", youtube_status: summary, available: true });
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
    await sleep(r.retry_in_ms);
    r = await app("webhook", { job_id: jobId }).catch((e) => { console.error(e); return null; });
  }
}

async function processJob(jobId) {
  const spec = await app("job", { job_id: jobId });
  const { job, template } = spec;
  if (["finalizado", "video_disponivel", "enviando_crm", "aceito_crm"].includes(job.status)) return;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `vp-${jobId}-`));
  try {
    let videoId = job.youtube_video_id;
    if (!videoId) {
      if (job.upload_state !== "nao_iniciado") return event(jobId, { type: "error", upload_uncertain: true, message: "Upload anterior em estado incerto. Revisão manual necessária." });
      const out = path.join(dir, "out.mp4");
      if (job.render_path && spec.render_url) {
        await download(spec.render_url, out);
      } else {
        let attempt = 0;
        while (true) {
          attempt++;
          await event(jobId, { type: "status", status: "gerando", attempt });
          try {
            const base = path.join(dir, "base.mp4");
            await download(spec.base_video_url, base);
            const imgs = [];
            for (const im of spec.images) { const p = path.join(dir, `img${ mm.slot_index}`); await download(im.url, p); imgs[im.slot_index] = p; }
            await runFfmpeg(buildFfmpegArgs({ basePath: base, imagePaths: imgs, template, outPath: out }));
            break;
          } catch (e) {
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
        return event(jobId, { type: "error", upload_uncertain: !!e.uncertain, message: e.message });
      }
      await event(jobId, { type: "youtube_uploaded", video_id: videoId });
    }
    const r = await waitAvailable(jobId, videoId);
    if (r?.webhook?.retry_in_ms) scheduleWebhookRetry(jobId, r.webhook);
  } catch (e) {
    console.error(jobId, e);
    await event(jobId, { type: "error", message: String(e.message ?? e).slice(0, 1500) }).catch(() => {});
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// Fila em memória com controle de concorrência e sem duplicatas
const queue = []; const running = new Set();
function enqueue(id) {
  if (running.has(id) || queue.includes(id)) return;
  queue.push(id); pump();
}
function pump() {
  while (running.size < CONCURRENCY && queue.length) {
    const id = queue.shift(); running.add(id);
    processJob(id).finally(() => { running.delete(id); pump(); });
  }
}

http.createServer((eq, res) => {
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
}).listen(Number(process.env.PORT || 8080), () => console.log("Worker pronto"));
