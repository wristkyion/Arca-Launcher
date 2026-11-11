import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Inst = { id: string; name: string; loader: string; mc: string; version_id: string; icon: string };
type CreatedInstance = Inst & { description: string; background: string };
type CSSVars = CSSProperties & { [key: `--${string}`]: string | number };

/** One file written into the mods folder: which project it came from, what version/channel it
 *  was, and whether it was the thing the person clicked Install on or a pulled-in dependency. */
export type InstalledFile = {
  project_id: string;
  project_name: string;
  file_name: string;
  version: string;
  channel: "release" | "beta" | "alpha" | string;
  dependency: boolean;
  source: "modrinth" | "curseforge" | string;
  icon: string;
};

export type Task = {
  key: string; // instance-scoped for installed content; modpacks are global
  title: string;
  icon: string;
  kind: "mod" | "modpack" | "resourcepack" | "shader" | "instance" | "migration";
  source: "modrinth" | "curseforge" | "launcher";
  phase: "queued" | "running" | "cancelling" | "cancelled" | "done" | "error";
  detail: string;
  pct: number | null;
  progress?: { current: number; total: number; unit: "bytes" | "files" } | null;
  files?: InstalledFile[];
  fading?: boolean;
  retry?: () => void;
  cancel?: () => void;
};

type ModDownloadProgress = { taskId: string; fileName: string; downloaded: number; total: number | null };
type InstallProgress = { taskId: string; message: string };

type InstanceInstallArgs = {
  name: string;
  loader: string;
  mc: string;
  icon: string;
  description: string;
  background: string;
  java: string;
  javaMode: "system" | "custom";
  onInstalled: (instances: CreatedInstance[]) => void;
};

type StartArgs = {
  source: "modrinth" | "curseforge";
  kind: "mod" | "modpack" | "resourcepack" | "shader";
  id: string;
  title: string;
  icon: string;
  description?: string;
  backgroundUrl?: string;
  instanceId?: string;
  java: string;
  javaMode: "system" | "custom";
  /** A specific version/file id to install instead of the newest compatible one. */
  versionId?: string;
  onPackInstalled?: (list: Inst[]) => void;
};

type Ctx = {
  tasks: Task[];
  /** Successful installs for this session, keyed by instance, kind, source, and project id. */
  done: Record<string, InstalledFile[]>;
  anyRunning: boolean;
  install: (a: StartArgs) => void;
  installInstance: (a: InstanceInstallArgs) => void;
  cancel: (key: string) => void;
  dismiss: (key: string) => void;
  refreshInstalled: (instanceId: string, kind?: "mod" | "resourcepack" | "shader") => Promise<void>;
  configureDownloads: (concurrency: number, autoClear: boolean) => void;
  startMigration: () => Promise<void>;
  startTask: (title: string, icon: string, run: (taskId: string) => Promise<void>, cancellable?: boolean) => Promise<void>;
};

const DownloadsCtx = createContext<Ctx | null>(null);

const formatBytes = (value: number) => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

export const taskKey = (instanceId: string | undefined, source: string, id: string, kind: Task["kind"]) =>
  `${instanceId ? `${instanceId}:` : ""}${kind}:${source}:${id}`;

export const useDownloads = () => {
  const c = useContext(DownloadsCtx);
  if (!c) throw new Error("useDownloads used outside DownloadsProvider");
  return c;
};

