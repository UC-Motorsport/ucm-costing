import { resolveStoredDataPath, type AppPaths } from "../config";
import { openVerifiedFile } from "../integrity/file-integrity";
import { rasterizePdfPage } from "../report/pdf-rasterizer";
import type { EvidenceRow } from "./evidence-service";

const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const thumbnails = new Map<string, Uint8Array>();
const pending = new Map<string, Promise<Uint8Array>>();
let cacheBytes = 0;
let activeConversions = 0;
const conversionWaiters: Array<() => void> = [];

async function acquireConversionSlot() {
  if (activeConversions < 2) {
    activeConversions += 1;
    return;
  }
  await new Promise<void>((resolve) => conversionWaiters.push(resolve));
}

function releaseConversionSlot() {
  const next = conversionWaiters.shift();
  if (next) next();
  else activeConversions -= 1;
}

// Call only after authorizing access to the evidence. Verify the current source
// even on a cache hit so missing or corrupted files cannot be hidden by a preview.
export async function evidenceThumbnail(
  evidence: EvidenceRow,
  paths: AppPaths,
) {
  if (evidence.mime_type !== "application/pdf")
    throw new Error("evidence-file-type-unsupported");
  const verified = await openVerifiedFile(
    resolveStoredDataPath(evidence.storage_path, paths),
    evidence.content_sha256,
  );
  try {
    if (
      evidence.byte_size !== null &&
      verified.stats.size !== Number(evidence.byte_size)
    ) {
      throw new Error("stored-file-byte-size-mismatch");
    }
    const key = verified.sha256;
    const cached = thumbnails.get(key);
    if (cached) return cached;
    const running = pending.get(key);
    if (running) return await running;
    if (pending.size >= 32) throw new Error("evidence-thumbnail-busy");
    const render = (async () => {
      await acquireConversionSlot();
      try {
        const bytes = Buffer.alloc(verified.stats.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await verified.handle.read(
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
          if (read.bytesRead === 0)
            throw new Error("stored-file-byte-size-mismatch");
          offset += read.bytesRead;
        }
        const png = await rasterizePdfPage(bytes, 0, 800);
        if (png.byteLength <= MAX_CACHE_BYTES) {
          while (cacheBytes + png.byteLength > MAX_CACHE_BYTES) {
            const oldest = thumbnails.keys().next().value!;
            cacheBytes -= thumbnails.get(oldest)!.byteLength;
            thumbnails.delete(oldest);
          }
          thumbnails.set(key, png);
          cacheBytes += png.byteLength;
        }
        return png;
      } finally {
        releaseConversionSlot();
      }
    })();
    pending.set(key, render);
    try {
      return await render;
    } finally {
      pending.delete(key);
    }
  } finally {
    await verified.handle.close();
  }
}
