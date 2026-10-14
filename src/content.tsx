import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Inst } from "./mods";

type Item = { name: string; file_name: string; enabled: boolean; size: number };
type Kind = "mods" | "resourcepacks" | "shaderpacks";

const KINDS: { key: Kind; label: string }[] = [
  { key: "mods", label: "Mods" },
  { key: "resourcepacks", label: "Resource Packs" },
  { key: "shaderpacks", label: "Shader Packs" },
];

const fmtSize = (n: number) =>
  n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " MB" : n >= 1024 ? (n / 1024).toFixed(0) + " KB" : n + " B";

export default function ContentPage({ inst }: { inst: Inst | null }) {
  const [kind, setKind] = useState<Kind>("mods");
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const load = async () => {
    if (!inst) { setItems([]); return; }
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

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [inst?.id, kind]);

  const busyOn = (f: string, v: boolean) => setBusy((b) => ({ ...b, [f]: v }));

  const toggle = async (it: Item) => {
    if (!inst) return;
    busyOn(it.file_name, true);
    try {
      await invoke("toggle_content", { req: { instance: inst.id, kind, file_name: it.file_name, enable: !it.enabled } });
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      busyOn(it.file_name, false);
    }
  };

  const remove = async (it: Item) => {
    if (!inst || !confirm(`Delete ${it.name}?`)) return;
    busyOn(it.file_name, true);
    try {
      await invoke("delete_content", { req: { instance: inst.id, kind, file_name: it.file_name } });
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      busyOn(it.file_name, false);
    }
  };

  const openFolder = () => inst && invoke("open_instance_folder", { req: { instance: inst.id, kind } }).catch((e) => setErr(String(e)));

  if (!inst) return <section className="panel"><p className="hint">Select an instance on the Home page first.</p></section>;

  return (
    <section className="panel">
      <div className="ptop">
        <h2>Content — {inst.name}</h2>
        <button className="mini" onClick={openFolder}>Open folder</button>
      </div>
      <div className="seg">
        {KINDS.map((k) => <button key={k.key} className={kind === k.key ? "on" : ""} onClick={() => setKind(k.key)}>{k.label}</button>)}
      </div>
      {err && <div className="err">{err}</div>}
      {loading && <p className="hint">Loading...</p>}
      {!loading && items.length === 0 && !err && <p className="hint">Nothing installed here yet.</p>}
      <div className="contentlist">
        {items.map((it) => (
          <div className="contentrow" key={it.file_name}>
            <input type="checkbox" checked={it.enabled} disabled={!!busy[it.file_name]} onChange={() => toggle(it)} />
            <div className="contentinfo">
              <b className={it.enabled ? "" : "disabledname"}>{it.name}</b>
              <span>{fmtSize(it.size)}{!it.enabled ? " · disabled" : ""}</span>
            </div>
            <button className="mini danger" disabled={!!busy[it.file_name]} onClick={() => remove(it)}>Delete</button>
          </div>
        ))}
      </div>
    </section>
  );
}