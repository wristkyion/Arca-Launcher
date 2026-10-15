import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Inst = { id: string; name: string; loader: string; mc: string; version_id: string; icon: string };

/** One file written into the mods folder: which project it came from, what version/channel it
 *  was, and whether it was the thing the person clicked Install on or a pulled-in dependency. */
export type InstalledFile = {
  project_id: string;
  project_name: string;
  file_name: string;
  version: string;
  channel: "release" | "beta" | "alpha" | string;
  dependency: boolean;
};

export type Task = {
  key: string; // instance-scoped for installed content; modpacks are global
  title: string;
  icon: string;
  kind: "mod" | "modpack" | "resourcepack" | "shader";
  source: "modrinth" | "curseforge";
  phase: "queued" | "running" | "done" | "error";
  detail: string;
  pct: number | null;
  files?: InstalledFile[];
  fading?: boolean;
};

type StartArgs = {
  source: "modrinth" | "curseforge";
  kind: "mod" | "modpack" | "resourcepack" | "shader";
  id: string;
  title: string;
  icon: string;
  instanceId?: string;
  java: string;
  javaMode: "system" | "launcher";
  cfKey: string;
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
  dismiss: (key: string) => void;
  refreshInstalled: (instanceId: string, kind?: "mod" | "resourcepack" | "shader") => Promise<void>;
  configureDownloads: (concurrency: number, autoClear: boolean) => void;
};

const DownloadsCtx = createContext<Ctx | null>(null);

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
  const queueRef = useRef<Array<{ key: string; run: () => Promise<void> }>>([]);
  const queuedKeysRef = useRef(new Set<string>());
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

  // Progress events are global; paint the latest one onto running modpack tasks.
  useEffect(() => {
    let pct: number | null = null;
    const un = listen<string>("progress", (e) => {
      const line = e.payload;
      if (/^(Creating instance|Downloading modpack)/.test(line)) pct = null;
      const m = line.match(/^(Assets|Libraries|Mods|Files) (\d+)\/(\d+)/);
      if (m) pct = Math.round((+m[2] / +m[3]) * 100);
      setTasks((ts) =>
        ts.map((t) =>
          t.phase === "running" && t.kind === "modpack" ? { ...t, detail: line, pct } : t
        )
      );
    });
    return () => { un.then((f) => f()); };
  }, []);

  const dismiss = (key: string) => {
    queueRef.current = queueRef.current.filter((job) => job.key !== key);
    queuedKeysRef.current.delete(key);
    setTasks((ts) => ts.filter((t) => t.key !== key));
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
    if (!autoClear) {
      timersRef.current.forEach(clearTimeout);
      timersRef.current.clear();
      scheduledRef.current.clear();
      setTasks((ts) => ts.some((t) => t.phase === "done" && t.fading)
        ? ts.map((t) => t.phase === "done" && t.fading ? { ...t, fading: false } : t)
        : ts);
      return;
    }
    tasks.forEach((t) => {
      if (t.phase === "done" && !scheduledRef.current.has(t.key)) {
        scheduledRef.current.add(t.key);
        const first = setTimeout(() => {
          timersRef.current.delete(t.key);
          setTasks((ts) => ts.map((x) => (x.key === t.key ? { ...x, fading: true } : x)));
          const second = setTimeout(() => {
            timersRef.current.delete(t.key);
            dismiss(t.key);
          }, 280);
          timersRef.current.set(t.key, second);
        }, 3200);
        timersRef.current.set(t.key, first);
      }
      if (t.phase !== "done") {
        scheduledRef.current.delete(t.key);
        const timer = timersRef.current.get(t.key);
        if (timer) clearTimeout(timer);
        timersRef.current.delete(t.key);
      }
    });
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
    const queued = runningCountRef.current >= maxConcurrentRef.current;
    setTasks((ts) => [
      ...ts.filter((t) => t.key !== key), // drop a stale done/error row for the same item
      {
        key, title: a.title, icon: a.icon, kind: a.kind, source: a.source,
        phase: queued ? "queued" : "running",
        detail: queued ? "Waiting for a download slot" : a.kind === "modpack" ? "Preparing..." : "Installing...",
        pct: null,
      },
    ]);
    queueRef.current.push({ key, run: async () => {
      try {
        if (a.kind === "mod") {
          const files = await invoke<InstalledFile[]>("mod_install", {
            req: { source: a.source, id: a.id, title: a.title, instance: a.instanceId, cf_key: a.cfKey, version_id: a.versionId ?? null },
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
              instance: a.instanceId, cf_key: a.cfKey, version_id: a.versionId ?? null,
            },
          });
          const root = files[0];
          const channelLabel = root && root.channel !== "release" ? ` · ${root.channel}` : "";
          const msg = `${files.length} file${files.length === 1 ? "" : "s"} installed${channelLabel}`;
          setDone((d) => ({ ...d, [key]: files }));
          patch(key, { phase: "done", detail: msg, files });
        } else {
          const list = await invoke<Inst[]>("modpack_install", {
            req: { source: a.source, id: a.id, name: a.title, java: a.java || "java", java_mode: a.javaMode, cf_key: a.cfKey },
          });
          setDone((d) => ({ ...d, [key]: [] }));
          patch(key, { phase: "done", detail: "Instance created", pct: 100 });
          a.onPackInstalled?.(list);
        }
      } catch (e) {
        patch(key, { phase: "error", detail: String(e) });
      }
    } });
    pumpQueueRef.current();
  };

  pumpQueueRef.current = () => {
    while (runningCountRef.current < maxConcurrentRef.current && queueRef.current.length > 0) {
      const job = queueRef.current.shift()!;
      runningCountRef.current += 1;
      patch(job.key, { phase: "running", detail: "Starting..." });
      void job.run().finally(() => {
        runningCountRef.current -= 1;
        queuedKeysRef.current.delete(job.key);
        pumpQueueRef.current();
      });
    }
  };

  useEffect(() => { pumpQueueRef.current(); }, [maxConcurrent]);

  const anyRunning = tasks.some((t) => t.phase === "running" || t.phase === "queued");

  return (
    <DownloadsCtx.Provider value={{ tasks, done, anyRunning, install, dismiss, refreshInstalled, configureDownloads }}>
      {children}
    </DownloadsCtx.Provider>
  );
}

