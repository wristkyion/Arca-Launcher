import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";

type CrashPayload = {
  code: number | null;
  log_tail: string[];
  crash_report: { path: string; content: string } | null;
  repair_status: "checking";
};

type RepairPayload = {
  status: "started" | "complete" | "failed";
  error?: string;
};

const PREF_KEY = "launcher.showCrashReports";

export default function CrashWatcher() {
  const [crash, setCrash] = useState<CrashPayload | null>(null);
  const [tab, setTab] = useState<"report" | "log">("report");
  const [repairStatus, setRepairStatus] = useState<RepairPayload>({ status: "started" });

  useEffect(() => {
    const crashListener = listen<CrashPayload>("game-crash", (e) => {
      if (localStorage.getItem(PREF_KEY) === "off") return;
      setCrash(e.payload);
      setRepairStatus({ status: e.payload.repair_status === "checking" ? "started" : "complete" });
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
        <p className={"crash-repair-status" + (repairStatus.status === "failed" ? " failed" : "")}>
          {repairStatus.status === "started" && "Checking and repairing missing or corrupted game files…"}
          {repairStatus.status === "complete" && "Automatic repair check completed."}
          {repairStatus.status === "failed" && `Automatic repair failed: ${repairStatus.error ?? "Unknown error"}`}
        </p>
        <pre className="crashlog">{tab === "report" && crash.crash_report ? crash.crash_report.content : crash.log_tail.join("\n")}</pre>
        <div className="btnrow">
          {crash.crash_report && <button className="mini" onClick={() => navigator.clipboard.writeText(crash.crash_report!.content)}>Copy</button>}
          <button className="mini" onClick={() => setCrash(null)}>Close</button>
        </div>
      </div>
    </>,
    portals
  );
}