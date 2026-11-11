import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Inst } from "./mods";
import { useDownloads } from "./downloads";

type Item = {
  name: string;
  file_name: string;
  enabled: boolean;
  size: number;
  icon: string;
  source: string;
  version: string;
  channel: string;
  dependency: boolean;
  description: string;
};
type Kind = "mods" | "resourcepacks" | "shaderpacks" | "screenshots" | "worlds" | "playtime";
type Screenshot = { name: string; data_url: string };
type World = { name: string; icon: string; modified: number };
type Playtime = { total_seconds: number; days: { date: string; seconds: number }[] };

const KINDS: { key: Kind; label: string; singular: string; description: string }[] = [
  { key: "mods", label: "Mods", singular: "mod", description: "Manage the mods installed in this instance." },
  { key: "resourcepacks", label: "Resource Packs", singular: "resource pack", description: "Change the look and sounds of Minecraft." },
  { key: "shaderpacks", label: "Shader Packs", singular: "shader pack", description: "Manage visual effects and shaders." },
  { key: "screenshots", label: "Screenshots", singular: "screenshot", description: "Browse screenshots captured in this instance." },
  { key: "worlds", label: "Worlds", singular: "world", description: "View your saved Minecraft worlds." },
  { key: "playtime", label: "Playtime", singular: "session", description: "Review time spent playing this instance." },
];

const CONTENT_ICONS: Record<Kind, string> = {
  mods: new URL("../assets/icons/mods.svg", import.meta.url).href,
  resourcepacks: new URL("../assets/icons/texture.svg", import.meta.url).href,
  shaderpacks: new URL("../assets/icons/shaders.svg", import.meta.url).href,
  screenshots: new URL("../assets/icons/texture.svg", import.meta.url).href,
  worlds: new URL("../assets/icons/resourcepack.svg", import.meta.url).href,
  playtime: new URL("../assets/icons/game-settings.svg", import.meta.url).href,
};
const ACTION_ICONS = {
  search: new URL("../assets/icons/search.svg", import.meta.url).href,
  edit: new URL("../assets/icons/edit.svg", import.meta.url).href,
  export: new URL("../assets/icons/downloader.svg", import.meta.url).href,
  folder: new URL("../assets/icons/folder.svg", import.meta.url).href,
  back: new URL("../assets/icons/arrow-left.svg", import.meta.url).href,
  close: new URL("../assets/icons/close.svg", import.meta.url).href,
  instance: new URL("../assets/icons/resourcepack.svg", import.meta.url).href,
};
const getPortalRoot = () => document.getElementById("portals") ?? document.body;

const INSTANCE_ICONS: Record<string, string> = {
  vanilla: new URL("../assets/modifted/vanilla.jpg", import.meta.url).href,
  fabric: new URL("../assets/modifted/fabric.png", import.meta.url).href,
  quilt: new URL("../assets/modifted/quilt.png", import.meta.url).href,
  forge: new URL("../assets/modifted/forge.jpg", import.meta.url).href,
  neoforge: new URL("../assets/modifted/neoforge.png", import.meta.url).href,
};

