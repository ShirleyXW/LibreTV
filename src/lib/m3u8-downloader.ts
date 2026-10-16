import { parseM3u8Playlist, type ParsedPlaylist } from './m3u8-parse';
import { StreamingTransmuxer } from './mp4-transmuxer';
import { PROXY_BASE, documentBaseURI, isProxiedUri } from './m3u8';

/**
 * 整集离线下载：
 * - 分片并发下载（默认 8），单分片 3 次重试，已下载分片写入 Cache Storage
 *   （`libretv-dl-v1` 桶）实现网络层断点——中断后续传不再耗流量；
 * - AES-128 解密用 WebCrypto AES-CBC（HLS 标准），不引入 CryptoJS；
 * - 输出：TS 直接顺序拼接；MP4 经 mux.js 流式转封装（边下边写，不聚整集）；
 * - 保存目标（FS Access / 内存）由调用方在用户手势内选好传入，本模块只管写。
 *
 * 文件层断点的现实约束：FS Access 句柄与内存 Blob 都活不过页面刷新，
 * 因此「断点续传」指网络层——刷新后重试同一任务会跳过已下载的分片，
 * 但需要用户重新选择保存位置。
 */

const DL_CACHE_NAME = 'libretv-dl-v1';
const SEGMENT_TIMEOUT_MS = 20_000;
const MAX_SEGMENT_RETRIES = 3;

export class PauseResumeController {
  private paused = false;
  private waiters: Array<() => void> = [];

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w();
  }

  getPaused(): boolean {
    return this.paused;
  }

  async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  destroy(): void {
    this.resume();
  }
}

export interface DownloadProgress {
  current: number;
  total: number;
  percentage: number;
  status: 'downloading' | 'processing' | 'done' | 'error';
  message?: string;
}

/**
 * 分片缓存 key。Cache Storage 的 put/match 只接受 http(s) scheme——
 * 自定义字符串（如 `libretv-dl-v1:dl:...`）会被 URL 解析成同名自定义协议，
 * put 直接抛 "Request scheme ... is unsupported"。因此用一段不会被真实
 * 请求的保留域名构造合法 URL，仅作缓存 key 使用；taskId 经编码避免歧义。
 */
const DL_CHUNK_ORIGIN = 'https://dl.libretv.local';

function dlChunkKey(taskId: string, index: number): string {
  return `${DL_CHUNK_ORIGIN}/${encodeURIComponent(taskId)}/${index}`;
}

export async function clearDownloadChunks(taskId: string): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const cache = await caches.open(DL_CACHE_NAME);
    const keys = await cache.keys();
    const prefix = `${DL_CHUNK_ORIGIN}/${encodeURIComponent(taskId)}/`;
    await Promise.all(keys.filter((r) => r.url.startsWith(prefix)).map((r) => cache.delete(r)));
  } catch { /* 忽略 */ }
}

function isProxyResourceUrl(url: string): boolean {
  if (isProxiedUri(url)) return true;
  const base = documentBaseURI();
  if (!base) return false;
  try {
    const absolute = new URL(url, base);
    const documentUrl = new URL(base);
    return (
      absolute.origin === documentUrl.origin &&
      isProxiedUri(`${absolute.pathname}${absolute.search}`)
    );
  } catch {
    return false;
  }
}

function proxyUrl(url: string): string {
  return isProxyResourceUrl(url) ? url : `${PROXY_BASE}${encodeURIComponent(url)}`;
}

/**
 * 浏览器直连失败（CORS / 防盗链 / 403 / 混合内容）时改走本站同源代理。
 * 播放器已有同样的 fallback；下载器必须复用，否则会出现“能播不能下”。
 */
async function fetchArrayBufferWithProxyFallback(
  url: string,
  signal: AbortSignal,
  timeoutMs = SEGMENT_TIMEOUT_MS
): Promise<ArrayBuffer> {
  const candidates = isProxyResourceUrl(url) ? [url] : [url, proxyUrl(url)];
  let lastErr: unknown;
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, {
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]),
        headers: { Accept: '*/*' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.arrayBuffer();
      if (data.byteLength === 0) throw new Error('响应为空');
      return data;
    } catch (err) {
      lastErr = err;
      if (signal.aborted) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('资源拉取失败');
}

async function fetchSegment(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  try {
    return await fetchArrayBufferWithProxyFallback(url, signal);
  } catch (err) {
    throw new Error(`分片拉取失败：${err instanceof Error ? err.message : '未知错误'}`);
  }
}

/**
 * HLS AES-128 分片解密（AES-CBC / PKCS7）。
 * IV 规则（RFC 8216 §4.3.2.4）：KEY 带IV 属性时全部分片共用；**无 IV 属性时
 * IV = 分片的媒体序列号（16 字节大端）**，逐分片递增——恒用零向量会导致
 * 首片恰好正确、后续全部解密失败。
 */
