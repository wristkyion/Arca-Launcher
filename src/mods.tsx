import { useEffect, useState, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { taskKey, useDownloads } from "./downloads";

type CSSVars = CSSProperties & { [key: `--${string}`]: string | number };

export type Inst = {
  id: string;
  name: string;
  loader: string;
  mc: string;
  version_id: string;
  icon: string;
  description?: string;
  background?: string;
};
type Hit = {
  id: string;
  title: string;
  summary: string;
  icon: string;
  thumbnail: string;
  categories: string[];
  downloads: number;
  follows?: number | null;
  author: string;
  url: string;
  updated: string;
  game_versions: string[];
  loaders: string[];
  client_side?: string | null;
  server_side?: string | null;
};
type Res = { hits: Hit[]; total: number };
type GameVersion = { version: string; version_type: string };
type VersionHit = { id: string; name: string; channel: string; game_versions: string[]; loaders: string[]; date: string };
type ProjectDetails = Hit & {
  description: string;
  published: string;
  license: string;
  categories: string[];
  gallery: string[];
};
type ViewMode = "grid" | "list";
type Environment = "any" | "client" | "server" | "both";

type Props = {
  inst: Inst | null;
  java: string;
  javaMode: "system" | "custom";
  showSnapshots: boolean;
  showExperimental: boolean;
  showBeta: boolean;
  showAlpha: boolean;
  onPackInstalled: (list: Inst[]) => void;
  active: boolean;
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const fmt = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n));
const chLabel = (ch: string) => (ch === "release" ? "Release" : ch === "beta" ? "Beta" : ch === "alpha" ? "Alpha" : cap(ch));
const loaders = ["fabric", "forge", "neoforge", "quilt"];
const DOWNLOADER_ICON = new URL("../assets/icons/downloader.svg", import.meta.url).href;
const GRID_ICON = new URL("../assets/icons/grid.svg", import.meta.url).href;
const ROW_ICON = new URL("../assets/icons/row.svg", import.meta.url).href;
const SOURCE_ICONS = {
  modrinth: new URL("../assets/icons/modrinth.svg", import.meta.url).href,
  curseforge: new URL("../assets/icons/curseforge.svg", import.meta.url).href,
};
const CONTENT_TYPES = [
  { type: "mod", label: "Mods", icon: new URL("../assets/icons/mods.svg", import.meta.url).href },
  { type: "modpack", label: "Modpacks", icon: new URL("../assets/icons/resourcepack.svg", import.meta.url).href },
  { type: "resourcepack", label: "Resource Packs", icon: new URL("../assets/icons/texture.svg", import.meta.url).href },
  { type: "shader", label: "Shaders", icon: new URL("../assets/icons/shaders.svg", import.meta.url).href },
] as const;
const isExperimentalGameVersion = (version: string) =>
  /combat|experimental|infinite|oneblock|a_or_b|potato|craftmine|rv-|shareware|trendy/i.test(version);
const shortDate = (date: string) => {
  if (!date) return "";
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleDateString();
};

function storedViewMode(): ViewMode {
  try {
    return localStorage.getItem("arca-downloader-view") === "list" ? "list" : "grid";
  } catch (error) {
    console.warn("Could not read downloader view preference", error);
    return "grid";
  }
}

function safeProjectDescription(source: string, value: string) {
  const html = source === "curseforge"
    ? value
    : marked.parse(value, { async: false, gfm: true });
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["iframe", "object", "embed"],
    FORBID_ATTR: ["style"],
  });
  const parsed = new DOMParser().parseFromString(clean, "text/html");
  parsed.body.querySelectorAll("a").forEach((link) => {
    const href = link.getAttribute("href");
    if (href && /^https?:\/\//i.test(href)) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    } else {
      link.removeAttribute("href");
    }
  });
  return parsed.body.innerHTML;
}

