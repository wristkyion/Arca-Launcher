import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

type CrashPayload = {
  code: number | null;
  log_tail: string[];
  crash_report: { path: string; content: string } | null;
};

const PREF_KEY = "launcher.showCrashReports";

export default function CrashWatcher() {
  const [crash, setCrash] = useState<CrashPayload | null>(null);
  const [tab, setTab] = useState<"report" | "log">("report");

  useEffect(() => {
    const un = listen<CrashPayload>("game-crash", (e) => {
      if (localStorage.getItem(PREF_KEY) === "off") return;
      setCrash(e.payload);
      setTab(e.payload.crash_report ? "report" : "log");
    });
    return () => { un.then((f) => f()); };
  }, []);

  if (!crash) return null;

  return (
    <>
      <div className="scrim popfade" onClick={() => setCrash(null)} />
      <div className="crashdialog pop">
        <div className="vpicktop">
          <b>Minecraft crashed{crash.code != null ? ` (exit code ${crash.code})` : ""}</b>
          <button className="mini" onClick={() => setCrash(null)}>✕</button>
        </div>
        {crash.crash_report && (
          <div className="seg">
            <button className={tab === "report" ? "on" : ""} onClick={() => setTab("report")}>Crash report</button>
            <button className={tab === "log" ? "on" : ""} onClick={() => setTab("log")}>Game log</button>
          </div>
        )}
        <pre className="crashlog">{tab === "report" && crash.crash_report ? crash.crash_report.content : crash.log_tail.join("\n")}</pre>
        <div className="btnrow">
          {crash.crash_report && <button className="mini" onClick={() => navigator.clipboard.writeText(crash.crash_report!.content)}>Copy</button>}
          <button className="mini" onClick={() => setCrash(null)}>Close</button>
        </div>
      </div>
    </>
  );
}