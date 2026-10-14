import { createContext, useContext, useEffect, useRef, useState } from "react";
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
  key: string; // `${source}:${id}`
  title: string;
  icon: string;
  kind: "mod" | "modpack";
  source: "modrinth" | "curseforge";
  phase: "running" | "done" | "error";
  detail: string;
  pct: number | null;
  files?: InstalledFile[];
  fading?: boolean;
};

type StartArgs = {
  source: "modrinth" | "curseforge";
  kind: "mod" | "modpack";
  id: string;
  title: string;
  icon: string;
  instanceId?: string;
  java: string;
  cfKey: string;
  /** A specific version/file id to install instead of the newest compatible one. */
  versionId?: string;
  onPackInstalled?: (list: Inst[]) => void;
};

type Ctx = {
  tasks: Task[];
  /** Permanent (session-long) record of what's been installed, keyed by `${source}:${id}`.
   *  Unlike `tasks`, this never auto-clears, so it's the right thing to check for "is this
   *  actually installed" after the tray has tidied itself up. */
  done: Record<string, InstalledFile[]>;
  anyRunning: boolean;
  install: (a: StartArgs) => void;
  dismiss: (key: string) => void;
};

const DownloadsCtx = createContext<Ctx | null>(null);

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

  const dismiss = (key: string) => setTasks((ts) => ts.filter((t) => t.key !== key));

  // Auto-dismiss finished tasks a few seconds after they complete.
  // Errors are left alone so the person doesn't miss them.
  const scheduledRef = useRef(new Set<string>());
  useEffect(() => {
    tasks.forEach((t) => {
      if (t.phase === "done" && !scheduledRef.current.has(t.key)) {
        scheduledRef.current.add(t.key);
        setTimeout(() => {
          setTasks((ts) => ts.map((x) => (x.key === t.key ? { ...x, fading: true } : x)));
          setTimeout(() => dismiss(t.key), 280); // let the fade-out play first
        }, 3200);
      }
      if (t.phase !== "done") scheduledRef.current.delete(t.key);
    });
  }, [tasks]);

  const install = (a: StartArgs) => {
    const key = `${a.source}:${a.id}`;
    if (tasksRef.current.some((t) => t.key === key && t.phase === "running")) return;
    setTasks((ts) => [
      ...ts.filter((t) => t.key !== key), // drop a stale done/error row for the same item
      {
        key, title: a.title, icon: a.icon, kind: a.kind, source: a.source,
        phase: "running", detail: a.kind === "modpack" ? "Preparing..." : "Installing...", pct: null,
      },
    ]);
    (async () => {
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
        } else {
          const list = await invoke<Inst[]>("modpack_install", {
            req: { source: a.source, id: a.id, name: a.title, java: a.java || "java", cf_key: a.cfKey },
          });
          setDone((d) => ({ ...d, [key]: [] }));
          patch(key, { phase: "done", detail: "Instance created", pct: 100 });
          a.onPackInstalled?.(list);
        }
      } catch (e) {
        patch(key, { phase: "error", detail: String(e) });
      }
    })();
  };

  const anyRunning = tasks.some((t) => t.phase === "running");

  return (
    <DownloadsCtx.Provider value={{ tasks, done, anyRunning, install, dismiss }}>
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

  return (
    <div className="dlfloat">
      <button className="dlfhead" onClick={() => setOpen((o) => !o)}>
        <span className={"dlfdot" + (running > 0 ? " live" : "")} />
        <b>{running > 0 ? `Downloading ${running} item${running > 1 ? "s" : ""}...` : "Downloads"}</b>
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