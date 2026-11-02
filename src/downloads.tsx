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
  const [maxConcurrent, setMaxConcurrent] = useState(3);
  const [autoClear, setAutoClear] = useState(true);
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
      const pct = counter ? Math.round((Number(counter[2]) / Number(counter[3])) * 100) : null;
      setTasks((ts) => ts.map((task) => task.key === taskId && task.phase === "running"
        ? { ...task, detail: message, pct }
        : task));
    });
    const unMod = listen<ModDownloadProgress>("mod-download-progress", (event) => {
      const { taskId, fileName, downloaded, total } = event.payload;
      const pct = total && total > 0 ? Math.min(99, Math.floor((downloaded / total) * 100)) : null;
      const detail = total && total > 0
        ? `${fileName} · ${formatBytes(downloaded)} / ${formatBytes(total)}`
        : `${fileName} · ${formatBytes(downloaded)}`;
      setTasks((ts) => ts.map((task) => task.key === taskId && task.phase === "running"
        ? { ...task, detail, pct }
        : task));
    });
    return () => {
      unInstall.then((f) => f());
      unMod.then((f) => f());
    };
  }, []);

  const dismiss = (key: string) => {
    queueRef.current = queueRef.current.filter((job) => job.key !== key);
    queuedKeysRef.current.delete(key);
    setTasks((ts) => ts.filter((t) => t.key !== key));
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
    if (task?.kind !== "mod" || task.phase !== "running") return;
    patch(key, { phase: "cancelling", detail: "Cancelling..." });
    void invoke("cancel_mod_install", { taskId: key }).catch((error) => {
      patch(key, { phase: "error", detail: `Could not cancel download: ${error}` });
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

  // Completed tasks can be kept visible; errors always remain until dismissed.
  const scheduledRef = useRef(new Set<string>());
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    // Auto-clear disabled - tasks stay until manually removed
    if (!autoClear) {
      timersRef.current.forEach(clearTimeout);
      timersRef.current.clear();
      scheduledRef.current.clear();
      setTasks((ts) => ts.some((t) => t.phase === "done" && t.fading)
        ? ts.map((t) => t.phase === "done" && t.fading ? { ...t, fading: false } : t)
        : ts);
      return;
    }
    // Disabled: do not auto-remove completed tasks
    // User must manually click (X) button to remove
  }, [tasks, autoClear]);

  useEffect(() => () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current.clear();
  }, []);

  const install = (a: StartArgs) => {
    const key = taskKey(a.kind === "modpack" ? undefined : a.instanceId, a.source, a.id, a.kind);
    if (queuedKeysRef.current.has(key) ||
      tasksRef.current.some((t) => t.key === key && (t.phase === "running" || t.phase === "queued"))) return;
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
        cancel: a.kind === "mod" ? () => cancelTask(key) : undefined,
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
              instance: a.instanceId, version_id: a.versionId ?? null,
            },
          });
          const root = files[0];
          const channelLabel = root && root.channel !== "release" ? ` · ${root.channel}` : "";
          const msg = `${files.length} file${files.length === 1 ? "" : "s"} installed${channelLabel}`;
          setDone((d) => ({ ...d, [key]: files }));
          patch(key, { phase: "done", detail: msg, files });
        } else {
          const list = await invoke<Inst[]>("modpack_install", {
            req: { source: a.source, id: a.id, name: a.title, java: a.java || "java", java_mode: a.javaMode, task_id: key },
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
        patch(key, { phase: "error", detail: String(error), pct: null });
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
      pct: null, retry,
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
    <DownloadsCtx.Provider value={{ tasks, done, anyRunning, install, installInstance, startMigration, cancel: cancelTask, dismiss, refreshInstalled, configureDownloads }}>
      {children}
    </DownloadsCtx.Provider>
  );
}

/** Floating download tray pinned to the right side of the window. */
export function DownloadsFloat() {
  const { tasks, dismiss } = useDownloads();
  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const prevTaskCountRef = useRef(0);
  const running = tasks.filter((t) => t.phase === "running" || t.phase === "cancelling").length;
  const queued = tasks.filter((t) => t.phase === "queued").length;
  const hasActiveTasks = running > 0 || queued > 0;

  // Auto-open only when NEW tasks are added (not when panel manually closed)
  useEffect(() => {
    const currentCount = tasks.length;
    // New task appeared - open panel
    if (currentCount > prevTaskCountRef.current && hasActiveTasks) {
      setIsOpen(true);
      setIsClosing(false);
    }
    prevTaskCountRef.current = currentCount;
  }, [tasks.length, hasActiveTasks]);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      setIsOpen(false);
      setIsClosing(false);
    }, 300); // Match animation duration
  };

  // Show toggle button when collapsed and tasks exist
  if (!isOpen && tasks.length > 0) {
    return (
      <button 
        className="dlftoggle"
        onClick={() => setIsOpen(true)}
        title="View tasks"
      >
        <span>View Tasks</span>
        {hasActiveTasks && <span className="dlftoggle-badge">{running || queued}</span>}
      </button>
    );
  }

  if (tasks.length === 0) return null;

  return (
    <div className={"dlfloat" + (isClosing ? " closing" : "")}>
      <div className="dlfhead">
        <div className="dlfhead-left">
          <span className={("dlfdot" + (hasActiveTasks ? " live" : ""))} />
          <span className="dlfhead-title">Tasks</span>
        </div>
        <button 
          className="dlfclose-panel" 
          onClick={handleClose}
          title="Hide panel"
        >
          ✕
        </button>
      </div>
      <div className="dlflist">
        {tasks.map((t) => (
          <div className={"dlfitem" + (t.fading ? " fading" : "") + " phase-" + t.phase} key={t.key}>
            {t.icon
              ? <img src={t.icon} width={40} height={40} className="dlf-icon" alt=""
                  onError={(e) => e.currentTarget.classList.add("is-hidden")} />
              : <span className="dlf-icon-ph" />}
            <div className="dlfinfo">
              <div className="dlf-title">{t.title}</div>
              <div className={"dlf-status status-" + t.phase}>{t.detail}</div>
              {t.phase === "running" && t.pct != null && (
                <div className="dlf-progress">
                  <div className="dlf-progress-bar" style={{ width: `${t.pct}%` }} />
                </div>
              )}
            </div>
            <div className="dlfactions">
              {t.phase === "running" && t.pct != null && (
                <span className="dlf-percent">{t.pct}%</span>
              )}
              {(t.phase === "running" || t.phase === "queued") && t.cancel
                ? <button className="dlf-btn dlf-btn-cancel" onClick={() => t.cancel?.()}>Cancel</button>
                : t.phase === "error" && t.retry
                  ? <button className="dlf-btn dlf-btn-retry" onClick={t.retry}>Retry</button>
                  : null}
              {(t.phase === "done" || t.phase === "error" || t.phase === "cancelled") && (
                <button className="dlf-btn-remove" onClick={() => dismiss(t.key)} title="Remove task">✕</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}