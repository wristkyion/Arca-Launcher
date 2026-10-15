import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { taskKey, useDownloads } from "./downloads";

export type Inst = { id: string; name: string; loader: string; mc: string; version_id: string; icon: string };
type Hit = { id: string; title: string; summary: string; icon: string; downloads: number; author: string; url: string };
type Res = { hits: Hit[]; total: number };
type VersionHit = { id: string; name: string; channel: string; game_versions: string[]; date: string };

type Props = {
  inst: Inst | null;
  cfKey: string;
  java: string;
  javaMode: "system" | "launcher";
  onPackInstalled: (list: Inst[]) => void;
  goSettings: () => void;
  active: boolean;
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const fmt = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n));
const chLabel = (ch: string) => (ch === "release" ? "Release" : ch === "beta" ? "Beta" : ch === "alpha" ? "Alpha" : cap(ch));

export default function ModsPage({ inst, cfKey, java, javaMode, onPackInstalled, goSettings, active }: Props) {
  const { tasks, done, install, refreshInstalled } = useDownloads();

  const [source, setSource] = useState<"modrinth" | "curseforge">("modrinth");
  const [kind, setKind] = useState<"mod" | "modpack" | "resourcepack" | "shader">("mod");
  const [sort, setSort] = useState<"relevance" | "downloads" | "updated">("relevance");
  const [query, setQuery] = useState("");
  const [onlyCompat, setOnlyCompat] = useState(true);
  const [hits, setHits] = useState<Hit[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const reqId = useRef(0);

  // version picker
  const [picker, setPicker] = useState<Hit | null>(null);
  const [verMode, setVerMode] = useState<"latest" | "pick">("latest");
  const [verChannel, setVerChannel] = useState<"all" | "release" | "beta" | "alpha">("release");
  const [verList, setVerList] = useState<VersionHit[]>([]);
  const [verLoading, setVerLoading] = useState(false);
  const [verErr, setVerErr] = useState("");
  const [verChosen, setVerChosen] = useState<string | null>(null);
  const [verShown, setVerShown] = useState(25);
  const verReqId = useRef(0);

  const canMods = !!inst && inst.loader !== "vanilla";
  const needKey = source === "curseforge" && !cfKey.trim();
  const filterMc = kind !== "modpack" && onlyCompat && inst ? inst.mc : "";
  const filterLoader = kind === "mod" && onlyCompat && canMods ? inst!.loader : "";

  const search = async (offset: number, append: boolean) => {
    if (needKey) { setHits([]); setTotal(0); setErr(""); return; }
    const id = ++reqId.current;
    setLoading(true);
    setErr("");
    try {
      const r = await invoke<Res>("mod_search", {
        req: { source, kind, query, sort, mc: filterMc, loader: filterLoader, offset, cf_key: cfKey },
      });
      if (id !== reqId.current) return;
      setHits((prev) => (append ? [...prev, ...r.hits] : r.hits));
      setTotal(r.total);
    } catch (e) {
      if (id === reqId.current) setErr(String(e));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => search(0, false), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, kind, query, sort, onlyCompat, inst?.id, cfKey]);

  useEffect(() => {
    if (!active || !inst || kind === "modpack") return;
    let activeRequest = true;
    refreshInstalled(inst.id, kind).catch((e) => {
      if (activeRequest) setErr(`Could not refresh installed ${kind === "mod" ? "mods" : kind === "resourcepack" ? "resource packs" : "shader packs"}: ${e}`);
    });
    return () => { activeRequest = false; };
  }, [active, inst?.id, kind, refreshInstalled]);

  useEffect(() => {
    if (!picker || verMode !== "pick") return;
    const id = ++verReqId.current;
    setVerLoading(true);
    setVerErr("");
    invoke<VersionHit[]>("mod_versions", { req: { source, id: picker.id, cf_key: cfKey } })
      .then((v) => { if (id === verReqId.current) setVerList(v); })
      .catch((e) => { if (id === verReqId.current) setVerErr(String(e)); })
      .finally(() => { if (id === verReqId.current) setVerLoading(false); });
  }, [picker, verMode, source, cfKey]);

  const keyOf = (h: Hit) => taskKey(kind === "modpack" ? undefined : inst?.id, source, h.id, kind);
  const taskFor = (h: Hit) => tasks.find((t) => t.key === keyOf(h));

  const doInstall = (h: Hit) => {
    install({
      source, kind, id: h.id, title: h.title, icon: h.icon,
      instanceId: inst?.id, java, javaMode, cfKey, onPackInstalled,
    });
  };

  const openPicker = (h: Hit) => {
    setPicker(h); setVerMode("latest"); setVerChannel("release");
    setVerList([]); setVerErr(""); setVerChosen(null); setVerShown(25);
  };
  const closePicker = () => setPicker(null);
  const confirmInstall = () => {
    if (!picker) return;
    install({
      source, kind, id: picker.id, title: picker.title, icon: picker.icon,
      instanceId: inst?.id, java, javaMode, cfKey, onPackInstalled,
      versionId: verMode === "pick" ? (verChosen ?? undefined) : undefined,
    });
    closePicker();
  };

  const toggle = (key: string) => setExpanded((e) => ({ ...e, [key]: !e[key] }));

  return (
    <section className="panel mods-panel">
      <header className="mods-heading">
        <div>
          <span className="mods-eyebrow">DISCOVER & INSTALL</span>
          <h2>Downloader</h2>
          <p>{inst ? `${inst.name} · Minecraft ${inst.mc} · ${cap(inst.loader)}` : "Browse content from Modrinth and CurseForge"}</p>
        </div>
        <div className="mods-sources" aria-label="Content source">
          <button className={source === "modrinth" ? "on" : ""} onClick={() => setSource("modrinth")}>Modrinth</button>
          <button className={source === "curseforge" ? "on" : ""} onClick={() => setSource("curseforge")}>CurseForge</button>
        </div>
      </header>
      <div className="mods-toolbar">
        <div className="mods-types" aria-label="Content type">
          <button className={kind === "mod" ? "on" : ""} onClick={() => setKind("mod")}>Mods</button>
          <button className={kind === "modpack" ? "on" : ""} onClick={() => setKind("modpack")}>Modpacks</button>
          <button className={kind === "resourcepack" ? "on" : ""} onClick={() => setKind("resourcepack")}>Resource Packs</button>
          <button className={kind === "shader" ? "on" : ""} onClick={() => setKind("shader")}>Shader Packs</button>
        </div>
        <label className="mods-sort">
          <span>Sort by</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="relevance">Relevance</option>
            <option value="downloads">Most downloaded</option>
            <option value="updated">Recently updated</option>
          </select>
        </label>
      </div>
      <div className="mods-searchwrap">
        <span aria-hidden="true">⌕</span>
        <input className="mods-search" placeholder={`Search ${kind === "shader" ? "shader packs" : kind === "resourcepack" ? "resource packs" : kind === "modpack" ? "modpacks" : "mods"} by name or keyword...`} value={query} onChange={(e) => setQuery(e.target.value)} />
        {query && <button className="mini" onClick={() => setQuery("")}>Clear</button>}
      </div>

      {kind !== "modpack" && (
        <label className="check mods-compat">
          <input type="checkbox" checked={onlyCompat} onChange={(e) => setOnlyCompat(e.target.checked)} />
          Only show {kind === "mod" ? "mods" : kind === "resourcepack" ? "resource packs" : "shader packs"} for {inst ? `${inst.name} (Minecraft ${inst.mc}${kind === "mod" ? ` · ${cap(inst.loader)}` : ""})` : "the selected instance"}
        </label>
      )}
      {kind === "mod" && !canMods && (
        <div className="err">Select a Fabric, Quilt, Forge or NeoForge instance on the Home page first. Vanilla instances can't use mods.</div>
      )}
      {kind === "modpack" && <p className="hint">Installing a modpack creates a new instance with its own folder.</p>}
      {kind !== "modpack" && !inst && (
        <div className="err">Select an instance on the Home page before installing {kind === "mod" ? "mods" : kind === "resourcepack" ? "resource packs" : "shader packs"}.</div>
      )}
      {needKey && (
        <div className="err">
          CurseForge needs a free API key. Get one at console.curseforge.com and paste it in Settings.{" "}
          <button className="mini" onClick={goSettings}>Open Settings</button>
        </div>
      )}
      {err && <div className="err">{err}</div>}

      <div className="mods-results">
        <span>{loading ? "Searching..." : `${total.toLocaleString()} results`}</span>
        {loading && <span className="mods-searching"><i /> Updating results</span>}
      </div>
      <div className="mgrid">
        {hits.map((h) => {
          const key = keyOf(h);
          const t = taskFor(h);
          const isRunning = t?.phase === "running";
          const isError = t?.phase === "error";
          const files = done[key];
          const isInstalled = !isRunning && !isError && kind !== "modpack" && !!files && files.length > 0;
          const isOpen = !!expanded[key];
          const root = files?.find((f) => !f.dependency) ?? files?.[0];
          const deps = files?.filter((f) => f.dependency) ?? [];

          return (
            <div className="mcard" key={h.id}>
              <div className="mcardtop">
                <img className="micon" src={h.icon} width={56} height={56} alt=""
                  onError={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = "hidden")} />
                <div className="mcardmeta">
                  <b>{h.title}</b>
                  <span>by {h.author}</span>
                </div>
                {isInstalled && root && (
                  <span className={"chpill " + root.channel}>{chLabel(root.channel)}</span>
                )}
              </div>
              <p className="mdesc">{h.summary}</p>

              {isInstalled && isOpen && files && (
                <div className="filelist">
                  {files.map((f) => (
                    <div className="fileitem" key={f.project_id}>
                      <span className={"chdot " + f.channel} title={chLabel(f.channel)} />
                      <div className="fileinfo">
                        <b>{f.project_name}</b>
                        <span>{f.file_name}{f.version ? ` · v${f.version}` : ""}</span>
                      </div>
                      {f.dependency && <span className="deptag">dependency</span>}
                    </div>
                  ))}
                </div>
              )}

              <div className="mcardfoot">
                <span className="dlcount">⬇ {fmt(h.downloads)}</span>
                {isRunning ? (
                  <div className="mcardprog">
                    <div className={"pbar slim" + (t!.pct == null ? " indeterminate" : "")}>
                      <span style={t!.pct != null ? { width: `${t!.pct}%` } : undefined} />
                    </div>
                    {t!.pct != null && <span className="dlfpct">{t!.pct}%</span>}
                  </div>
                ) : isError ? (
                  <button className="mini danger" onClick={() => doInstall(h)}>Retry</button>
                ) : isInstalled ? (
                  <button className="badge badgebtn" onClick={() => toggle(key)}>
                    ✓ {files!.length} file{files!.length === 1 ? "" : "s"}{deps.length ? ` (${deps.length} dep${deps.length === 1 ? "" : "s"})` : ""}
                    {" "}{isOpen ? "▾" : "▸"}
                  </button>
                ) : (
                  <button className="mini" disabled={(kind === "mod" && !canMods) || (kind !== "modpack" && !inst)}
                    onClick={() => (kind === "modpack" ? doInstall(h) : openPicker(h))}>
                    {kind === "modpack" ? "Install pack" : "Install"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!loading && hits.length === 0 && !err && !needKey && <p className="hint">No results.</p>}
      {!loading && hits.length > 0 && hits.length < total && (
        <button className="mini loadmore" onClick={() => search(hits.length, true)}>Load more</button>
      )}

      {picker && (() => {
        return (
          <>
            <div className="scrim popfade" onClick={closePicker} />
            <div className="verpicker pop">
              <div className="vpicktop">
                <img className="micon" src={picker.icon} width={40} height={40} alt=""
                  onError={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = "hidden")} />
                <b>{picker.title}</b>
                <button className="mini" onClick={closePicker}>✕</button>
              </div>
                <div className="seg">
                  <button className={verMode === "latest" ? "on" : ""} onClick={() => setVerMode("latest")}>Latest compatible</button>
                  <button className={verMode === "pick" ? "on" : ""} onClick={() => setVerMode("pick")}>Choose a version</button>
                </div>

                {verMode === "latest" ? (
                  <p className="hint">
                    Installs the newest version that fits {inst ? `${inst.name} (Minecraft ${inst.mc} · ${cap(inst.loader)})` : "your instance"}.
                  </p>
                ) : (<>
                  <div className="seg">
                    {(["all", "release", "beta", "alpha"] as const).map((c) => (
                      <button key={c} className={verChannel === c ? "on" : ""} onClick={() => { setVerChannel(c); setVerShown(25); }}>
                        {c === "all" ? "All" : chLabel(c)}
                      </button>
                    ))}
                  </div>
                  {verErr && <div className="err">{verErr}</div>}
                  {(() => {
                    const matching = verList.filter((v) => verChannel === "all" || v.channel === verChannel);
                    const shown = matching.slice(0, verShown);
                    return (
                      <>
                        <div className="vlist verpick">
                          {verLoading && <p className="hint">Loading versions...</p>}
                          {!verLoading && shown.map((v) => (
                            <button key={v.id} className={"vprow " + v.channel + (v.id === verChosen ? " on" : "")}
                              onClick={() => setVerChosen(v.id)}>
                              <span className={"chdot " + v.channel} />
                              <div className="vprowinfo">
                                <b>{v.name || v.id}</b>
                                <span>{v.game_versions[0] ? `Minecraft ${v.game_versions[0]}` : "\u00A0"}</span>
                              </div>
                              <span className="vprowch">{chLabel(v.channel)}</span>
                              {v.id === verChosen && <span className="vprowcheck">✓</span>}
                            </button>
                          ))}
                          {!verLoading && !verErr && matching.length === 0 && (
                            <p className="hint">No versions in this channel.</p>
                          )}
                        </div>
                        {!verLoading && matching.length > shown.length && (
                          <button className="mini loadmore" onClick={() => setVerShown((n) => n + 25)}>
                            Load more ({matching.length - shown.length} left)
                          </button>
                        )}
                      </>
                    );
                  })()}
                </>)}

                <div className="btnrow">
                  <button className="mini" onClick={closePicker}>Cancel</button>
                  <button className="btn purple addbtn" disabled={(kind === "mod" && !canMods) || (kind !== "modpack" && !inst) || (verMode === "pick" && !verChosen)} onClick={confirmInstall}>
                    Download
                  </button>
                </div>
            </div>
          </>
        );
      })()}
    </section>
  );
}