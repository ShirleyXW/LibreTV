'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Drawer } from './drawer';
import { Icon } from './icon';
import { useToast } from './toast';
import { db, type DownloadTaskEntry } from '@/lib/db';
import {
  PauseResumeController,
  clearDownloadChunks,
  runDownloadJob,
  type DownloadProgress,
} from '@/lib/m3u8-downloader';
import { detectSavingCapability, pickSaveTarget, type SaveTarget } from '@/lib/download-saver';

/**
 * 全局下载管理器（UI 采用本站 Drawer 模式）：
 * - 入口：header 下载图标 + 播放页「下载本集」（均派发 window 事件）；
 * - 并发：全局最多同时进行 3 个任务，其余排队（waiting）；
 * - 断点：已下载分片写入 Cache Storage（网络层断点）；
 *   保存目标（FS Access / 内存）活不过页面刷新，恢复时由用户点击「继续」重新选择。
 */

const MAX_CONCURRENT_DOWNLOADS = 3;
const ADD_TASK_EVENT = 'libretv:add-download';
const SHOW_MANAGER_EVENT = 'libretv:show-download-manager';
export const DOWNLOADS_UPDATED_EVENT = 'libretv:downloads-updated';

export interface AddDownloadPayload {
  url: string;
  title: string;
  format?: 'TS' | 'MP4';
}

/** 运行中的任务句柄（不进持久化） */
interface RunningHandle {
  abort: AbortController;
  pause: PauseResumeController;
  /** 当前执行阶段；暂停后恢复时用于还原正确 UI 状态 */
  phase: 'downloading' | 'processing';
  /** 当前任务独占的保存目标；不能用单一全局变量，否则并发任务会互相覆盖 */
  target: SaveTarget;
}