export function DownloadsProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [done, setDone] = useState<Record<string, InstalledFile[]>>({});
  const tasksRef = useRef<Task[]>([]);
  tasksRef.current = tasks;
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [maxConcurrent, setMaxConcurrent] = useState(3);
  const [, setAutoClear] = useState(true);
  const maxConcurrentRef = useRef(maxConcurrent);
  const queueRef = useRef<Array<{ key: string; run: () => Promise<void>; serialKey?: string; kind: Task["kind"] }>>([]);
  const queuedKeysRef = useRef(new Set<string>());
  const runningSerialKeysRef = useRef(new Set<string>());
  const runningCountRef = useRef(0);
  const pumpQueueRef = useRef<() => void>(() => {});
  const configureDownloads = useCallback((concurrency: number, clear: boolean) => {
    const limit = Math.max(1, Math.min(5, Math.round(concurrency)));
    maxConcurrentRef.current = limit;
    setMaxConcurrent(limit);
    setAutoClear(clear);
  }, []);

  const patch = (key: string, p: Partial<Task>) =>
    setTasks((ts) => ts.map((t) => (t.key === key ? { ...t, ...p } : t)));

  // Task-scoped events keep one install's progress from overwriting another task.
  useEffect(() => {
    const unInstall = listen<InstallProgress>("install-progress", (e) => {
      const { taskId, message } = e.payload;
      const counter = message.match(/^(Assets|Libraries|Mods|Files) (\d+)\/(\d+)/);
      const progress = counter && Number(counter[3]) > 0
        ? { current: Number(counter[2]), total: Number(counter[3]), unit: "files" as const }
        : null;
      const pct = progress ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : null;
      setTasks((ts) => ts.map((task) => task.key === taskId && task.phase === "running"
        ? { ...task, detail: message, pct, progress }
        : task));
    });
    const unMod = listen<ModDownloadProgress>("mod-download-progress", (event) => {
      const { taskId, fileName, downloaded, total } = event.payload;
      const pct = total && total > 0 ? Math.min(99, Math.floor((downloaded / total) * 100)) : null;
      const detail = total && total > 0
        ? `${fileName} · ${formatBytes(downloaded)} / ${formatBytes(total)}`
        : `${fileName} · ${formatBytes(downloaded)}`;
      setTasks((ts) => ts.map((task) => task.key === taskId && task.phase === "running"
        ? {
          ...task,
          detail,
          pct,
          progress: total && total > 0 ? { current: downloaded, total, unit: "bytes" } : null,
        }
        : task));
    });
    return () => {
      unInstall.then((f) => f());
      unMod.then((f) => f());
    };
  }, []);

  const dismiss = (key: string) => {
    const task = tasksRef.current.find((item) => item.key === key);
    if (!task || task.fading) return;
    queueRef.current = queueRef.current.filter((job) => job.key !== key);
    queuedKeysRef.current.delete(key);
    patch(key, { fading: true });
    const existingTimer = timersRef.current.get(key);
    if (existingTimer) clearTimeout(existingTimer);
    timersRef.current.set(key, setTimeout(() => {
      timersRef.current.delete(key);
      setTasks((ts) => ts.filter((t) => t.key !== key));
    }, 240));
  };

  const cancelTask = (key: string) => {
    const queuedIndex = queueRef.current.findIndex((job) => job.key === key);
    if (queuedIndex >= 0) {
      queueRef.current.splice(queuedIndex, 1);
      queuedKeysRef.current.delete(key);
      patch(key, { phase: "cancelled", detail: "Cancelled", pct: null });
      pumpQueueRef.current();
      return;
    }
    const task = tasksRef.current.find((item) => item.key === key);
    if (!task || task.phase !== "running") return;
    patch(key, { phase: "cancelling", detail: "Cancelling..." });
    void invoke("cancel_download", { taskId: key }).catch((error) => {
      if (tasksRef.current.some((task) => task.key === key && task.phase === "cancelling")) {
        patch(key, { phase: "error", detail: `Could not cancel download: ${error}` });
      }
    });
  };

  const refreshInstalled = useCallback(async (instanceId: string, kind: "mod" | "resourcepack" | "shader" = "mod") => {
    const contentKind = kind === "mod" ? "mods" : kind === "resourcepack" ? "resourcepacks" : "shaderpacks";
    const files = await invoke<{ file_name: string }[]>("list_content", {
      req: { instance: instanceId, kind: contentKind },
    });
    const normalizeFileName = (name: string) => name.replace(/\.disabled$/i, "").toLowerCase();
    const present = new Set(files.map((file) => normalizeFileName(file.file_name)));
    const prefix = `${instanceId}:${kind}:`;
    setDone((current) => {
      const next = { ...current };
      for (const [key, installed] of Object.entries(current)) {
        if (!key.startsWith(prefix)) continue;
        const remaining = installed.filter((file) => present.has(normalizeFileName(file.file_name)));
        const root = remaining.find((file) => !file.dependency);
        if (!root) delete next[key];
        else next[key] = remaining;
      }
      return next;
    });
  }, []);

  useEffect(() => () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current.clear();
  }, []);

  const install = (a: StartArgs) => {
    const key = taskKey(a.kind === "modpack" ? undefined : a.instanceId, a.source, a.id, a.kind);
    if (queuedKeysRef.current.has(key) ||
      tasksRef.current.some((t) => t.key === key && (t.phase === "running" || t.phase === "queued"))) return;
    const dismissTimer = timersRef.current.get(key);
    if (dismissTimer) clearTimeout(dismissTimer);
    timersRef.current.delete(key);
    queuedKeysRef.current.add(key);
    const serialKey = a.kind === "modpack" ? "game-install" : undefined;
    const queued = runningCountRef.current >= maxConcurrentRef.current || (!!serialKey && runningSerialKeysRef.current.has(serialKey));
    setTasks((ts) => [
      ...ts.filter((t) => t.key !== key), // drop a stale done/error row for the same item
      {
        key, title: a.title, icon: a.icon, kind: a.kind, source: a.source,
        phase: queued ? "queued" : "running",
        detail: queued ? "Waiting for a download slot" : a.kind === "modpack" ? "Preparing..." : "Installing...",
        pct: null,
        cancel: () => cancelTask(key),
      },
    ]);
    queueRef.current.push({ key, run: async () => {
      try {
        if (a.kind === "mod") {
          const files = await invoke<InstalledFile[]>("mod_install", {
            req: { source: a.source, id: a.id, title: a.title, icon: a.icon, instance: a.instanceId, version_id: a.versionId ?? null, task_id: key },
          });
          const root = files.find((f) => !f.dependency) ?? files[0];
          const channelLabel = root && root.channel !== "release" ? ` · ${root.channel}` : "";
          const msg = `${files.length} file${files.length === 1 ? "" : "s"} installed${channelLabel}`;
          setDone((d) => ({ ...d, [key]: files }));
          patch(key, { phase: "done", detail: msg, files });
        } else if (a.kind === "resourcepack" || a.kind === "shader") {
          const files = await invoke<InstalledFile[]>("content_install", {
            req: {
              source: a.source, kind: a.kind, id: a.id, title: a.title,
              icon: a.icon,
              instance: a.instanceId, version_id: a.versionId ?? null, task_id: key,
            },
          });
          const root = files[0];
          const channelLabel = root && root.channel !== "release" ? ` · ${root.channel}` : "";
          const msg = `${files.length} file${files.length === 1 ? "" : "s"} installed${channelLabel}`;
          setDone((d) => ({ ...d, [key]: files }));
          patch(key, { phase: "done", detail: msg, files });
        } else {
          const list = await invoke<Inst[]>("modpack_install", {
            req: {
              source: a.source,
              id: a.id,
              name: a.title,
              icon: a.icon,
              description: a.description ?? "",
              thumbnail_url: a.backgroundUrl ?? "",
              java: a.java || "java",
              java_mode: a.javaMode,
              task_id: key,
            },
          });
          setDone((d) => ({ ...d, [key]: [] }));
          patch(key, { phase: "done", detail: "Instance created", pct: 100 });
          a.onPackInstalled?.(list);
        }
      } catch (e) {
        const cancelled = /cancel(?:led|ed)/i.test(String(e)) || tasksRef.current.some((task) => task.key === key && task.phase === "cancelling");
        patch(key, { phase: cancelled ? "cancelled" : "error", detail: cancelled ? "Cancelled" : String(e), pct: null });
      }
    }, serialKey, kind: a.kind });
    pumpQueueRef.current();
  };

  const installInstance = (a: InstanceInstallArgs) => {
    const key = `instance:${crypto.randomUUID()}`;
    const serialKey = "game-install";
    const run = async () => {
      try {
        const instances = await invoke<CreatedInstance[]>("create_instance", {
          req: {
            name: a.name, loader: a.loader, mc: a.mc, java: a.java || "java",
            java_mode: a.javaMode, icon: a.icon, description: a.description, background: a.background, task_id: key,
          },
        });
        a.onInstalled(instances);
        patch(key, { phase: "done", detail: "Instance ready", pct: 100 });
      } catch (error) {
        const cancelled = /cancel(?:led|ed)/i.test(String(error)) ||
          tasksRef.current.some((task) => task.key === key && task.phase === "cancelling");
        patch(key, {
          phase: cancelled ? "cancelled" : "error",
          detail: cancelled ? "Cancelled" : String(error),
          pct: null,
        });
      }
    };
    const retry = () => {
      if (queuedKeysRef.current.has(key)) return;
      queuedKeysRef.current.add(key);
      patch(key, { phase: "queued", detail: "Waiting for an install slot", pct: null });
      queueRef.current.push({ key, run, serialKey, kind: "instance" });
      pumpQueueRef.current();
    };
    const queued = runningCountRef.current >= maxConcurrentRef.current || runningSerialKeysRef.current.has(serialKey);
    queuedKeysRef.current.add(key);
    setTasks((ts) => [...ts, {
      key, title: a.name, icon: a.icon, kind: "instance", source: "launcher",
      phase: queued ? "queued" : "running",
      detail: queued ? "Waiting for an install slot" : "Preparing Java and game files...",
      pct: null, retry, cancel: () => cancelTask(key),
    }]);
    queueRef.current.push({ key, run, serialKey, kind: "instance" });
    pumpQueueRef.current();
  };

  const startMigration = useCallback(async () => {
    const key = "legacy-migration";
    setTasks((ts) => [...ts, {
      key, title: "Updating instance storage", icon: "", kind: "migration", source: "launcher",
      phase: "running", detail: "Migrating instances to the new format...", pct: null,
    }]);
    try {
      await invoke("migrate_legacy_instances");
      patch(key, { phase: "done", detail: "Migration complete", pct: 100 });
    } catch (error) {
      patch(key, { phase: "error", detail: String(error), pct: null });
      throw error;
    }
  }, []);

  const startTask = async (
    title: string,
    icon: string,
    run: (taskId: string) => Promise<void>,
    cancellable = false,
  ) => {
    const key = `task:${crypto.randomUUID()}`;
    setTasks((ts) => [...ts, {
      key, title, icon, kind: "instance", source: "launcher",
      phase: "running", detail: "Starting...", pct: null,
      ...(cancellable ? { cancel: () => cancelTask(key) } : {}),
    }]);
    try {
      await run(key);
      patch(key, { phase: "done", detail: "Completed", pct: 100 });
    } catch (error) {
      patch(key, { phase: "error", detail: String(error), pct: null });
      throw error;
    }
  };

  pumpQueueRef.current = () => {
    while (runningCountRef.current < maxConcurrentRef.current && queueRef.current.length > 0) {
      const index = queueRef.current.findIndex((job) => !job.serialKey || !runningSerialKeysRef.current.has(job.serialKey));
      if (index < 0) break;
      const [job] = queueRef.current.splice(index, 1);
      if (job.serialKey) runningSerialKeysRef.current.add(job.serialKey);
      runningCountRef.current += 1;
      patch(job.key, { phase: "running", detail: job.kind === "instance" ? "Preparing Java and game files..." : "Starting..." });
      void job.run().finally(() => {
        runningCountRef.current -= 1;
        if (job.serialKey) runningSerialKeysRef.current.delete(job.serialKey);
        queuedKeysRef.current.delete(job.key);
        pumpQueueRef.current();
      });
    }
  };

  useEffect(() => { pumpQueueRef.current(); }, [maxConcurrent]);

  const anyRunning = tasks.some((t) => t.phase === "running" || t.phase === "queued" || t.phase === "cancelling");

  return (
    <DownloadsCtx.Provider value={{ tasks, done, anyRunning, install, installInstance, startMigration, startTask, cancel: cancelTask, dismiss, refreshInstalled, configureDownloads }}>
      {children}
    </DownloadsCtx.Provider>
  );
}