function ivForSegment(mediaSequence: number, segmentIndexZeroBased: number): Uint8Array {
  const seq = BigInt(mediaSequence + segmentIndexZeroBased);
  const iv = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    iv[15 - i] = Number((seq >> BigInt(8 * i)) & 0xffn);
  }
  return iv;
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.padStart(32, '0').slice(0, 32).match(/.{2}/g)!.map((h) => parseInt(h, 16)));
}

export async function decryptSegment(
  data: ArrayBuffer,
  key: BufferSource,
  ivHex: string | undefined,
  mediaSequence: number,
  segmentIndexZeroBased: number
): Promise<ArrayBuffer> {
  const iv = ivHex ? hexToBytes(ivHex) : ivForSegment(mediaSequence, segmentIndexZeroBased);
  const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['decrypt']);
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv as BufferSource }, cryptoKey, data);
}

export interface DownloadJobOptions {
  taskId: string;
  url: string;
  title: string;
  format: 'TS' | 'MP4';
  concurrency?: number;
  signal: AbortSignal;
  pause: PauseResumeController;
  onProgress: (p: DownloadProgress) => void;
  /** 在用户手势内选好的保存目标 */
  target: import('./download-saver').SaveTarget;
}

/**
 * 执行一次整集下载。调用方（DownloadManager）负责：
 * 在用户手势内 pickSaveTarget、构造 AbortSignal/PauseResumeController、
 * 更新 Dexie 任务状态；本函数只负责解析 → 并发下载 → 顺序写出。
 */
