// Only operational labels and numeric progress enter logs; never URLs or tokens.
export function logJob(jobId, message) {
  console.log(`${new Date().toISOString()} [job ${jobId}] ${message}`);
}

export function createRenderProgress(duration, report, now = Date.now, onProgress = () => {}) {
  let buffer = "", seconds = 0, speed = "?", last = -Infinity;
  return (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      const separator = line.indexOf("=");
      if (separator < 0) continue;
      const key = line.slice(0, separator), value = line.slice(separator + 1);
      if (key === "out_time_us" && Number.isFinite(Number(value))) seconds = Math.max(0, Number(value) / 1_000_000);
      if (key === "speed" && /^\d+(\.\d+)?x$/.test(value)) speed = value;
      if (key !== "progress") continue;
      const time = now();
      if (value !== "end" && time - last < 15_000) continue;
      last = time;
      const percent = value === "end" ? 100 : Math.min(99, Math.max(0, Math.floor(seconds / duration * 100)));
      report(`Renderizando: ${percent}% | ${Math.floor(seconds)}s de ${Math.ceil(duration)}s | velocidade ${speed}`);
      onProgress(percent);
    }
  };
}
