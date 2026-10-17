import { useEffect, useMemo, useState } from "react";
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
  const image = !failed && (inst.icon || INSTANCE_ICONS[inst.loader]);
  return image
    ? <img className="library-instance-mark" src={image} alt="" onError={() => setFailed(true)} />
    : <div className="library-instance-mark library-instance-mark-fallback" aria-hidden="true">M</div>;
}

function Artwork({ item, kind }: { item: Item; kind: Kind }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.icon]);
  if (item.icon && !failed) {
    return <img className="library-artwork" src={item.icon} alt="" onError={() => setFailed(true)} />;
  }
  return <div className={`library-artwork library-artwork-fallback ${kind}`} aria-hidden="true">
    {kind === "mods" ? "✦" : kind === "resourcepacks" ? "▧" : "✧"}
  </div>;
}

export default function ContentPage({
  inst,
  onBack,
}: {
  inst: Inst | null;
  onBack: () => void;
}) {
  const { refreshInstalled } = useDownloads();
  const [kind, setKind] = useState<Kind>("mods");
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");
  const [showDisabled, setShowDisabled] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const selectedKind = KINDS.find((item) => item.key === kind)!;

  const load = async () => {
    if (!inst) {
      setItems([]);
      setErr("");
      return;
    }
    setLoading(true);
    setErr("");
    try {
      setItems(await invoke<Item[]>("list_content", { req: { instance: inst.id, kind } }));
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [inst?.id, kind]);

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

  const openFolder = () => inst && invoke("open_instance_folder", { req: { instance: inst.id, kind } }).catch((e) => setErr(String(e)));

  return (
    <section className="panel library-page">
      <header className="library-heading">
        <div>
          <span className="eyebrow">YOUR LIBRARY</span>
          <h2>Installed content</h2>
          <p>See what’s installed, turn items on or off, and keep each Minecraft setup organized.</p>
        </div>
        <button className="mini library-back" onClick={onBack}>← Back to instances</button>
      </header>

      {!inst ? (
        <div className="library-empty">
          <div className="library-empty-icon">▧</div>
          <h3>No instance selected</h3>
          <p>Create an instance first, then you can manage its mods and packs here.</p>
        </div>
      ) : <>
        <div className="library-instance-summary">
          <InstanceArtwork inst={inst} />
          <div className="library-instance-info">
            <b>{inst.name}</b>
            <span>Minecraft {inst.mc} <i /> {inst.loader.charAt(0).toUpperCase() + inst.loader.slice(1)}</span>
          </div>
          <button className="mini" onClick={openFolder}>Open {selectedKind.label.toLowerCase()} folder</button>
        </div>

        <div className="library-toolbar">
          <div className="library-tabs" role="tablist" aria-label="Installed content type">
            {KINDS.map((tab) => (
              <button key={tab.key} role="tab" aria-selected={kind === tab.key} className={kind === tab.key ? "on" : ""} onClick={() => setKind(tab.key)}>
                {tab.label}<span>{kind === tab.key ? items.length : ""}</span>
              </button>
            ))}
          </div>
          <div className="library-search-wrap">
            <span aria-hidden="true">⌕</span>
            <input aria-label={`Search ${selectedKind.label}`} placeholder={`Search ${selectedKind.label.toLowerCase()}...`} value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
        </div>

        <div className="library-list-heading">
          <div><b>{selectedKind.label}</b><span>{enabledCount} enabled · {items.length - enabledCount} disabled</span></div>
          <div className="library-list-actions">
            <label className="library-toggle-disabled"><input type="checkbox" checked={showDisabled} onChange={(event) => setShowDisabled(event.target.checked)} /> Show disabled</label>
            <button className="mini" onClick={() => void load()} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</button>
          </div>
        </div>

        {err && <div className="err">{err}</div>}
        {loading && items.length === 0 && <div className="library-loading">Loading installed {selectedKind.label.toLowerCase()}...</div>}
        {!loading && !err && items.length === 0 && (
          <div className="library-empty">
            <div className="library-empty-icon">{kind === "mods" ? "✦" : kind === "resourcepacks" ? "▧" : "✧"}</div>
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
          {filtered.map((item) => (
            <article className={"library-card" + (!item.enabled ? " is-disabled" : "")} key={item.file_name}>
              <Artwork item={item} kind={kind} />
              <div className="library-card-content">
                <div className="library-card-title">
                  <b title={item.name}>{item.name}</b>
                  {!item.enabled && <span className="library-state disabled">Disabled</span>}
                  {item.enabled && <span className="library-state enabled">Enabled</span>}
                </div>
                {item.description && <p className="library-description" title={item.description}>{item.description}</p>}
                <div className="library-meta">
                  <span title={item.file_name}>{item.file_name}</span>
                  <span>{fmtSize(item.size)}</span>
                </div>
                <div className="library-badges">
                  {item.source && <span className={`library-source ${item.source}`}>{item.source === "modrinth" ? "Modrinth" : "CurseForge"}</span>}
                  {item.version && <span>{item.version}</span>}
                  {item.channel && item.channel !== "release" && <span>{item.channel}</span>}
                  {item.dependency && <span>Dependency</span>}
                </div>
                <div className="library-card-actions">
                  <button className="mini" disabled={!!busy[item.file_name]} onClick={() => void toggle(item)}>
                    {busy[item.file_name] ? "Working..." : item.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className="mini danger" disabled={!!busy[item.file_name]} onClick={() => void remove(item)}>Delete</button>
                </div>
              </div>
            </article>
          ))}
        </div>}
      </>}
    </section>
  );
}