export async function runDownloadJob(opts: DownloadJobOptions): Promise<void> {
  const { taskId, url, format, signal, pause, onProgress, target } = opts;
  const concurrency = Math.min(Math.max(opts.concurrency ?? 8, 1), 16);

  const report = (current: number, total: number, status: DownloadProgress['status'], message?: string) => {
    onProgress({
      current,
      total,
      percentage: total > 0 ? Math.round((current / total) * 100) : 0,
      status,
      message,
    });
  };

  // —— 解析：先直连，失败后与播放器一样改走 /api/proxy ——
  let parsed: ParsedPlaylist;
  let lastErr: unknown;
  const playlistCandidates = isProxyResourceUrl(url) ? [url] : [url, proxyUrl(url)];
  for (const candidate of playlistCandidates) {
    try {
      parsed = await parseM3u8Playlist(candidate, 0, undefined, { stripLeadAd: true });
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      if (signal.aborted) throw err;
    }
  }
  if (lastErr || !parsed!) {
    throw new Error(`播放列表解析失败：${lastErr instanceof Error ? lastErr.message : '未知错误'}`);
  }
  if (parsed.byterange) throw new Error('该集使用 BYTERANGE 分片，暂不支持下载');
  if (parsed.aesConfigChanged) {
    throw new Error('该集在播放过程中切换了 HLS 加密配置/密钥，当前下载器暂不支持安全解密');
  }
  if (parsed.initMapChanged) {
    throw new Error('该集在播放过程中切换了 EXT-X-MAP 初始化段，当前下载器暂不支持合并为单个 MP4');
  }
  const looksLikeFmp4 = !!parsed.initMap || parsed.segments.some((s) => /\.m4s(?:$|[?#])/i.test(s.url));
  if (looksLikeFmp4 && !parsed.initMap) {
    throw new Error('检测到 fMP4/m4s 分片，但播放列表缺少 EXT-X-MAP 初始化段，无法生成有效 MP4');
  }
  if (looksLikeFmp4 && format === 'TS') {
    throw new Error('该集使用 fMP4/m4s 分片，不能导出为 TS，请选择 MP4');
  }
  // EXT-X-MAP 的加密状态取决于 MAP 声明当时生效的 KEY；当前 ParsedPlaylist 只保留
  // media playlist 的单一 AES 配置，无法可靠判断 init map 是否需要解密。与其产出损坏 MP4，
  // 对加密 fMP4 明确拒绝；后续若要支持，应把 KEY 状态按 segment/MAP 逐项建模。
  if (looksLikeFmp4 && parsed.aesConf) {
    throw new Error('该集使用加密 fMP4（EXT-X-MAP + AES），当前下载器暂不支持安全合成');
  }
  if (parsed.aesConf && parsed.aesConf.method !== 'AES-128') {
    throw new Error(`暂不支持 HLS 加密方式：${parsed.aesConf.method}`);
  }

  const total = parsed.segments.length;
  report(0, total, 'downloading');

  // —— AES key 预取 ——
  let aesKey: ArrayBuffer | undefined;
  if (parsed.aesConf) {
    try {
      aesKey = await fetchArrayBufferWithProxyFallback(parsed.aesConf.uri, signal);
      if (aesKey.byteLength !== 16) {
        throw new Error(`AES-128 密钥长度异常：${aesKey.byteLength} 字节（应为 16）`);
      }
    } catch (err) {
      throw new Error(`解密密钥加载失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  }

  // —— 并发下载分片（Cache Storage 断点） ——
  const cache = await caches.open(DL_CACHE_NAME);
  const chunkKey = (index: number) => dlChunkKey(taskId, index);
  let cursor = 0;
  // 恢复：统计已有分片数作为起点
  let current = 0;
  for (let i = 1; i <= total; i++) {
    if (await cache.match(new Request(chunkKey(i)))) current += 1;
  }
  report(current, total, 'downloading');

  let workerError: Error | undefined;
  const worker = async (): Promise<void> => {
    try {
      while (cursor < total && !workerError) {
        if (signal.aborted) return;
        await pause.waitIfPaused();
        if (workerError) return;
        const index = ++cursor; // 1 基
        if (signal.aborted) return;
        await pause.waitIfPaused();
        if (workerError) return;
        const cached = await cache.match(new Request(chunkKey(index)));
        if (cached) {
          // 已在恢复预统计里计入，不再累加——否则续传时进度重复计数超过 100%
          continue;
        }
        const seg = parsed.segments[index - 1];
        let buffer: ArrayBuffer | undefined;
        for (let retry = 0; retry < MAX_SEGMENT_RETRIES; retry++) {
          if (signal.aborted || workerError) return;
          try {
            buffer = await fetchSegment(seg.url, signal);
            break;
          } catch {
            if (signal.aborted || workerError) return;
            await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
          }
        }
        if (!buffer) {
          throw new Error(`分片 ${index} 下载失败（已重试 ${MAX_SEGMENT_RETRIES} 次）`);
        }
        await cache.put(
          new Request(chunkKey(index)),
          new Response(buffer.slice(0), { headers: { 'Content-Type': 'video/mp2t' } })
        );
        current += 1;
        report(current, total, 'downloading');
      }
    } catch (err) {
      // Promise.all 会等待所有 worker 收尾，避免某个 worker 先 reject 后其他 worker 仍在后台继续拉分片。
      workerError = err instanceof Error ? err : new Error(String(err));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (signal.aborted) return;
  if (workerError) throw workerError;

  // —— 顺序写出（转封装 / 拼接） ——
  report(total, total, 'processing');
  if (format === 'MP4') {
    if (parsed.initMap) {
      // fMP4 HLS：EXT-X-MAP 本身就是 MP4 初始化段，后续 .m4s 是 moof/mdat。
      // 不能交给 mux.js 的 TS Transmuxer；按 init + media fragments 顺序直接写出即可。
      const initData = await fetchArrayBufferWithProxyFallback(parsed.initMap.url, signal);
      await target.write(new Uint8Array(initData));
      for (let i = 1; i <= total; i++) {
        if (signal.aborted) return;
        await pause.waitIfPaused();
        const resp = await cache.match(new Request(chunkKey(i)));
        if (!resp) throw new Error(`分片 ${i} 缓存丢失，请重试`);
        let data = await resp.arrayBuffer();
        if (aesKey && parsed.aesConf) {
          data = await decryptSegment(data, aesKey, parsed.aesConf.iv, parsed.mediaSequence, i - 1);
        }
        await target.write(new Uint8Array(data));
      }
      await target.close();
    } else {
      // MPEG-TS HLS：用 mux.js 流式转封装为 fMP4。
      // 传入整集时长：mux.js 恒把 moov 时长写成 0xFFFFFFFF（timescale 90000
      // → 播放器显示 13:15:21），必须在写出 initSegment 前回填真实值
      const transmuxer = new StreamingTransmuxer(target, { durationSeconds: parsed.totalDuration });
      for (let i = 1; i <= total; i++) {
        if (signal.aborted) return;
        await pause.waitIfPaused();
        const resp = await cache.match(new Request(chunkKey(i)));
        if (!resp) throw new Error(`分片 ${i} 缓存丢失，请重试`);
        let data = await resp.arrayBuffer();
        if (aesKey && parsed.aesConf) {
          try {
            data = await decryptSegment(data, aesKey, parsed.aesConf.iv, parsed.mediaSequence, i - 1);
          } catch (err) {
            throw new Error(`分片 ${i} AES 解密失败：${err instanceof Error ? err.message : '未知错误'}`);
          }
        }
        try {
          await transmuxer.pushAndTransmux(new Uint8Array(data));
        } catch (err) {
          throw new Error(`分片 ${i} MP4 转封装失败：${err instanceof Error ? err.message : '未知错误'}`);
        }
      }
      await transmuxer.finish();
    }
  } else {
    for (let i = 1; i <= total; i++) {
      if (signal.aborted) return;
      await pause.waitIfPaused();
      const resp = await cache.match(new Request(chunkKey(i)));
      if (!resp) throw new Error(`分片 ${i} 缓存丢失，请重试`);
      let data = await resp.arrayBuffer();
      if (aesKey && parsed.aesConf) {
        try {
          data = await decryptSegment(data, aesKey, parsed.aesConf.iv, parsed.mediaSequence, i - 1);
        } catch (err) {
          throw new Error(`分片 ${i} AES 解密失败：${err instanceof Error ? err.message : '未知错误'}`);
        }
      }
      await target.write(new Uint8Array(data));
    }
    await target.close();
  }
  report(total, total, 'done');
}
