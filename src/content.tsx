import { useEffect, useMemo, useRef, useState } from "react";
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
type Kind = "mods" | "resourcepacks" | "shaderpacks";

const KINDS: { key: Kind; label: string; singular: string; description: string }[] = [
  { key: "mods", label: "Mods", singular: "mod", description: "Manage the mods installed in this instance." },
  { key: "resourcepacks", label: "Resource Packs", singular: "resource pack", description: "Change the look and sounds of Minecraft." },
  { key: "shaderpacks", label: "Shader Packs", singular: "shader pack", description: "Manage visual effects and shaders." },
];

const CONTENT_ICONS: Record<Kind, string> = {
  mods: new URL("../assets/icons/mods.svg", import.meta.url).href,
  resourcepacks: new URL("../assets/icons/texture.svg", import.meta.url).href,
  shaderpacks: new URL("../assets/icons/shaders.svg", import.meta.url).href,
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
  const selectionKey = `${inst?.id ?? "none"}:${kind}`;
  const activeSelection = useRef(selectionKey);
  activeSelection.current = selectionKey;
  const selectedKind = KINDS.find((item) => item.key === kind)!;

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
  const enabledCount = items.filter((item) => item.enabled).length;
  const busyOn = (file: string, value: boolean) => setBusy((current) => ({ ...current, [file]: value }));

  const toggle = async (item: Item) => {
    if (!inst) return;
    busyOn(item.file_name, true);
    try {
      await invoke("toggle_content", { req: { instance: inst.id, kind, file_name: item.file_name, enable: !item.enabled } });
      await load();
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
                {kind === tab.key && <small>{items.length}</small>}
              </button>
            ))}
          </nav>
        </div>
        <div className="library-side-section">
          <span className="library-side-label">SEARCH</span>
          <div className="library-search-wrap">
            <img className="library-search-icon" src={ACTION_ICONS.search} alt="" />
            <input aria-label={`Search ${selectedKind.label}`} placeholder={`Search ${selectedKind.label.toLowerCase()}...`} value={query} onChange={(event) => setQuery(event.target.value)} />
            {query && <button className="mini library-clear-search" onClick={() => setQuery("")} aria-label="Clear search"><img src={ACTION_ICONS.close} alt="" /></button>}
          </div>
        </div>
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
          <div className="library-list-heading">
            <div><b>{selectedKind.label}</b><span>{enabledCount} enabled · {items.length - enabledCount} disabled</span></div>
            <div className="library-list-actions">
              <label className="library-toggle-disabled">
                <input type="checkbox" checked={showDisabled} onChange={(event) => setShowDisabled(event.target.checked)} />
                <span className="library-checkbox" aria-hidden="true"><svg viewBox="0 0 12 12"><path d="m2 6 2.5 2.5L10 3" /></svg></span>
                <span>Show disabled</span>
              </label>
              <button
                className={`library-icon-action library-icon-action-expand library-list-refresh${loading ? " is-refreshing" : ""}`}
                onClick={() => void load()}
                disabled={loading}
                aria-label={loading ? "Refreshing installed content" : "Refresh installed content"}
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
        {!loading && !err && items.length === 0 && (
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