/**
 * Floating tasks indicator pinned to the bottom-right of the window.
 *
 * Collapsed state is a round button with a circular progress ring (so it never
 * has to fit a text label into a tiny box). Once the person explicitly collapses
 * it, new tasks only pulse the badge — they don't force the panel back open.
 */
export function DownloadsFloat() {
  const { tasks, dismiss } = useDownloads();
  const [isMounted, setIsMounted] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [badgePulse, setBadgePulse] = useState(false);
  const prevTaskCountRef = useRef(0);
  const userCollapsedRef = useRef(false);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taskSignature = tasks.map((task) => task.key).join("\0");

  const running = tasks.filter((t) => t.phase === "running" || t.phase === "cancelling").length;
  const queued = tasks.filter((t) => t.phase === "queued").length;
  const activeCount = running + queued;
  const hasActiveTasks = activeCount > 0;

  // Only combine progress that shares a unit; bytes and file counts are not comparable.
  const activeTasks = tasks.filter((t) => t.phase === "running");
  const activeProgress = activeTasks.map((task) => task.progress);
  const progressUnit = activeProgress[0]?.unit;
  const canAggregate = activeProgress.length > 0 &&
    activeProgress.every((progress) => progress != null && progress.unit === progressUnit);
  const ringPct = canAggregate && progressUnit
    ? Math.min(100, Math.round(
      (activeProgress.reduce((sum, progress) => sum + (progress?.current ?? 0), 0) /
        activeProgress.reduce((sum, progress) => sum + (progress?.total ?? 0), 0)) * 100,
    ))
    : null;

  // Auto-open the first time a task ever shows up in this session. After the
  // person collapses it once, later tasks just pulse the badge instead.
  useEffect(() => {
    const currentCount = tasks.length;
    const hadTasks = prevTaskCountRef.current > 0;

    if (currentCount > 0 && !hadTasks) {
      if (panelTimerRef.current) clearTimeout(panelTimerRef.current);
      panelTimerRef.current = null;
      setIsMounted(true);
      setIsClosing(false);
    } else if (currentCount === 0 && hadTasks) {
      setIsClosing(true);
      if (panelTimerRef.current) clearTimeout(panelTimerRef.current);
      panelTimerRef.current = setTimeout(() => {
        setIsOpen(false);
        setIsMounted(false);
        setIsClosing(false);
        panelTimerRef.current = null;
      }, 260);
    }

    if (currentCount > prevTaskCountRef.current) {
      if (hasActiveTasks && !userCollapsedRef.current) {
        setIsOpen(true);
        setIsClosing(false);
      } else if (!isOpen) {
        setBadgePulse(true);
        if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
        pulseTimerRef.current = setTimeout(() => setBadgePulse(false), 700);
      }
    }
    prevTaskCountRef.current = currentCount;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskSignature, hasActiveTasks]);

  useEffect(() => () => {
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    if (panelTimerRef.current) clearTimeout(panelTimerRef.current);
  }, []);

  const openPanel = () => {
    userCollapsedRef.current = false;
    setIsOpen(true);
    setIsClosing(false);
  };

  const closePanel = () => {
    userCollapsedRef.current = true;
    setIsClosing(true);
    if (panelTimerRef.current) clearTimeout(panelTimerRef.current);
    panelTimerRef.current = setTimeout(() => {
      setIsOpen(false);
      if (tasks.length === 0) setIsMounted(false);
      setIsClosing(false);
      panelTimerRef.current = null;
    }, 260); // matches tfPanelOut
  };

  if (!isMounted) return null;

  if (!isOpen) {
    const r = 19;
    const circumference = 2 * Math.PI * r;
    const offset = ringPct != null ? circumference * (1 - ringPct / 100) : circumference * 0.75;
    return (
      <button
        className={"tasksfab" + (badgePulse ? " pulse" : "") + (isClosing ? " closing" : "")}
        onClick={openPanel}
        title="View tasks"
        aria-label={activeCount > 0 ? `View tasks, ${activeCount} active` : "View tasks"}
      >
        <svg className="tasksfab-ring" viewBox="0 0 44 44" aria-hidden="true">
          <circle className="tasksfab-ring-track" cx="22" cy="22" r={r} />
          {hasActiveTasks && (
            <circle
              className={"tasksfab-ring-bar" + (ringPct == null ? " indeterminate" : "")}
              cx="22" cy="22" r={r}
              strokeDasharray={circumference}
              strokeDashoffset={offset}
            />
          )}
        </svg>
        <span className="tasksfab-icon" aria-hidden="true">{hasActiveTasks ? "↓" : "✓"}</span>
        {activeCount > 0 && <span className="tasksfab-badge">{activeCount}</span>}
      </button>
    );
  }

  return (
    <div className={"taskspanel" + (isClosing ? " closing" : "")}>
      <div className="taskspanel-head">
        <div className="taskspanel-head-left">
          <span className={"taskspanel-dot" + (hasActiveTasks ? " live" : "")} />
          <span className="taskspanel-title">Tasks</span>
          {activeCount > 0 && <span className="taskspanel-count">{activeCount}</span>}
        </div>
        <button className="taskspanel-close" onClick={closePanel} title="Hide panel">✕</button>
      </div>
      <div className="taskspanel-list">
        {tasks.map((t) => (
          <div className={"taskitem" + (t.fading ? " fading" : "") + (t.phase === "running" ? " entering" : "") + " phase-" + t.phase} key={t.key}>
            {t.icon
              ? <img src={t.icon} width={36} height={36} className="taskitem-icon" alt=""
                  onError={(e) => e.currentTarget.classList.add("is-hidden")} />
              : <span className="taskitem-icon-ph" />}
            <div className="taskitem-info">
                <div className="taskitem-title-row">
                  <div className="taskitem-title">{t.title}</div>
                  {t.phase === "running" && t.pct != null && <span className="taskitem-pct">{t.pct}%</span>}
                </div>
                <div className={"taskitem-status status-" + t.phase}>{t.detail}</div>
              {t.phase === "running" && (
                <div
                  className="taskitem-progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={t.pct ?? undefined}
                  aria-label={`${t.title} progress`}
                >
                  <div
                    className={"taskitem-progress-bar" + (t.pct == null ? " indeterminate" : "")}
                    style={t.pct == null ? undefined : { width: `${t.pct}%` }}
                  />
                </div>
              )}
            </div>
            <div className="taskitem-actions">
              {(t.phase === "running" || t.phase === "queued") && t.cancel
                ? <button className="taskitem-btn cancel" onClick={() => t.cancel?.()}>Cancel</button>
                : t.phase === "cancelling"
                  ? <span className="taskitem-cancelling">Cancelling…</span>
                : t.phase === "error" && t.retry
                  ? <button className="taskitem-btn retry" onClick={t.retry}>Retry</button>
                  : null}
              {(t.phase === "done" || t.phase === "error" || t.phase === "cancelled") && (
                <button className="taskitem-remove" onClick={() => dismiss(t.key)} title="Remove task">✕</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}