export function DownloadManager({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [tasks, setTasks] = useState<DownloadTaskEntry[]>([]);
  const [capability, setCapability] = useState<'fs-access' | 'memory'>('memory');
  const running = useRef(new Map<string, RunningHandle>());
  /** 尚未启动任务的保存目标。页面刷新后此 Map 会清空，用户需点击“继续”重选。 */
  const pendingTargets = useRef(new Map<string, SaveTarget>());

  const refresh = useCallback(() => {
    void db.downloads.orderBy('createdAt').reverse().toArray().then(setTasks);
  }, []);

  const updateEntry = useCallback(async (id: string, patch: Partial<DownloadTaskEntry>) => {
    await db.downloads.update(id, { ...patch, updatedAt: Date.now() });
    refresh();
  }, [refresh]);

  // —— 任务启动：选目标 → runDownloadJob ——
  const startTask = useCallback(
    async (entry: DownloadTaskEntry) => {
      if (running.current.has(entry.id)) return;
      const target = pendingTargets.current.get(entry.id);
      // 页面刷新后持久化任务仍在，但 FileSystemAccess/内存 target 无法持久化。
      // 没有 target 时保持等待，必须由用户点击“继续”在手势内重新选择。
      if (!target) return;
      pendingTargets.current.delete(entry.id);
      const abort = new AbortController();
      const pause = new PauseResumeController();
      running.current.set(entry.id, { abort, pause, phase: 'downloading', target });
      await updateEntry(entry.id, { status: 'downloading' });

      const onProgress = (p: DownloadProgress) => {
        const handle = running.current.get(entry.id);
        if (handle && (p.status === 'downloading' || p.status === 'processing')) {
          handle.phase = p.status;
        }
        void updateEntry(entry.id, {
          finished: p.current,
          total: p.total,
          status: p.status === 'done' ? 'completed' : p.status === 'error' ? 'error' : p.status === 'processing' ? 'processing' : 'downloading',
        });
      };

      const job = runDownloadJob({
        taskId: entry.id,
        url: entry.url,
        title: entry.title,
        format: entry.format,
        signal: abort.signal,
        pause,
        onProgress,
        target,
      });

      void job
        .then(async () => {
          // runDownloadJob 在 signal.aborted 时会提前 return；取消任务不能因此被误报“完成”。
          if (abort.signal.aborted) return;
          await updateEntry(entry.id, { status: 'completed' });
          void clearDownloadChunks(entry.id);
          toast(`《${entry.title}》下载完成`, 'success');
        })
        .catch(async (err: Error) => {
          if (abort.signal.aborted) return; // 用户取消：状态已在取消处理里写好
          try {
            await target.abort();
          } catch { /* 保存目标可能已经关闭，忽略 */ }
          await updateEntry(entry.id, { status: 'error' });
          toast(`《${entry.title}》下载失败：${err.message}`, 'error');
        })
        .finally(() => {
          running.current.delete(entry.id);
          scheduleNext();
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast, updateEntry]
  );

  // —— 全局并发调度 ——
  const scheduleNext = useCallback(() => {
    void (async () => {
      const runningCount = running.current.size;
      if (runningCount >= MAX_CONCURRENT_DOWNLOADS) return;
      const all = await db.downloads.orderBy('createdAt').toArray();
      // 只有本页内已经拿到保存目标的 waiting 任务才能自动启动。
      // 刷新后遗留的 waiting 任务没有 target，必须等用户点“继续”重新选择。
      const waiting = all.filter(
        (t) =>
          t.status === 'waiting' &&
          !running.current.has(t.id) &&
          pendingTargets.current.has(t.id)
      );
      for (const entry of waiting.slice(0, MAX_CONCURRENT_DOWNLOADS - runningCount)) {
        void startTask(entry);
      }
    })();
  }, [startTask]);

  // —— 事件：新增任务（用户手势内触发，可安全弹文件选择器） ——
  // 监听器必须常驻：播放页「下载本集」在抽屉关闭时也会派发事件，
  // 若仅 isOpen 时注册，事件会凭空丢失——toast 提示了入队，实际什么都没发生
  useEffect(() => {
    const onAdd = (e: Event) => {
      const detail = (e as CustomEvent<AddDownloadPayload>).detail;
      if (!detail?.url || !detail?.title) return;
      void (async () => {
        const format = detail.format ?? 'MP4';
        const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const entry: DownloadTaskEntry = {
          id,
          url: detail.url,
          title: detail.title,
          format,
          status: 'waiting',
          finished: 0,
          total: 0,
          errorNum: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        // 用户手势内预选保存目标（FS Access 弹窗必须在手势内）
        try {
          const target = await pickSaveTarget(`${detail.title}.${format.toLowerCase()}`);
          pendingTargets.current.set(id, target);
        } catch (err) {
          if (err instanceof Error && err.message.includes('取消')) {
            toast('已取消下载', 'info');
            return;
          }
        }
        await db.downloads.put(entry);
        refresh();
        scheduleNext();
        toast(`《${detail.title}》已加入下载队列`, 'success');
      })();
    };

    window.addEventListener(ADD_TASK_EVENT, onAdd);
    return () => {
      window.removeEventListener(ADD_TASK_EVENT, onAdd);
    };
  }, [refresh, scheduleNext, toast]);

  // 抽屉打开时：刷新保存能力与任务列表，并启动排队中的任务
  useEffect(() => {
    if (!isOpen) return;
    setCapability(detectSavingCapability());
    refresh();
    scheduleNext();
  }, [isOpen, refresh, scheduleNext]);

  const onPauseResume = async (entry: DownloadTaskEntry) => {
    const handle = running.current.get(entry.id);
    if (handle && (entry.status === 'downloading' || entry.status === 'processing')) {
      handle.pause.pause();
      await updateEntry(entry.id, { status: 'paused' });
      return;
    }
    if (entry.status === 'paused' && handle) {
      // 同一页面内暂停的任务仍持有原保存句柄，不应重新选文件；直接唤醒 worker/合成循环。
      handle.pause.resume();
      await updateEntry(entry.id, { status: handle.phase });
      return;
    }
    if (entry.status === 'paused' || entry.status === 'waiting' || entry.status === 'error') {
      // 页面刷新后的暂停/失败任务，运行句柄和保存目标均已失效，需要用户重新选择。
      try {
        const target = await pickSaveTarget(`${entry.title}.${entry.format.toLowerCase()}`);
        pendingTargets.current.set(entry.id, target);
        await updateEntry(entry.id, { status: 'waiting' });
        scheduleNext();
      } catch (err) {
        if (err instanceof Error && err.message.includes('取消')) toast('已取消', 'info');
      }
      return;
    }
    void handle; // downloading 且无 handle：状态漂移，等待调度器自愈
  };

  const onCancel = async (entry: DownloadTaskEntry) => {
    const handle = running.current.get(entry.id);
    if (handle) {
      handle.abort.abort();
      try {
        await handle.target.abort();
      } catch { /* 已关闭则忽略 */ }
      running.current.delete(entry.id);
    }
    const pendingTarget = pendingTargets.current.get(entry.id);
    if (pendingTarget) {
      try {
        await pendingTarget.abort();
      } catch { /* 忽略 */ }
      pendingTargets.current.delete(entry.id);
    }
    await clearDownloadChunks(entry.id);
    await db.downloads.delete(entry.id);
    refresh();
    // 终态（已完成/失败）删的是记录而非终止任务；文件已保存在用户选择的位置，不受影响
    toast(
      entry.status === 'completed' || entry.status === 'error'
        ? `《${entry.title}》已删除下载记录`
        : `《${entry.title}》已取消下载`,
      'info'
    );
  };

  const statusLabel: Record<DownloadTaskEntry['status'], string> = {
    waiting: '排队中',
    downloading: '下载中',
    processing: '合成中',
    paused: '已暂停',
    completed: '已完成',
    error: '失败',
  };

  return (
    <Drawer open={isOpen} onClose={onClose} title="下载管理" width="max-w-lg">
      <div className="space-y-3">
        <p className="text-xs text-faint">
          保存能力：{capability === 'fs-access' ? '磁盘直写（边下边存）' : '内存聚合（完成后浏览器下载）'} ·
          同时进行 {Math.min(running.current.size, MAX_CONCURRENT_DOWNLOADS)}/{MAX_CONCURRENT_DOWNLOADS} 个任务
        </p>
        {tasks.length === 0 && (
          <div className="py-10 text-center text-sm text-faint">
            暂无下载任务。在播放页点击「下载本集」开始。
          </div>
        )}
        {tasks.map((t) => (
          <div key={t.id} className="card p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm text-content truncate">{t.title}</p>
                <p className="text-xs text-faint">
                  {t.format.toUpperCase()} · {statusLabel[t.status]}
                  {(t.status === 'downloading' || t.status === 'processing') && t.total > 0 ? ` · ${t.finished}/${t.total} 分片` : ''}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {(t.status === 'downloading' || t.status === 'processing') && (
                  <button
                    type="button"
                    className="px-2 py-1 rounded bg-chip hover:bg-hover text-xs text-content transition-colors"
                    onClick={() => void onPauseResume(t)}
                  >
                    暂停
                  </button>
                )}
                {(t.status === 'paused' || t.status === 'waiting' || t.status === 'error') && (
                  <button
                    type="button"
                    className="px-2 py-1 rounded bg-chip hover:bg-hover text-xs text-content transition-colors"
                    onClick={() => void onPauseResume(t)}
                  >
                    继续
                  </button>
                )}
                <button
                  type="button"
                  aria-label="删除下载任务"
                  className="p-1.5 rounded bg-chip hover:bg-hover text-content transition-colors"
                  onClick={() => void onCancel(t)}
                >
                  <Icon name="close" className="w-4 h-4" />
                </button>
              </div>
            </div>
            {(t.status === 'downloading' || t.status === 'processing' || t.status === 'paused' || t.status === 'completed') && t.total > 0 && (
              <div className="h-1.5 rounded-full bg-chip overflow-hidden">
                <div
                  className="h-full bg-accent transition-all"
                  style={{ width: `${t.total > 0 ? Math.min(100, Math.round((t.finished / t.total) * 100)) : 0}%` }}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </Drawer>
  );
}

/** 播放页等处调用：把一集加入下载队列（必须在用户手势内调用） */
export function enqueueDownload(payload: AddDownloadPayload): void {
  window.dispatchEvent(new CustomEvent(ADD_TASK_EVENT, { detail: payload }));
}

/** header 等处调用：打开下载管理器 */
export function requestShowDownloadManager(): void {
  window.dispatchEvent(new CustomEvent(SHOW_MANAGER_EVENT));
}

/** 全局挂载点：根布局渲染一次，监听打开事件 */
export function GlobalDownloadManager() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onShow = () => setOpen(true);
    window.addEventListener(SHOW_MANAGER_EVENT, onShow);
    return () => window.removeEventListener(SHOW_MANAGER_EVENT, onShow);
  }, []);
  return <DownloadManager isOpen={open} onClose={() => setOpen(false)} />;
}