/** Floating download tray pinned to the top-right of the window. */
export function DownloadOverlay() {
  const { tasks, dismiss } = useDownloads();
  const [open, setOpen] = useState(true);
  if (tasks.length === 0) return null;
  const running = tasks.filter((t) => t.phase === "running").length;
  const queued = tasks.filter((t) => t.phase === "queued").length;

  return (
    <div className="dlfloat">
      <button className="dlfhead" onClick={() => setOpen((o) => !o)}>
        <span className={"dlfdot" + (running > 0 ? " live" : "")} />
        <b>{running > 0 ? `Downloading ${running} item${running > 1 ? "s" : ""}${queued ? ` · ${queued} queued` : ""}` : queued ? `${queued} queued` : "Downloads"}</b>
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="dlflist">
          {tasks.map((t) => (
            <div className={"dlfitem" + (t.fading ? " fading" : "")} key={t.key}>
              {t.icon
                ? <img src={t.icon} width={30} height={30} className="micon" alt=""
                    onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
                : <span className="dlfph" />}
              <div className="dlfinfo">
                <b>{t.title}</b>
                <span className={"dlfstatus " + t.phase}>{t.detail}</span>
                {t.phase === "running" && (
                  <div className={"pbar slim" + (t.pct == null ? " indeterminate" : "")}>
                    <span style={t.pct != null ? { width: `${t.pct}%` } : undefined} />
                  </div>
                )}
              </div>
              {t.phase === "running"
                ? <span className="dlfpct">{t.pct != null ? `${t.pct}%` : ""}</span>
                : <button className="dlfx" title="Dismiss" onClick={() => dismiss(t.key)}>✕</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}