export default function ModsPage({
  inst,
  java,
  javaMode,
  showSnapshots,
  showExperimental,
  showBeta,
  showAlpha,
  onPackInstalled,
  active,
}: Props) {
  const { tasks, done, install, refreshInstalled } = useDownloads();

  const [source, setSource] = useState<"modrinth" | "curseforge">("modrinth");
  const [kind, setKind] = useState<"mod" | "modpack" | "resourcepack" | "shader">("mod");
  const [sort, setSort] = useState<"relevance" | "downloads" | "updated">("relevance");
  const [query, setQuery] = useState("");
  const [onlyCompat, setOnlyCompat] = useState(true);
  const [filterLoader, setFilterLoader] = useState("");
  const [filterMinecraft, setFilterMinecraft] = useState("");
  const [environment, setEnvironment] = useState<Environment>("any");
  const [viewMode, setViewMode] = useState<ViewMode>(storedViewMode);
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const [hits, setHits] = useState<Hit[]>([]);
  const [gameVersions, setGameVersions] = useState<GameVersion[]>([]);
  const [gameVersionsLoaded, setGameVersionsLoaded] = useState(false);
  const [gameVersionsError, setGameVersionsError] = useState("");
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingOverlayVisible, setLoadingOverlayVisible] = useState(false);
  const [loadingOverlayExiting, setLoadingOverlayExiting] = useState(false);
  const [err, setErr] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [detailsProject, setDetailsProject] = useState<Hit | null>(null);
  const [details, setDetails] = useState<ProjectDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const reqId = useRef(0);
  const detailsReqId = useRef(0);

  // version picker
  const [picker, setPicker] = useState<Hit | null>(null);
  const [verMode, setVerMode] = useState<"latest" | "pick">("latest");
  const [verChannel, setVerChannel] = useState<"all" | "release" | "beta" | "alpha">("all");
  const [verLoader, setVerLoader] = useState("all");
  const [verMinecraft, setVerMinecraft] = useState("all");
  const [verList, setVerList] = useState<VersionHit[]>([]);
  const [verLoading, setVerLoading] = useState(false);
  const [verErr, setVerErr] = useState("");
  const [verChosen, setVerChosen] = useState<string | null>(null);
  const [verShown, setVerShown] = useState(25);
  const verReqId = useRef(0);

  const canMods = !!inst && inst.loader !== "vanilla";
  const filterMc = kind !== "modpack"
    ? filterMinecraft === "any" ? "" : filterMinecraft || (onlyCompat && inst ? inst.mc : "")
    : "";
  const selectedLoader = filterLoader === "all"
    ? ""
    : filterLoader || (kind === "mod" && onlyCompat && canMods ? inst!.loader : "");
  const selectableGameVersions = useMemo(() => gameVersions.filter(({ version, version_type }) => {
    const type = version_type.toLowerCase();
    if (type === "release") return true;
    if (type === "snapshot" && isExperimentalGameVersion(version)) return showExperimental;
    if (type === "snapshot") return showSnapshots;
    if (type === "beta" || type === "old_beta") return showBeta;
    if (type === "alpha" || type === "old_alpha") return showAlpha;
    return false;
  }), [gameVersions, showSnapshots, showExperimental, showBeta, showAlpha]);
  const detailsDescription = useMemo(
    () => details ? safeProjectDescription(source, details.description || details.summary) : "",
    [details, source],
  );

  const search = async (offset: number) => {
    const id = ++reqId.current;
    const startedAt = performance.now();
    setLoading(true);
    setErr("");
    setHits([]);
    setTotal(0);
    try {
      const r = await invoke<Res>("mod_search", {
        req: {
          source,
          kind,
          query,
          sort,
          mc: filterMc,
          loader: selectedLoader,
          environment: source === "modrinth" ? environment : "any",
          offset,
          limit: pageSize,
        },
      });
      if (id !== reqId.current) return;
      setHits(r.hits);
      setTotal(r.total);
    } catch (e) {
      if (id === reqId.current) setErr(String(e));
    } finally {
      if (id === reqId.current) {
        const remaining = 900 - (performance.now() - startedAt);
        if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining));
        if (id === reqId.current) setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (loading) {
      setLoadingOverlayVisible(true);
      setLoadingOverlayExiting(false);
      return;
    }
    if (!loadingOverlayVisible) return;
    setLoadingOverlayExiting(true);
    const timer = window.setTimeout(() => {
      setLoadingOverlayVisible(false);
      setLoadingOverlayExiting(false);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [loading, loadingOverlayVisible]);

  useEffect(() => {
    setPage(1);
  }, [source, kind, query, sort, onlyCompat, filterLoader, filterMinecraft, environment, pageSize, inst?.mc, inst?.loader]);

  useEffect(() => {
    if (gameVersionsLoaded && filterMinecraft && filterMinecraft !== "any" &&
        !selectableGameVersions.some(({ version }) => version === filterMinecraft)) {
      setFilterMinecraft("");
    }
  }, [filterMinecraft, gameVersionsLoaded, selectableGameVersions]);

  useEffect(() => {
    let active = true;
    invoke<GameVersion[]>("mod_game_versions")
      .then((versions) => {
        if (active) {
          setGameVersions(versions);
          setGameVersionsLoaded(true);
          setGameVersionsError("");
        }
      })
      .catch((error) => {
        if (active) setGameVersionsError(`Could not load Minecraft versions: ${error}`);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      void search((page - 1) * pageSize);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, kind, query, sort, onlyCompat, filterLoader, filterMinecraft, environment, page, pageSize, inst?.id, inst?.mc, inst?.loader]);

  useEffect(() => {
    try {
      localStorage.setItem("arca-downloader-view", viewMode);
    } catch (error) {
      console.warn("Could not save downloader view preference", error);
    }
  }, [viewMode]);

  useEffect(() => {
    if (!detailsProject) return;
    let active = true;
    const id = ++detailsReqId.current;
    setDetails(null);
    setDetailsLoading(true);
    setDetailsError("");
    void invoke<ProjectDetails>("mod_project_details", { req: { source, id: detailsProject.id } })
      .then((project) => {
        if (active && id === detailsReqId.current) setDetails(project);
      })
      .catch((error) => {
        if (active && id === detailsReqId.current) setDetailsError(String(error));
      })
      .finally(() => {
        if (active && id === detailsReqId.current) setDetailsLoading(false);
      });
    return () => { active = false; };
  }, [detailsProject, source]);

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
    invoke<VersionHit[]>("mod_versions", { req: { source, id: picker.id } })
      .then((v) => { if (id === verReqId.current) setVerList(v); })
      .catch((e) => { if (id === verReqId.current) setVerErr(String(e)); })
      .finally(() => { if (id === verReqId.current) setVerLoading(false); });
  }, [picker, verMode, source]);

  const keyOf = (h: Hit) => taskKey(kind === "modpack" ? undefined : inst?.id, source, h.id, kind);
  const taskFor = (h: Hit) => tasks.find((t) => t.key === keyOf(h));

  const doInstall = (h: Hit) => {
    install({
      source, kind, id: h.id, title: h.title, icon: h.icon,
      description: kind === "modpack" ? h.summary : undefined,
      backgroundUrl: kind === "modpack" ? h.thumbnail : undefined,
      instanceId: inst?.id, java, javaMode, onPackInstalled,
    });
  };

  const openPicker = (h: Hit) => {
    setPicker(h); setVerMode("latest"); setVerChannel("all");
    setVerLoader("all"); setVerMinecraft("all");
    setVerList([]); setVerErr(""); setVerChosen(null); setVerShown(25);
  };
  const closePicker = () => setPicker(null);
  const selectedVersion = verList.find((version) => version.id === verChosen);
  const compatibleWithInstance = !selectedVersion || kind !== "mod" || !inst || (
    (!selectedVersion.game_versions.length || selectedVersion.game_versions.includes(inst.mc)) &&
    (!selectedVersion.loaders.length || selectedVersion.loaders.includes(inst.loader))
  );
  const confirmInstall = () => {
    if (!picker) return;
    install({
      source, kind, id: picker.id, title: picker.title, icon: picker.icon,
      instanceId: inst?.id, java, javaMode, onPackInstalled,
      versionId: verMode === "pick" ? (verChosen ?? undefined) : undefined,
    });
    closePicker();
  };

  const toggle = (key: string) => setExpanded((e) => ({ ...e, [key]: !e[key] }));

  return (
    <section className="mods-workspace">
      <aside className="mods-sidebar">
        <div className="mods-side-section">
          <span className="mods-side-label">SELECTION</span>
          <nav className="mods-types" aria-label="Content type">
            {CONTENT_TYPES.map(({ type, icon, label }) => (
              <button key={type} className={kind === type ? "on" : ""} onClick={() => setKind(type)}>
                <img src={icon} alt="" />{label}
              </button>
            ))}
          </nav>
        </div>
        <div className="mods-side-section">
          <span className="mods-side-label">SOURCE</span>
          <div className="mods-sources" aria-label="Content source">
            <button className={source === "modrinth" ? "on" : ""} onClick={() => { setSource("modrinth"); setDetailsProject(null); }}>
              <img src={SOURCE_ICONS.modrinth} alt="" />Modrinth
            </button>
            <button className={source === "curseforge" ? "on" : ""} onClick={() => { setSource("curseforge"); setEnvironment("any"); setDetailsProject(null); }}>
              <img src={SOURCE_ICONS.curseforge} alt="" />CurseForge
            </button>
          </div>
        </div>
        <div className="mods-side-section mods-side-filters">
          <div className="mods-side-filter-title"><span className="mods-side-label">FILTERS</span>
            {(filterLoader || filterMinecraft || environment !== "any") && <button onClick={() => {
              setFilterLoader(""); setFilterMinecraft(""); setEnvironment("any");
            }}>Reset</button>}
          </div>
          {kind !== "modpack" && (
            <label className="mods-compat">
              <input type="checkbox" checked={onlyCompat} onChange={(e) => setOnlyCompat(e.target.checked)} />
              <span><b>Compatible only</b><small>{inst ? `${inst.name} · ${inst.mc}` : "Selected instance"}</small></span>
            </label>
          )}
          {kind === "mod" && (
            <label className="mods-sidebar-control">Modloader
              <select value={filterLoader} onChange={(e) => setFilterLoader(e.target.value)}>
                <option value="">Instance default</option>
                <option value="all">Any loader</option>
                {loaders.map((loader) => <option value={loader} key={loader}>{cap(loader)}</option>)}
              </select>
            </label>
          )}
          {kind !== "modpack" && (
            <label className="mods-sidebar-control">Minecraft version
              <select value={filterMinecraft || ""} onChange={(e) => setFilterMinecraft(e.target.value)}>
                <option value="">Instance default{onlyCompat && inst ? ` (${inst.mc})` : ""}</option>
                <option value="any">Any version</option>
                {selectableGameVersions.map(({ version }) => <option value={version} key={version}>{version}</option>)}
              </select>
              {gameVersionsError && <small className="mods-version-error">{gameVersionsError}</small>}
            </label>
          )}
          {source === "modrinth" && (
            <label className="mods-sidebar-control">Environment
              <select value={environment} onChange={(e) => setEnvironment(e.target.value as Environment)}>
                <option value="any">Any environment</option>
                <option value="client">Client compatible</option>
                <option value="server">Server compatible</option>
                <option value="both">Client and server</option>
              </select>
            </label>
          )}
        </div>
        <div className="mods-sidebar-instance">
          <span className="mods-instance-dot" />
          <span><b>{inst?.name || "No instance selected"}</b><small>{inst ? `${cap(inst.loader)} · ${inst.mc}` : "Choose an instance to install"}</small></span>
        </div>
      </aside>
      <div className="mods-content">
        <div className="mods-sticky-bar">
        <header className="mods-page-head">
          <div><span className="mods-eyebrow mods-source-eyebrow"><img src={SOURCE_ICONS[source]} alt="" />{cap(source)} · DISCOVER</span>
            <h2>{kind === "resourcepack" ? "Resource Packs" : kind === "shader" ? "Shader Packs" : `${cap(kind)}s`}</h2>
            <p>Find something new for your next world.</p>
          </div>
          <div className="mods-head-controls">
            <label className="mods-sort"><span>Sort</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
                <option value="relevance">Relevance</option><option value="downloads">Most downloaded</option><option value="updated">Recently updated</option>
              </select>
            </label>
            <label className="mods-sort mods-page-size"><span>Show</span>
              <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                {[20, 50, 100].map((size) => <option value={size} key={size}>{size}</option>)}
              </select>
            </label>
            <div className="mods-viewtoggle" aria-label="Result layout">
              <button className={viewMode === "grid" ? "on" : ""} onClick={() => setViewMode("grid")} aria-label="Grid view">
                <img src={GRID_ICON} alt="" />
              </button>
              <button className={viewMode === "list" ? "on" : ""} onClick={() => setViewMode("list")} aria-label="List view">
                <img src={ROW_ICON} alt="" />
              </button>
            </div>
          </div>
        </header>
        <div className="mods-searchwrap">
          <span aria-hidden="true">⌕</span>
          <input className="mods-search" placeholder={`Search ${kind === "shader" ? "shader packs" : kind === "resourcepack" ? "resource packs" : kind === "modpack" ? "modpacks" : "mods"}...`} value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && <button className="mini" onClick={() => setQuery("")}>Clear</button>}
        </div>
      <div className="mods-resultbar">
        <div><b>{loading ? "Searching..." : total.toLocaleString()}</b><span>{loading ? "projects" : "projects found"}</span></div>
        {loading && <span className="mods-searching"><i /> Updating</span>}
      </div>
        {(filterLoader || (filterMinecraft && filterMinecraft !== "any") || environment !== "any") && (
          <div className="mods-filterchips">
            {filterLoader && <button onClick={() => setFilterLoader("")}>Loader · {filterLoader === "all" ? "Any" : cap(filterLoader)} ×</button>}
            {filterMinecraft && <button onClick={() => setFilterMinecraft("")}>Minecraft · {filterMinecraft === "any" ? "Any" : filterMinecraft} ×</button>}
            {environment !== "any" && <button onClick={() => setEnvironment("any")}>Environment · {cap(environment)} ×</button>}
          </div>
        )}
        </div>
        {kind === "mod" && !canMods && (
          <div className="err">Select a Fabric, Quilt, Forge or NeoForge instance on the Home page first. Vanilla instances can't use mods.</div>
        )}
        {kind === "modpack" && <p className="hint">Installing a modpack creates a new instance with its own folder.</p>}
        {kind !== "modpack" && !inst && (
          <div className="err">Select an instance on the Home page before installing {kind === "mod" ? "mods" : kind === "resourcepack" ? "resource packs" : "shader packs"}.</div>
        )}
        {err && <div className="err">{err}</div>}
      <div className="mods-results-area">
      {loadingOverlayVisible && (
        <div className={`library-loading-overlay mods-loading-overlay${loadingOverlayExiting ? " is-exiting" : ""}`} role="status" aria-label="Searching projects">
          <span className="library-loading-spinner" aria-hidden="true" />
        </div>
      )}
      <div className={`mgrid ${viewMode === "list" ? "mods-list" : ""}`}>
        {hits.map((h, index) => {
          const key = keyOf(h);
          const t = taskFor(h);
          const isRunning = t?.phase === "running" || t?.phase === "queued" || t?.phase === "cancelling";
          const isError = t?.phase === "error";
          const files = done[key];
          const isInstalled = !isRunning && !isError && kind !== "modpack" && !!files && files.length > 0;
          const isOpen = !!expanded[key];
          const root = files?.find((f) => !f.dependency) ?? files?.[0];
          const deps = files?.filter((f) => f.dependency) ?? [];

          return (
            <article className={`mcard animate-stagger${h.thumbnail ? "" : " mods-card-no-thumbnail"}`} key={h.id} style={{ animationDelay: `${Math.min(index, 20) * 0.03}s` }}>
              {h.thumbnail && (
                <div className="mods-card-media" aria-hidden="true">
                  <img className="mods-card-thumbnail" src={h.thumbnail} alt="" loading="lazy"
                    onLoad={(e) => e.currentTarget.parentElement?.classList.add("loaded")}
                    onError={(e) => e.currentTarget.parentElement?.remove()} />
                </div>
              )}
              <div className="mcardtop">
                {h.icon && <img className="micon" src={h.icon} width={56} height={56} alt=""
                  onError={(e) => e.currentTarget.classList.add("is-hidden")} />
                }
                <div className="mcardmeta">
                  <button className="mods-card-title" onClick={() => setDetailsProject(h)}>{h.title}</button>
                  <span>by {h.author || "Unknown author"}</span>
                </div>
                {isInstalled && root && (
                  <span className={"chpill " + root.channel}>{chLabel(root.channel)}</span>
                )}
              </div>
              <p className="mdesc">{h.summary}</p>
              {!!h.categories.length && <div className="mods-card-tags">
                {h.categories.slice(0, 3).map((category) => <span key={category}>{cap(category.replace(/-/g, " "))}</span>)}
                {h.categories.length > 3 && <span>+{h.categories.length - 3}</span>}
              </div>}
              <div className="mods-card-compat">
                {h.game_versions.slice(0, 2).map((version) => <span key={version}>{version}</span>)}
                {h.loaders.slice(0, 2).map((loader) => <span key={loader}>{cap(loader)}</span>)}
              </div>

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
                <div className="mods-card-stats">
                  <span className="dlcount"><i>↓</i>{fmt(h.downloads)}</span>
                  {h.follows != null && <span className="dlcount"><i>♡</i>{fmt(h.follows)}</span>}
                </div>
                <span className="mods-card-updated">{h.updated ? shortDate(h.updated) : ""}</span>
                <button className="mods-detail-button" onClick={() => setDetailsProject(h)}>Details</button>
                {isRunning ? (
                  <div className="mcardprog">
                    <div className={"pbar slim" + (t!.pct == null ? " indeterminate" : "")}>
                      <span style={t!.pct != null ? { "--progress-width": `${t!.pct}%` } as CSSVars : undefined} />
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
                  <button className="mini mods-install-button" disabled={(kind === "mod" && !canMods) || (kind !== "modpack" && !inst)}
                    onClick={() => (kind === "modpack" ? doInstall(h) : openPicker(h))}>
                    <img src={DOWNLOADER_ICON} alt="" />{kind === "modpack" ? "Install pack" : "Install"}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {!loading && hits.length === 0 && !err && <p className="hint">No results.</p>}
      {!loading && total > pageSize && (
        <nav className="mods-pagination" aria-label="Search result pages">
          <button className="mini" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button>
          <span>{((page - 1) * pageSize + 1).toLocaleString()}–{Math.min(page * pageSize, total).toLocaleString()} of {total.toLocaleString()}</span>
          <button className="mini" disabled={page >= Math.ceil(total / pageSize)} onClick={() => setPage((current) => current + 1)}>Next</button>
        </nav>
      )}
      </div>
      </div>

      {detailsProject && (() => {
        const portals = document.getElementById("portals");
        if (!portals) return null;
        const project = details ?? detailsProject;
        return createPortal(
          <>
            <div className="scrim popfade" onClick={() => setDetailsProject(null)} />
            <section className="mods-detail-modal pop" role="dialog" aria-modal="true" aria-label={`${project.title} project details`}>
              <header className="mods-detail-head">
                <div className="mods-detail-title">
                  {project.icon && <img className="micon" src={project.icon} width={52} height={52} alt="" />}
                  <div><span className="mods-eyebrow mods-source-eyebrow"><img src={SOURCE_ICONS[source]} alt="" />{cap(source)} PROJECT</span><h2>{project.title}</h2><p>by {project.author || detailsProject.author || "Unknown author"}</p></div>
                </div>
              </header>
              {detailsLoading && <div className="hint">Loading full project details...</div>}
              {detailsError && <div className="err">{detailsError}</div>}
              {!detailsLoading && !detailsError && details && (
                <>
                  <div className="mods-detail-stats">
                    <span>⬇ {fmt(details.downloads)} downloads</span>
                    {details.follows != null && <span>♥ {fmt(details.follows)} followers</span>}
                    {details.published && <span>Published {shortDate(details.published)}</span>}
                    {details.updated && <span>Updated {shortDate(details.updated)}</span>}
                  </div>
                  <p className="mods-detail-summary">{details.summary}</p>
                  <div className="mods-detail-meta">
                    {details.license && <span><b>License</b>{details.license}</span>}
                    {!!details.categories.length && <span><b>Categories</b>{details.categories.join(", ")}</span>}
                    {!!details.game_versions.length && <span><b>Minecraft</b>{details.game_versions.slice(0, 12).join(", ")}{details.game_versions.length > 12 ? ` +${details.game_versions.length - 12}` : ""}</span>}
                    {!!details.loaders.length && <span><b>Loaders</b>{details.loaders.map(cap).join(", ")}</span>}
                    {source === "modrinth" && <span><b>Environment</b>Client: {details.client_side || "unknown"} · Server: {details.server_side || "unknown"}</span>}
                  </div>
                  {details.gallery.length > 0 && (
                    <div className="mods-gallery">
                      {details.gallery.map((image, index) => <img src={image} alt={`${details.title} screenshot ${index + 1}`} key={`${image}-${index}`} loading="lazy" />)}
                    </div>
                  )}
                  <div className="mods-detail-description">
                    <h3>Description</h3>
                    <div className="mods-markdown" dangerouslySetInnerHTML={{ __html: detailsDescription || "<p>No description provided.</p>" }} />
                  </div>
                </>
              )}
              {details && <footer className="mods-detail-actions">
                <a className="mini" href={details.url || detailsProject.url} target="_blank" rel="noreferrer">Open on {cap(source)}</a>
                <button className="mini" disabled={(kind === "mod" && !canMods) || (kind !== "modpack" && !inst)} onClick={() => {
                  setDetailsProject(null);
                  if (kind === "modpack") doInstall(detailsProject);
                  else openPicker(detailsProject);
                }}>
                  {kind === "modpack" ? "Install pack" : "Choose version"}
                </button>
              </footer>}
            </section>
          </>,
          portals,
        );
      })()}

      {picker && (() => {
        const portals = document.getElementById("portals");
        if (!portals) return null;
        
        return createPortal(
          <>
            <div className="scrim popfade" onClick={closePicker} />
            <div className="verpicker pop">
              <div className="vpicktop">
                <img className="micon" src={picker.icon} width={40} height={40} alt=""
                  onError={(e) => e.currentTarget.classList.add("is-hidden")} />
                <b>{picker.title}</b>
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
                      <button key={c} className={verChannel === c ? "on" : ""} onClick={() => { setVerChannel(c); setVerShown(25); setVerChosen(null); }}>
                        {c === "all" ? "All" : chLabel(c)}
                      </button>
                    ))}
                  </div>
                  {kind === "mod" && (
                    <div className="picker-filters">
                      <label>Modloader
                        <select value={verLoader} onChange={(e) => { setVerLoader(e.target.value); setVerShown(25); setVerChosen(null); }}>
                          <option value="all">All loaders</option>
                          <option value="forge">Forge</option>
                          <option value="fabric">Fabric</option>
                          <option value="quilt">Quilt</option>
                          <option value="neoforge">NeoForge</option>
                        </select>
                      </label>
                      <label>Minecraft version
                        <select value={verMinecraft} onChange={(e) => { setVerMinecraft(e.target.value); setVerShown(25); setVerChosen(null); }}>
                          <option value="all">All versions</option>
                          {[...new Set(verList.flatMap((version) => version.game_versions))].map((version) => (
                            <option value={version} key={version}>{version}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                  {kind === "mod" && inst && (
                    <p className="picker-target">Target: <b>{cap(inst.loader)}</b> · Minecraft {inst.mc}</p>
                  )}
                  {verErr && <div className="err">{verErr}</div>}
                  {verChosen && !compatibleWithInstance && inst && kind === "mod" && (
                    <div className="err">This file is not tagged for {cap(inst.loader)} on Minecraft {inst.mc}.</div>
                  )}
                  {(() => {
                    const matching = verList.filter((v) => {
                      const channelMatches = verChannel === "all" || v.channel === verChannel;
                      const mcMatches = verMinecraft === "all" || v.game_versions.includes(verMinecraft);
                      const loaderMatches = verLoader === "all" || v.loaders.includes(verLoader);
                      return channelMatches && mcMatches && loaderMatches;
                    });
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
                                <div className="vprow-meta">
                                  <span className="vprow-mc">{kind === "mod" && inst
                                    ? `Minecraft ${v.game_versions.length ? v.game_versions.slice(0, 2).join(", ") : "not listed"}${v.game_versions.length > 2 ? ` +${v.game_versions.length - 2}` : ""}`
                                    : v.game_versions.length
                                      ? `Minecraft ${v.game_versions.slice(0, 2).join(", ")}${v.game_versions.length > 2 ? ` +${v.game_versions.length - 2}` : ""}`
                                      : "Minecraft version not listed"}</span>
                                  {kind === "mod" && (v.loaders.length
                                    ? v.loaders.map((loader) => <span key={loader} className={`vloader-tag ${loader}`}>{cap(loader)}</span>)
                                    : <span className="vloader-tag unknown">Loader not listed</span>)}
                                </div>
                              </div>
                              <span className="vprowch">{chLabel(v.channel)}</span>
                              {v.id === verChosen && <span className="vprowcheck">✓</span>}
                            </button>
                          ))}
                          {!verLoading && !verErr && matching.length === 0 && (
                            <p className="hint">No versions match these filters.</p>
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
                  <button className="btn purple addbtn" disabled={(kind === "mod" && !canMods) || (kind !== "modpack" && !inst) || (verMode === "pick" && (!verChosen || !compatibleWithInstance))} onClick={confirmInstall}>
                    Download
                  </button>
                </div>
            </div>
          </>,
          portals
        );
      })()}
    </section>
  );
}