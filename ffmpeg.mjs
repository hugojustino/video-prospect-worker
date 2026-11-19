// Monta argumentos do FFmpeg a partir de parâmetros validados. Nunca usa shell.
const num = (v, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`Valor fora do intervalo: ${v}`);
  return n;
};
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const f = (n) => Number(n).toFixed(3);

export function buildFfmpegArgs({ basePath, imagePaths, template, outPath }) {
  const W = num(template.width, 16, 8192), H = num(template.height, 16, 8192), D = num(template.duration, 0.1, 7200);
  const slots = template.slots;
  if (!Array.isArray(slots) || slots.length !== imagePaths.length || slots.length < 1 || slots.length > 10) throw new Error("Slots inválidos");

  const args = ["-y", "-hide_banner", "-i", basePath];
  for (const p of imagePaths) args.push("-loop", "1", "-t", f(D), "-i", p);

  const chains = [];
  let last = "[0:v]";
  slots.forEach((s, k) => {
    const start = num(s.start, 0, D), end = num(s.end, start, D);
    const x = Math.round(num(s.x, 0, 1) * W), y = Math.round(num(s.y, 0, 1) * H);
    const w = even(num(s.w, 0.001, 1) * W), h = even(num(s.h, 0.001, 1) * H);
    const op = num(s.opacity, 0, 1), ed = num(s.effectDuration ?? 0, 0, 5);
    const fit = ["contain", "cover", "stretch"].includes(s.fit) ? s.fit : "contain";
    const parts = [];
    if (s.crop) {
      const c = { x: num(s.crop.x, 0, 1), y: num(s.crop.y, 0, 1), w: num(s.crop.w, 0.001, 1), h: num(s.crop.h, 0.001, 1) };
      parts.push(`crop=iw*${f(c.w)}:ih*${f(c.h)}:iw*${f(c.x)}:ih*${f(c.y)}`);
    }
    if (fit === "contain") parts.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease`, "format=rgba", `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
    else if (fit === "cover") parts.push(`scale=${w}:${h}:force_original_aspect_ratio=increase`, `crop=${w}:${h}`, "format=rgba");
    else parts.push(`scale=${w}:${h}`, "format=rgba");
    if (op < 1) parts.push(`colorchannelmixer=aa=${f(op)}`);
    if (s.effectIn === "fade" && ed > 0) parts.push(`fade=t=in:st=${f(start)}:d=${f(ed)}:alpha=1`);
    if (s.effectOut === "fade" && ed > 0) parts.push(`fade=t=out:st=${f(end - ed)}:d=${f(ed)}:alpha=1`);
    chains.push(`[${k + 1}:v]${parts.join(",")}[img${k}]`);
    const out = k === slots.length - 1 ? "[vout]" : `[v${k}]`;
    chains.push(`${last}[img${k}]overlay=${x}:${y}:enable='between(t,${f(start)},${f(end)})':eof_action=pass${out}`);
    last = out;
  });

  args.push(
    "-filter_complex", chains.join(";"),
    "-map", "[vout]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-t", f(D), "-movflags", "+faststart", outPath,
  );
  return args;
}
