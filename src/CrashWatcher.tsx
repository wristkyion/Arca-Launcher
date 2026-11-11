import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";

type CrashPayload = {
  code: number | null;
  log_tail: string[];
  crash_report: { path: string; content: string } | null;
  repair_status: "checking" | "skipped";
};

type RepairPayload = {
  status: "started" | "complete" | "failed";
  error?: string;
};

const PREF_KEY = "launcher.showCrashReports";

export default function CrashWatcher() {
  const [crash, setCrash] = useState<CrashPayload | null>(null);
  const [tab, setTab] = useState<"report" | "log">("report");
  // null when no repair was run for this crash (e.g. a crash in a mod)
  const [repairStatus, setRepairStatus] = useState<RepairPayload | null>(null);

  useEffect(() => {
    const crashListener = listen<CrashPayload>("game-crash", (e) => {
      if (localStorage.getItem(PREF_KEY) === "off") return;
      setCrash(e.payload);
      setRepairStatus(e.payload.repair_status === "checking" ? { status: "started" } : null);
      setTab(e.payload.crash_report ? "report" : "log");
    });
    const repairListener = listen<RepairPayload>("game-repair", (e) => {
      setRepairStatus(e.payload);
    });
    return () => {
      crashListener.then((un) => un());
      repairListener.then((un) => un());
    };
  }, []);

  if (!crash) return null;

  const portals = document.getElementById("portals");
  if (!portals) return null;

  return createPortal(
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
        {repairStatus && (
          <p className={"crash-repair-status" + (repairStatus.status === "failed" ? " failed" : "")}>
            {repairStatus.status === "started" && "Checking and repairing missing or corrupted game files…"}
            {repairStatus.status === "complete" && "Automatic repair check completed."}
            {repairStatus.status === "failed" && `Automatic repair failed: ${repairStatus.error ?? "Unknown error"}`}
          </p>
        )}
        <pre className="crashlog">{tab === "report" && crash.crash_report ? crash.crash_report.content : crash.log_tail.join("\n")}</pre>
        <div className="btnrow">
          {crash.crash_report && <button className="mini" onClick={() => void navigator.clipboard.writeText(crash.crash_report!.content).catch(() => {})}>Copy</button>}
          <button className="mini" onClick={() => setCrash(null)}>Close</button>
        </div>
      </div>
    </>,
    portals
  );
}