// 引擎唯一的异步边界：SHA-256 走 WebCrypto（Worker 与 Node≥19 语义一致，
// 已在 Node v22.18.0 核实）。引擎其余部分保持同步纯函数，哈希在 finalize 段批量补齐。

export async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-256", data as unknown as ArrayBuffer);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}
