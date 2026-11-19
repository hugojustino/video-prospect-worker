// Modo PC: inicia o worker, abre um túnel Cloudflare gratuito e avisa o aplicativo do endereço (assinado com HMAC).
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const SECRET = process.env.WORKER_SHARED_SECRET || "";
const PORT = Number(process.env.PORT || 8080);
const BIN = process.env.CLOUDFLARED || "cloudflared";
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

export function findTunnelUrl(text) {
  const m = String(text).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  return m ? m[0] : null;
}

let current = null;
async function register() {
  if (!current) return;
  const body = JSON.stringify({ url: current });
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
  try {
    const res = await fetch(`${APP_URL}/api/public/worker/register-url`, { method: "POST", headers: { "content-type": "application/json", "x-vp-timestamp": ts, "x-vp-signature": sig }, body });
    log(res.ok ? "Endereço registrado no aplicativo" : `Falha ao registrar endereço [${res.status}]`);
  } catch { log("Falha ao registrar endereço; nova tentativa em 1 min"); }
}

function launch() {
  const p = spawn(BIN, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
  const onData = (d) => { const u = findTunnelUrl(d); if (u && u !== current) { current = u; log("Túnel ativo"); register(); } };
  p.stdout.on("data", onData); p.stderr.on("data", onData);
  p.on("error", () => log("Não foi possível abrir o túnel"));
  p.on("close", () => { log("Túnel caiu; reabrindo em 10s"); current = null; setTimeout(launch, 10000); });
}

if (process.argv[1]?.endsWith("tunnel.mjs")) {
  await import("./index.mjs");
  launch();
  setInterval(register, 60000);
}