const fmtSize = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`;

function InstanceArtwork({ inst }: { inst: Inst }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [inst.icon, inst.loader]);
  const image = !failed && inst.icon ? inst.icon : INSTANCE_ICONS[inst.loader] || ACTION_ICONS.instance;
  return <img className={"library-instance-mark" + (image === ACTION_ICONS.instance ? " library-instance-mark-fallback" : "")} src={image} alt="" onError={() => setFailed(true)} />;
}

function Artwork({ item, kind }: { item: Item; kind: Kind }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.icon]);
  if (item.icon && !failed) {
    return <img className="library-artwork" src={item.icon} alt="" onError={() => setFailed(true)} />;
  }
  return <img className={`library-artwork library-artwork-fallback ${kind}`} src={CONTENT_ICONS[kind]} alt="" />;
}

export default function ContentPage({
  inst,
  onBack,
  onEdit,
  onExport,
}: {
  inst: Inst | null;
  onBack: () => void;
  onEdit: () => void;
  onExport: (instance: Inst) => Promise<void>;
}) {
  const { refreshInstalled } = useDownloads();
  const [kind, setKind] = useState<Kind>("mods");
  const [items, setItems] = useState<Item[]>([]);
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [worlds, setWorlds] = useState<World[]>([]);
  const [playtime, setPlaytime] = useState<Playtime>({ total_seconds: 0, days: [] });
  const [selectedScreenshot, setSelectedScreenshot] = useState<Screenshot | null>(null);
  const [selectedWorld, setSelectedWorld] = useState("");
  const [nbtText, setNbtText] = useState("");
  const [originalNbtText, setOriginalNbtText] = useState("");
  const [nbtLoading, setNbtLoading] = useState(false);
  const [nbtSaving, setNbtSaving] = useState(false);
  const [nbtError, setNbtError] = useState("");
  const [nbtSaved, setNbtSaved] = useState(false);
  const [chartRange, setChartRange] = useState<7 | 30 | 90>(30);
  const [loading, setLoading] = useState(false);
  const [loadingOverlayVisible, setLoadingOverlayVisible] = useState(false);
  const [loadingOverlayExiting, setLoadingOverlayExiting] = useState(false);
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");
  const [showDisabled, setShowDisabled] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [instanceBackground, setInstanceBackground] = useState("");
  const [exporting, setExporting] = useState(false);
  const loadRequest = useRef(0);
  const nbtLoadRequest = useRef(0);
  const selectionKey = `${inst?.id ?? "none"}:${kind}`;
  const activeSelection = useRef(selectionKey);
  activeSelection.current = selectionKey;
  const selectedKind = KINDS.find((item) => item.key === kind)!;
  const chartData = useMemo(() => {
    const secondsByDate = new Map(playtime.days.map((day) => [day.date, day.seconds]));
    const today = new Date();
    const endOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    return Array.from({ length: chartRange }, (_, index) => {
      const date = new Date(endOfToday - (chartRange - index - 1) * 86400000).toISOString().slice(0, 10);
      return { date, seconds: secondsByDate.get(date) ?? 0 };
    });
  }, [chartRange, playtime.days]);
  const chartTotal = chartData.reduce((total, day) => total + day.seconds, 0);
  const chartActiveDays = chartData.filter((day) => day.seconds > 0).length;
  const chartBestDay = chartData.reduce((best, day) => day.seconds > best.seconds ? day : best, { date: "", seconds: 0 });
  const chartPeakSeconds = Math.max(...chartData.map((day) => day.seconds), 0);
  const chartStepSeconds = chartPeakSeconds <= 3600 ? 900 : chartPeakSeconds <= 7200 ? 1800 : chartPeakSeconds <= 14400 ? 3600 : chartPeakSeconds <= 28800 ? 7200 : 14400;
  const chartMaxSeconds = Math.max(chartStepSeconds * 4, Math.ceil(chartPeakSeconds / chartStepSeconds) * chartStepSeconds);
  const chartPlot = { left: 52, top: 16, width: 930, height: 174 };
  const chartBarGap = chartRange === 90 ? 2 : 4;
  const chartBarWidth = (chartPlot.width - (chartRange - 1) * chartBarGap) / chartRange;
  const formatDate = (value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const formatChartAxis = (seconds: number) => {
    if (seconds === 0) return "0";
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  };

  useEffect(() => {
    let active = true;
    setInstanceBackground("");
    if (!inst) return () => { active = false; };
    void invoke<string | null>("load_instance_background", { id: inst.id })
      .then((background) => { if (active) setInstanceBackground(background ?? ""); })
      .catch((error) => { if (active) setErr(`Could not load instance background: ${error}`); });
    return () => { active = false; };
  }, [inst]);

  const load = async (clearItems = false) => {
    const requestSelection = `${inst?.id ?? "none"}:${kind}`;
    if (activeSelection.current !== requestSelection) return;
    const request = ++loadRequest.current;
    if (!inst) {
      setItems([]);
      setErr("");
      setLoading(false);
      return;
    }
    const startedAt = performance.now();
    setLoading(true);
    setErr("");
    if (kind === "screenshots" || kind === "worlds" || kind === "playtime") {
      try {
        if (kind === "screenshots") {
          const next = await invoke<Screenshot[]>("list_instance_screenshots", { instance: inst.id });
          if (request === loadRequest.current && activeSelection.current === requestSelection) setScreenshots(next);
        }
        if (kind === "worlds") {
          const next = await invoke<World[]>("list_instance_worlds", { instance: inst.id });
          if (request === loadRequest.current && activeSelection.current === requestSelection) setWorlds(next);
        }
        if (kind === "playtime") {
          const next = await invoke<Playtime>("get_instance_playtime", { instance: inst.id });
          if (request === loadRequest.current && activeSelection.current === requestSelection) setPlaytime(next);
        }
      } catch (e) {
        if (request === loadRequest.current && activeSelection.current === requestSelection) setErr(String(e));
      } finally {
        if (request === loadRequest.current && activeSelection.current === requestSelection) setLoading(false);
      }
      return;
    }
    if (clearItems) setItems([]);
    try {
      const nextItems = await invoke<Item[]>("list_content", { req: { instance: inst.id, kind } });
      if (request === loadRequest.current && activeSelection.current === requestSelection) setItems(nextItems);
    } catch (e) {
      if (request === loadRequest.current && activeSelection.current === requestSelection) setErr(String(e));
    } finally {
      const remaining = 900 - (performance.now() - startedAt);
      if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining));
      if (request === loadRequest.current && activeSelection.current === requestSelection) setLoading(false);
    }
  };

  useEffect(() => { void load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [inst?.id, kind]);

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
  }, [loading, loadingOverlayVisible, selectionKey]);

  const selectKind = (nextKind: Kind) => {
    if (nextKind === kind) return;
    if (selectedWorld && nbtText !== originalNbtText && !window.confirm("Discard your unsaved NBT changes?")) return;
    nbtLoadRequest.current += 1;
    setSelectedWorld("");
    setSelectedScreenshot(null);
    activeSelection.current = `${inst?.id ?? "none"}:${nextKind}`;
    setItems([]);
    setLoading(true);
    setKind(nextKind);
  };

  const filtered = useMemo(() => items.filter((item) => {
    if (!showDisabled && !item.enabled) return false;
    const text = `${item.name} ${item.file_name} ${item.description} ${item.source}`.toLowerCase();
    return text.includes(query.trim().toLowerCase());
  }), [items, query, showDisabled]);
  const filteredScreenshots = useMemo(() => screenshots.filter((shot) => shot.name.toLowerCase().includes(query.trim().toLowerCase())), [screenshots, query]);
  const filteredWorlds = useMemo(() => worlds.filter((world) => world.name.toLowerCase().includes(query.trim().toLowerCase())), [worlds, query]);
  const enabledCount = items.filter((item) => item.enabled).length;
  const countForKind = (key: Kind) => key === "screenshots" ? screenshots.length : key === "worlds" ? worlds.length : key === "playtime" ? playtime.days.length : items.length;
  const isFeatureKind = kind === "screenshots" || kind === "worlds" || kind === "playtime";
  const busyOn = (file: string, value: boolean) => setBusy((current) => ({ ...current, [file]: value }));

  const toggle = async (item: Item) => {
    if (!inst) return;
    busyOn(item.file_name, true);
    try {
      const fileName = await invoke<string>("toggle_content", { req: { instance: inst.id, kind, file_name: item.file_name, enable: !item.enabled } });
      setItems((current) => current.map((entry) => entry.file_name === item.file_name
        ? { ...entry, file_name: fileName, enabled: !item.enabled }
        : entry));
    } catch (e) {
      setErr(String(e));
    } finally {
      busyOn(item.file_name, false);
    }
  };

  const remove = async (item: Item) => {
    if (!inst || !confirm(`Delete ${item.name}? This cannot be undone.`)) return;
    busyOn(item.file_name, true);
    try {
      await invoke("delete_content", { req: { instance: inst.id, kind, file_name: item.file_name } });
      await load();
      await refreshInstalled(inst.id, kind === "mods" ? "mod" : kind === "resourcepacks" ? "resourcepack" : "shader");
    } catch (e) {
      setErr(String(e));
    } finally {
      busyOn(item.file_name, false);
    }
  };

  const openFolder = () => inst && invoke("open_instance_folder", { instance: inst.id }).catch((e) => setErr(String(e)));

  const openNbt = async (world: string) => {
    if (!inst) return;
    const request = ++nbtLoadRequest.current;
    setSelectedWorld(world);
    setNbtText("");
    setOriginalNbtText("");
    setNbtError("");
    setNbtSaved(false);
    setNbtLoading(true);
    try {
      const text = await invoke<string>("read_world_nbt", { instance: inst.id, world });
      if (request === nbtLoadRequest.current) {
        setNbtText(text);
        setOriginalNbtText(text);
      }
    } catch (e) {
      if (request === nbtLoadRequest.current) setNbtError(String(e));
    } finally {
      if (request === nbtLoadRequest.current) setNbtLoading(false);
    }
  };
  const saveNbt = async () => {
    if (!inst || !selectedWorld) return;
    try {
      JSON.parse(nbtText);
    } catch (e) {
      setNbtSaved(false);
      setNbtError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setNbtSaving(true);
    setNbtError("");
    setNbtSaved(false);
    try {
      await invoke("write_world_nbt", { instance: inst.id, world: selectedWorld, json: nbtText });
      setOriginalNbtText(nbtText);
      setNbtSaved(true);
    } catch (e) {
      setNbtError(String(e));
    } finally {
      setNbtSaving(false);
    }
  };
  const closeNbt = () => {
    if (nbtText !== originalNbtText && !window.confirm("Discard your unsaved NBT changes?")) return;
    nbtLoadRequest.current += 1;
    setSelectedWorld("");
  };
  const closeScreenshot = () => setSelectedScreenshot(null);
  const formatDuration = (seconds: number) => `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;

  useEffect(() => {
    if (!selectedWorld && !selectedScreenshot) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (selectedWorld) closeNbt();
      else closeScreenshot();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedWorld, selectedScreenshot, nbtText, originalNbtText]);

  return (
    <section className="library-workspace">
      <aside className="library-sidebar">
        <div className="library-side-section">
          <span className="library-side-label">SELECTION</span>
          <nav className="library-types" role="tablist" aria-label="Installed content type">
            {KINDS.map((tab) => (
              <button key={tab.key} role="tab" aria-selected={kind === tab.key} className={kind === tab.key ? "on" : ""} onClick={() => selectKind(tab.key)}>
                <img className={`library-type-icon ${tab.key}`} src={CONTENT_ICONS[tab.key]} alt="" />
                <span>{tab.label}</span>
                {kind === tab.key && <small>{countForKind(tab.key)}</small>}
              </button>
            ))}
          </nav>
        </div>
        {kind !== "playtime" && <div className="library-side-section">
          <span className="library-side-label">SEARCH</span>
          <div className="library-search-wrap">
            <img className="library-search-icon" src={ACTION_ICONS.search} alt="" />
            <input className="library-search-input" aria-label={`Search ${selectedKind.label}`} placeholder={`Search ${selectedKind.label.toLowerCase()}...`} value={query} onChange={(event) => setQuery(event.target.value)} />
            {query && <button className="mini library-clear-search" onClick={() => setQuery("")} aria-label="Clear search"><img src={ACTION_ICONS.close} alt="" /></button>}
          </div>
        </div>}
      </aside>
      <main className="library-main">
        <div className="library-sticky-header">
          <header className="library-heading">
            <div>
              <span className="eyebrow">YOUR LIBRARY</span>
              <h2>Installed content</h2>
              <p>See what’s installed, turn items on or off, and keep each Minecraft setup organized.</p>
            </div>
            <button className="mini library-back" onClick={onBack}><img src={ACTION_ICONS.back} alt="" />Back</button>
          </header>
          {inst && (
            <div
              className={"library-instance-summary" + (instanceBackground ? " has-background" : "")}
              style={instanceBackground ? { "--instance-background": `url("${instanceBackground}")` } as CSSProperties & { [key: `--${string}`]: string } : undefined}
            >
              <InstanceArtwork inst={inst} />
              <div className="library-instance-info">
                <b>{inst.name}</b>
                <span>Minecraft {inst.mc} <i /> {inst.loader.charAt(0).toUpperCase() + inst.loader.slice(1)}</span>
              </div>
              <div className="library-instance-actions" aria-label="Instance actions">
                <button type="button" className="library-icon-action library-icon-action-expand library-icon-action-edit" onClick={onEdit} aria-label={`Edit ${inst.name}`} title="Edit instance">
                  <img src={ACTION_ICONS.edit} alt="" /><span>Edit</span>
                </button>
                <button
                  type="button"
                  className="library-icon-action library-icon-action-expand library-icon-action-export"
                  disabled={exporting}
                  onClick={async () => {
                    setExporting(true);
                    try {
                      await onExport(inst);
                    } catch (error) {
                      setErr(`Could not export instance: ${error}`);
                    } finally {
                      setExporting(false);
                    }
                  }}
                  aria-label={exporting ? "Exporting instance ZIP" : `Export ${inst.name} as ZIP`}
                >
                  <img src={ACTION_ICONS.export} alt="" /><span>Export</span>
                </button>
                <button type="button" className="library-icon-action library-icon-action-expand library-icon-action-open" onClick={openFolder} aria-label={`Open ${inst.name} instance folder`}>
                  <img src={ACTION_ICONS.folder} alt="" /><span>Open</span>
                </button>
              </div>
            </div>
          )}
          <div className={`library-list-heading${isFeatureKind ? " library-feature-heading" : ""}`}>
            <div>
              <b>{selectedKind.label}</b>
              <span>
                {kind === "screenshots" ? `${filteredScreenshots.length}${query ? ` of ${screenshots.length}` : ""} ${filteredScreenshots.length === 1 ? "screenshot" : "screenshots"}` :
                  kind === "worlds" ? `${filteredWorlds.length}${query ? ` of ${worlds.length}` : ""} ${filteredWorlds.length === 1 ? "world" : "worlds"}` :
                    kind === "playtime" ? `${playtime.days.length} ${playtime.days.length === 1 ? "day" : "days"} tracked` :
                      `${enabledCount} enabled · ${items.length - enabledCount} disabled`}
              </span>
            </div>
            <div className="library-list-actions">
              {!isFeatureKind && <label className="library-toggle-disabled">
                  <input type="checkbox" checked={showDisabled} onChange={(event) => setShowDisabled(event.target.checked)} />
                  <span className="library-checkbox" aria-hidden="true"><svg viewBox="0 0 12 12"><path d="m2 6 2.5 2.5L10 3" /></svg></span>
                  <span>Show disabled</span>
                </label>}
              <button
                className={`library-icon-action library-icon-action-expand library-list-refresh${loading ? " is-refreshing" : ""}`}
                onClick={() => void load()}
                disabled={loading}
                aria-label={loading ? `Refreshing ${selectedKind.label.toLowerCase()}` : `Refresh ${selectedKind.label.toLowerCase()}`}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M13.2 6A5.5 5.5 0 0 0 3 4.4L1.8 5.7M1.8 2.8v2.9h2.9M2.8 10a5.5 5.5 0 0 0 10.2 1.6l1.2-1.3m0 2.9v-2.9h-2.9" />
                </svg>
                <span>{loading ? "Refreshing..." : "Refresh"}</span>
              </button>
            </div>
          </div>
        </div>

        <div className="library-content-scroll" key={`${inst?.id ?? "none"}-${kind}`}>
        {!inst && (
          <div className="library-empty">
            <div className="library-empty-icon"><img src={ACTION_ICONS.instance} alt="" /></div>
            <h3>No instance selected</h3>
            <p>Create an instance first, then you can manage its mods and packs here.</p>
          </div>
        )}
        {inst && <>
        {err && <div className="err">{err}</div>}
        {loadingOverlayVisible && (
          <div className={`library-loading-overlay${loadingOverlayExiting ? " is-exiting" : ""}`} role="status" aria-label={`Loading ${selectedKind.label.toLowerCase()}`}>
            <span className="library-loading-spinner" aria-hidden="true" />
          </div>
        )}
        {!loading && !err && kind === "screenshots" && screenshots.length === 0 && (
          <div className="library-empty"><div className="feature-empty-mark">01</div><h3>No screenshots yet</h3><p>Screenshots captured in Minecraft for this instance will appear here.</p></div>
        )}
        {!loading && !err && kind === "screenshots" && screenshots.length > 0 && filteredScreenshots.length === 0 && (
          <div className="library-empty library-empty-small"><h3>No matching screenshots</h3><p>Try a different filename or clear your search.</p></div>
        )}
        {!loading && !err && kind === "screenshots" && filteredScreenshots.length > 0 && (
          <div className="screenshot-gallery">
            {filteredScreenshots.map((shot, index) => (
              <article className="screenshot-card" key={shot.name}>
                <button type="button" className="screenshot-preview-trigger" onClick={() => setSelectedScreenshot(shot)} aria-label={`Preview ${shot.name}`}>
                  <img className="screenshot-artwork" src={shot.data_url} alt="" loading="lazy" />
                  <span className="screenshot-preview-label">Open preview <span aria-hidden="true">↗</span></span>
                  <span className="screenshot-index">{String(index + 1).padStart(2, "0")}</span>
                </button>
                <div className="screenshot-card-footer">
                  <div className="screenshot-file-info"><b title={shot.name}>{shot.name}</b><span>PNG / JPG image</span></div>
                  <a className="screenshot-download" href={shot.data_url} download={shot.name} aria-label={`Download ${shot.name}`} title="Download screenshot">
                    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5v9m0 0 3.5-3.5M10 11.5 6.5 8M3.5 13.5v3h13v-3" /></svg>
                  </a>
                </div>
              </article>
            ))}
          </div>
        )}
        {!loading && !err && kind === "worlds" && worlds.length === 0 && <div className="library-empty"><div className="feature-empty-mark">02</div><h3>No worlds yet</h3><p>Worlds saved in this instance will appear here. Create a world in Minecraft to get started.</p></div>}
        {!loading && !err && kind === "worlds" && worlds.length > 0 && filteredWorlds.length === 0 && <div className="library-empty library-empty-small"><h3>No matching worlds</h3><p>Try a different name or clear your search.</p></div>}
        {!loading && !err && kind === "worlds" && filteredWorlds.length > 0 && (
          <div className="world-gallery">
            {filteredWorlds.map((world) => (
              <article className="world-card" key={world.name}>
                <div className="world-card-art">
                  <img className={`world-artwork${world.icon ? "" : " is-fallback"}`} src={world.icon || CONTENT_ICONS.worlds} alt="" />
                  <span className="world-card-badge">SINGLEPLAYER</span>
                </div>
                <div className="world-card-content">
                  <div className="world-card-heading"><h3 title={world.name}>{world.name}</h3><span>{world.modified ? `Updated ${formatDate(new Date(world.modified * 1000).toISOString().slice(0, 10))}` : "Saved world"}</span></div>
                  <button type="button" className="world-edit-button" onClick={() => void openNbt(world.name)}>
                    <img src={ACTION_ICONS.edit} alt="" /> Edit world data <span aria-hidden="true">→</span>
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        {selectedWorld && kind === "worlds" && createPortal(
          <div className="app-modal-backdrop world-nbt-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) closeNbt(); }}>
            <section className="app-modal-card wide world-nbt-modal" role="dialog" aria-modal="true" aria-labelledby="world-nbt-title">
              <header className="world-nbt-header">
                <div><span className="world-nbt-eyebrow">WORLD DATA EDITOR</span><h3 id="world-nbt-title">{selectedWorld}</h3></div>
                <button type="button" className="world-nbt-close" onClick={closeNbt} aria-label="Close NBT editor"><img src={ACTION_ICONS.close} alt="" /></button>
              </header>
              <div className="world-nbt-safety"><span aria-hidden="true">!</span><p>Editing NBT can break a world. Arca keeps the original as <code>level.dat.arca-backup</code> the first time you save here. Close Minecraft before editing.</p></div>
              {nbtError && <p className="world-nbt-error" role="alert">{nbtError}</p>}
              {nbtSaved && <p className="world-nbt-success" role="status">Saved successfully. Your backup is in this world’s save folder.</p>}
              <label className="world-nbt-label" htmlFor="world-nbt-json">NBT data · JSON representation</label>
              <textarea id="world-nbt-json" className="world-nbt-textarea" value={nbtText} onChange={(event) => { setNbtText(event.target.value); setNbtError(""); setNbtSaved(false); }} spellCheck={false} disabled={nbtLoading} aria-describedby="world-nbt-help" />
              <div className="world-nbt-footer">
                <span id="world-nbt-help">{nbtLoading ? "Reading level.dat…" : nbtText !== originalNbtText ? "Unsaved changes" : "Edit the JSON, then save to write it back to level.dat."}</span>
                <button type="button" className="world-nbt-save" onClick={() => void saveNbt()} disabled={nbtLoading || nbtSaving || nbtText === originalNbtText}>
                  {nbtSaving ? "Saving…" : "Save world data"}
                </button>
              </div>
              <details className="world-nbt-guide">
                <summary>Use an external NBT editor instead</summary>
                <ol>
                  <li>Quit Minecraft completely so the world file is not in use.</li>
                  <li>Open this instance folder, then go to <code>saves/{selectedWorld}</code>.</li>
                  <li>Make a separate copy of <code>level.dat</code> before changing anything.</li>
                  <li>Open <code>level.dat</code> with a desktop NBT editor such as NBTExplorer, make your changes, and save.</li>
                  <li>Reopen the world in Minecraft and check that it loads correctly.</li>
                </ol>
                <p>External tools edit the file directly and do not use Arca’s automatic backup. Keep your own copy before saving.</p>
                <button type="button" className="world-nbt-folder" onClick={openFolder}><img src={ACTION_ICONS.folder} alt="" /> Open instance folder</button>
              </details>
            </section>
          </div>,
          getPortalRoot(),
        )}
        {selectedScreenshot && kind === "screenshots" && createPortal(
          <div className="app-modal-backdrop screenshot-lightbox" onMouseDown={(event) => { if (event.target === event.currentTarget) closeScreenshot(); }}>
            <section className="screenshot-lightbox-content" role="dialog" aria-modal="true" aria-label={`Screenshot preview: ${selectedScreenshot.name}`}>
              <header><span title={selectedScreenshot.name}>{selectedScreenshot.name}</span><button type="button" onClick={closeScreenshot} aria-label="Close preview"><img src={ACTION_ICONS.close} alt="" /></button></header>
              <img src={selectedScreenshot.data_url} alt={selectedScreenshot.name} />
              <a className="screenshot-lightbox-download" href={selectedScreenshot.data_url} download={selectedScreenshot.name}>Download original</a>
            </section>
          </div>,
          getPortalRoot(),
        )}
        {!loading && !err && kind === "playtime" && (
          <section className="playtime-dashboard">
            <div className="playtime-summary">
              <article className="playtime-total-card"><span>ALL-TIME PLAYTIME</span><strong>{formatDuration(playtime.total_seconds)}</strong><p>Across this Minecraft instance</p></article>
              <article className="playtime-stat-card"><span>LAST {chartRange} DAYS</span><strong>{formatDuration(chartTotal)}</strong><p>{chartActiveDays} active {chartActiveDays === 1 ? "day" : "days"}</p></article>
              <article className="playtime-stat-card"><span>BEST DAY</span><strong>{chartBestDay.seconds ? formatDuration(chartBestDay.seconds) : "—"}</strong><p>{chartBestDay.date ? formatDate(chartBestDay.date) : "No sessions yet"}</p></article>
            </div>
            <section className="playtime-chart-card" aria-labelledby="playtime-chart-title">
              <header className="playtime-chart-header">
                <div><h3 id="playtime-chart-title">Playtime activity</h3><p>Your daily play sessions over time</p></div>
                <div className="playtime-range" role="group" aria-label="Chart date range">
                  {([7, 30, 90] as const).map((range) => <button type="button" key={range} className={chartRange === range ? "on" : ""} aria-pressed={chartRange === range} onClick={() => setChartRange(range)}>{range}D</button>)}
                </div>
              </header>
              {chartActiveDays === 0 && <p className="playtime-chart-empty">Play a session in this instance to start building your tracker.</p>}
              <div className="playtime-chart-wrap">
                <svg className="playtime-chart" viewBox="0 0 1000 230" role="img" aria-label={`${chartRange}-day playtime chart. ${chartActiveDays} active days, ${formatDuration(chartTotal)} total.`}>
                  <defs><linearGradient id="playtime-bar-gradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#b69aff" /><stop offset="100%" stopColor="#7447d5" /></linearGradient></defs>
                  {[0, 1, 2, 3, 4].map((step) => {
                    const y = chartPlot.top + chartPlot.height * step / 4;
                    const axisSeconds = chartMaxSeconds * (1 - step / 4);
                    return <g key={step}><line x1={chartPlot.left} x2={chartPlot.left + chartPlot.width} y1={y} y2={y} /><text x={chartPlot.left - 9} y={y + 3} textAnchor="end">{formatChartAxis(axisSeconds)}</text></g>;
                  })}
                  {chartData.map((day, index) => {
                    const height = day.seconds ? Math.max(3, day.seconds / chartMaxSeconds * chartPlot.height) : 0;
                    const x = chartPlot.left + index * (chartBarWidth + chartBarGap);
                    const y = chartPlot.top + chartPlot.height - height;
                    return <g key={day.date}><title>{`${formatDate(day.date)}: ${formatDuration(day.seconds)}`}</title><rect className={day.seconds ? "has-playtime" : ""} x={x} y={y} width={chartBarWidth} height={height} rx={Math.min(4, chartBarWidth / 2)} /></g>;
                  })}
                  {[0, Math.round((chartRange - 1) / 4), Math.round((chartRange - 1) / 2), Math.round((chartRange - 1) * 3 / 4), chartRange - 1].map((index) => {
                    const x = chartPlot.left + index * (chartBarWidth + chartBarGap) + chartBarWidth / 2;
                    return <text className="playtime-date-tick" key={index} x={x} y="218" textAnchor="middle">{formatDate(chartData[index].date)}</text>;
                  })}
                </svg>
              </div>
              <footer className="playtime-chart-footer"><span><i /> Daily playtime</span><span>{chartActiveDays} of {chartRange} days with activity</span></footer>
            </section>
          </section>
        )}
        {!loading && !err && kind !== "screenshots" && kind !== "worlds" && kind !== "playtime" && items.length === 0 && (
          <div className="library-empty">
            <div className="library-empty-icon"><img src={CONTENT_ICONS[kind]} alt="" /></div>
            <h3>No {selectedKind.label.toLowerCase()} yet</h3>
            <p>{kind === "mods" && inst.loader === "vanilla"
              ? "This is a Vanilla instance. Choose Fabric, Quilt, Forge, or NeoForge to install mods."
              : `Installed ${selectedKind.label.toLowerCase()} will appear here. Use the Downloader to discover and add ${selectedKind.label.toLowerCase()}.`}</p>
          </div>
        )}
        {!loading && items.length > 0 && filtered.length === 0 && (
          <div className="library-empty library-empty-small"><h3>No matches</h3><p>Try a different search or show disabled items.</p></div>
        )}
        {filtered.length > 0 && <div className="library-grid">
          {filtered.map((item, index) => (
            <article className={("library-card" + (!item.enabled ? " is-disabled" : "") + " animate-stagger")} key={item.file_name} style={{ animationDelay: `${Math.min(index, 20) * 0.03}s` }}>
              <Artwork item={item} kind={kind} />
              <div className="library-card-content">
                <div className="library-card-title">
                  <b title={item.name}>{item.name}</b>
                  {!item.enabled && <span className="library-state disabled">Disabled</span>}
                  {item.enabled && <span className="library-state enabled">Enabled</span>}
                </div>
                {item.description && <p className="library-description" title={item.description}>{item.description}</p>}
                <div className="library-badges">
                  {item.source && <span className={`library-source ${item.source}`}>{item.source === "modrinth" ? "Modrinth" : "CurseForge"}</span>}
                  {item.version && <span>{item.version}</span>}
                  {item.channel && item.channel !== "release" && <span>{item.channel}</span>}
                  {item.dependency && <span>Dependency</span>}
                </div>
                <div className="library-card-footer">
                  <div className="library-meta">
                    <span title={item.file_name}>{item.file_name}</span>
                    <span>{fmtSize(item.size)}</span>
                  </div>
                  <div className="library-card-actions">
                    <button className="mini" disabled={!!busy[item.file_name]} onClick={() => void toggle(item)}>
                      {busy[item.file_name] ? "Working..." : item.enabled ? "Disable" : "Enable"}
                    </button>
                    <button className="mini danger" disabled={!!busy[item.file_name]} onClick={() => void remove(item)}>Delete</button>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>}
        </>}
      </div>
      </main>
    </section>
  );
}
