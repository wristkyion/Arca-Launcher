import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import ModsPage from "./mods";
import ContentPage from "./content";
import { DownloadsProvider, DownloadOverlay, useDownloads } from "./downloads";
import CrashWatcher from "./CrashWatcher";
// @ts-ignore CSS is handled by the bundler; TypeScript may not have a CSS module declaration.
import "./styles.css";

type Page = "play" | "account" | "versions" | "mods" | "console" | "settings";
type Acc = { id: string; kind: string; username: string; uuid: string };
type AccList = { selected: string | null; accounts: Acc[] };
type VersionInfo = { id: string; kind: string };
type Instance = { id: string; name: string; loader: string; mc: string; version_id: string; icon: string; description: string; background: string };

type Settings = {
  ramAuto: boolean; jvmArgs: string; gameArgs: string;
  launchFullscreen: boolean;
  hide: "keep" | "hide" | "close";
  volumeOn: boolean; volume: number; uiScale: number;
  showSnapshots: boolean; showExperimental: boolean; showBeta: boolean; showAlpha: boolean;
  downloadConcurrency: number; autoClearDownloads: boolean;
  instanceDirectory: string;
  javaRuntime: "system" | "launcher";
};
const DEFAULTS: Settings = {
  ramAuto: true, jvmArgs: "", gameArgs: "", launchFullscreen: false, hide: "keep",
  volumeOn: false, volume: 100, uiScale: 100,
  showSnapshots: false, showExperimental: false, showBeta: false, showAlpha: false,
  downloadConcurrency: 3, autoClearDownloads: true,
  instanceDirectory: "",
  javaRuntime: "system",
};

// Edit this list to publish your own launcher changelogs (newest first).
const CHANGELOG: { v: string; title: string; items: string[] }[] = [
  { v: "0.1.1", title: "Fix and Improvements", items: ["Fix and added new features mods installation", "New logo modloader", "Added background support GIF/PNG/JPG", "Added mod list installation", "Remake UI", "Added system or launcher-managed Java runtime options", "Added fullscreen launch setting", "Added instance storage folder and install queue settings", "Renamed the Downloader page and added resource pack and shader pack support"] },
  { v: "0.1.0", title: "First Release", items: ["Initial release", "Publish github repository"] },
];

/** Auto RAM: 3 GB for vanilla, 6 GB for modded, never more than 60% of the machine. */
const autoRam = (total: number, loader: string) => {
  const want = loader === "vanilla" ? 3072 : 6144;
  const cap = total ? Math.floor((total * 0.6) / 512) * 512 : want;
  return Math.max(1024, Math.min(want, cap));
};
const displayPath = (path: string) => path.startsWith("\\\\?\\") ? path.slice(4) : path;
// Mojang files these under "snapshot"; we recognise the special ones by name
const isExperimental = (v: VersionInfo) =>
  v.kind === "snapshot" && /combat|experimental|infinite|oneblock|a_or_b|potato|craftmine|rv-|shareware|trendy/i.test(v.id);

const LOADERS = ["vanilla", "fabric", "quilt", "forge", "neoforge"];
const KINDS: [string, string][] = [["offline", "Offline"], ["elyby", "Ely.by"], ["microsoft", "Microsoft"]];
const KIND_LABEL: Record<string, string> = { offline: "Offline", elyby: "Ely.by", microsoft: "Microsoft" };
const BLURB: Record<string, string> = {
  vanilla: "The classic, unmodified game straight from Mojang.",
  fabric: "Lightweight modding platform. Fast updates and a huge mod library.",
  quilt: "A community fork of Fabric with its own mod ecosystem.",
  forge: "The long-standing modding platform with thousands of mods.",
  neoforge: "The modern successor to Forge for recent Minecraft versions.",
};
const SHORT: Record<string, string> = {
  vanilla: "No mods, the original game",
  fabric: "Lightweight, fast-updating mods",
  quilt: "Fabric-compatible mod platform",
  forge: "The classic mod platform",
  neoforge: "The modern Forge successor",
};
const ICONS: Record<string, string> = {
  play: "M8 5v14l11-7z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  term: "M3 5h18v14H3zM7 9l3 3-3 3M12 15h5",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12h2M3 12h2M12 3v2M12 19v2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  cube: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
  puzzle: "M10 4a2 2 0 1 1 4 0v2h4v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4h2a2 2 0 1 0 0-4H6V6h4z",
};
const Icon = ({ n, filled }: { n: string; filled?: boolean }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill={filled ? "currentColor" : "none"} stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={ICONS[n]} /></svg>
);

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Shows a saved background image (including an animated gif). */
function BgPreview({ src, className }: { src: string; className?: string }) {
  if (!src) return null;
  return <img className={className} src={src} alt="" />;
}

/** A simple centered dialog with a dark scrim backdrop. Click outside or the ✕ to close. */
function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(2px)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#16161d", border: "1px solid #2a2a35", borderRadius: 14,
          width: wide ? "min(760px, 92vw)" : "min(520px, 92vw)", height: "min(760px, 86vh)", maxHeight: "86vh",
          display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden",
          padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="mini" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

type Skin = { url: string; slim: boolean; data?: string } | null;

/** Draws a skin texture as a front-facing body (or just the head). */
function SkinCanvas({ url, slim, head, height }: { url: string; slim: boolean; head?: boolean; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    let dead = false;
    const img = new Image();
    img.onload = () => {
      if (dead) return;
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.imageSmoothingEnabled = false;
      const legacy = img.height < 64; // old 64x32 skins
      const d = (sx: number, sy: number, w: number, h: number, dx: number, dy: number, flip = false) => {
        ctx.save();
        if (flip) { ctx.translate(dx + w, dy); ctx.scale(-1, 1); ctx.drawImage(img, sx, sy, w, h, 0, 0, w, h); }
        else ctx.drawImage(img, sx, sy, w, h, dx, dy, w, h);
        ctx.restore();
      };
      const hx = head ? 0 : 4;
      d(8, 8, 8, 8, hx, 0);   // face
      d(40, 8, 8, 8, hx, 0);  // hat layer
      if (head) return;
      const aw = slim ? 3 : 4;
      d(20, 20, 8, 12, 4, 8); if (!legacy) d(20, 36, 8, 12, 4, 8);               // torso + jacket
      d(44, 20, aw, 12, 4 - aw, 8); if (!legacy) d(44, 36, aw, 12, 4 - aw, 8);   // right arm
      if (legacy) d(44, 20, aw, 12, 12, 8, true);                                  // left arm
      else { d(36, 52, aw, 12, 12, 8); d(52, 52, aw, 12, 12, 8); }
      d(4, 20, 4, 12, 4, 20); if (!legacy) d(4, 36, 4, 12, 4, 20);               // right leg
      if (legacy) d(4, 20, 4, 12, 8, 20, true);                                    // left leg
      else { d(20, 52, 4, 12, 8, 20); d(4, 52, 4, 12, 8, 20); }
    };
    img.src = url;
    return () => { dead = true; };
  }, [url, slim, head]);
  return <canvas ref={ref} width={head ? 8 : 16} height={head ? 8 : 32} className="skincv" style={{ height }} />;
}


type V3 = [number, number, number];

/** One textured box. Faces are CSS-3D planes that show a slice of the skin PNG. */
function Cube({ tex, tw, th, s, g, d, o, at }:
  { tex: string; tw: number; th: number; s: number; g: V3; d: V3; o: [number, number]; at: V3 }) {
  const [gw, gh, gd] = g, [w, h, dp] = d, [u, v] = o;
  const faces = [
    { t: `translateZ(${(gd * s) / 2}px)`, fw: gw, fh: gh, r: [u + dp, v + dp, w, h] },                       // front
    { t: `rotateY(180deg) translateZ(${(gd * s) / 2}px)`, fw: gw, fh: gh, r: [u + 2 * dp + w, v + dp, w, h] }, // back
    { t: `rotateY(-90deg) translateZ(${(gw * s) / 2}px)`, fw: gd, fh: gh, r: [u, v + dp, dp, h] },            // right side
    { t: `rotateY(90deg) translateZ(${(gw * s) / 2}px)`, fw: gd, fh: gh, r: [u + dp + w, v + dp, dp, h] },    // left side
    { t: `rotateX(90deg) translateZ(${(gh * s) / 2}px)`, fw: gw, fh: gd, r: [u + dp, v, w, dp] },             // top
  ];
  return (
    <div className="cube" style={{ transform: `translate3d(${at[0] * s}px,${at[1] * s}px,${at[2] * s}px)` }}>
      {faces.map((f, i) => {
        const sx = (f.fw * s) / f.r[2], sy = (f.fh * s) / f.r[3];
        return (
          <i key={i} style={{
            width: f.fw * s, height: f.fh * s, left: -(f.fw * s) / 2, top: -(f.fh * s) / 2,
            transform: f.t, backgroundImage: `url(${tex})`,
            backgroundSize: `${tw * sx}px ${th * sy}px`, backgroundPosition: `${-f.r[0] * sx}px ${-f.r[1] * sy}px`,
          }} />
        );
      })}
    </div>
  );
}

/** 3D skin preview. Starts viewed from the top-left; drag to rotate, double-click to reset. */
function SkinModel({ data, slim, s = 5 }: { data: string; slim: boolean; s?: number }) {
  const HOME = { x: -24, y: 32 }; // x: tilt (negative = camera above), y: turn (positive = camera to the left)
  const [dim, setDim] = useState<[number, number]>([64, 64]);
  const rot = HOME;
  useEffect(() => {
    const i = new Image();
    i.onload = () => setDim([i.width, i.height]);
    i.src = data;
  }, [data]);
  const [tw, th] = dim;
  const legacy = th < 64;
  const aw = slim ? 3 : 4;
  const c = { tex: data, tw, th, s };
  const Y = 2; // keeps the whole figure centred on the pivot
  const ax = 4 + aw / 2;

  return (
    <div className="stage">
      <div className="rig" style={{ transform: `rotateX(${rot.x}deg) rotateY(${rot.y}deg)` }}>
        <Cube {...c} g={[8, 8, 8]} d={[8, 8, 8]} o={[0, 0]} at={[0, -10 - Y, 0]} />
        <Cube {...c} g={[8, 12, 4]} d={[8, 12, 4]} o={[16, 16]} at={[0, -Y, 0]} />
        <Cube {...c} g={[aw, 12, 4]} d={[aw, 12, 4]} o={[40, 16]} at={[-ax, -Y, 0]} />
        <Cube {...c} g={[aw, 12, 4]} d={[aw, 12, 4]} o={legacy ? [40, 16] : [32, 48]} at={[ax, -Y, 0]} />
        <Cube {...c} g={[4, 12, 4]} d={[4, 12, 4]} o={[0, 16]} at={[-2, 12 - Y, 0]} />
        <Cube {...c} g={[4, 12, 4]} d={[4, 12, 4]} o={legacy ? [0, 16] : [16, 48]} at={[2, 12 - Y, 0]} />
        <Cube {...c} g={[9, 9, 9]} d={[8, 8, 8]} o={[32, 0]} at={[0, -10 - Y, 0]} />
        {!legacy && (<>
          <Cube {...c} g={[8.5, 12.5, 4.5]} d={[8, 12, 4]} o={[16, 32]} at={[0, -Y, 0]} />
          <Cube {...c} g={[aw + 0.5, 12.5, 4.5]} d={[aw, 12, 4]} o={[40, 32]} at={[-ax, -Y, 0]} />
          <Cube {...c} g={[aw + 0.5, 12.5, 4.5]} d={[aw, 12, 4]} o={[48, 48]} at={[ax, -Y, 0]} />
          <Cube {...c} g={[4.5, 12.5, 4.5]} d={[4, 12, 4]} o={[0, 32]} at={[-2, 12 - Y, 0]} />
          <Cube {...c} g={[4.5, 12.5, 4.5]} d={[4, 12, 4]} o={[0, 48]} at={[2, 12 - Y, 0]} />
        </>)}
      </div>
    </div>
  );
}

function Avatar({ acc, skin }: { acc: Acc; skin: Skin }) {
  if (skin?.data) return <SkinCanvas url={skin.data} slim={skin.slim} head height={36} />;
  if (acc.kind === "offline")
    return <img className="avimg" src={`https://mc-heads.net/avatar/${encodeURIComponent(acc.username)}/36`} alt=""
      onError={(e) => (e.currentTarget.style.visibility = "hidden")} />;
  return <span className="avph" />;
}


const kindLabel = (v: VersionInfo) =>
  v.kind === "release" ? "Release" : isExperimental(v) ? "Experimental" : v.kind === "snapshot" ? "Snapshot" : v.kind === "old_beta" ? "Beta" : v.kind === "old_alpha" ? "Alpha" : v.kind;

const LOADER_ICONS: Record<string, string> = {
  vanilla: new URL("../assets/modifted/vanilla.jpg", import.meta.url).href,
  fabric: new URL("../assets/modifted/fabric.png", import.meta.url).href,
  quilt: new URL("../assets/modifted/quilt.png", import.meta.url).href,
  forge: new URL("../assets/modifted/forge.jpg", import.meta.url).href,
  neoforge: new URL("../assets/modifted/neoforge.png", import.meta.url).href,
};

function LoaderIcon({ loader, size }: { loader: string; size: number }) {
  return (
    <img
      className="loadericon"
      src={LOADER_ICONS[loader] ?? LOADER_ICONS.vanilla}
      width={size}
      height={size}
      style={{ borderRadius: size * 0.18 }}
      alt=""
    />
  );
}

function InstIcon({ inst, size }: { inst: { loader: string; icon?: string }; size: number }) {
  if (inst.icon)
    return <img className="insticon" src={inst.icon} width={size} height={size} style={{ borderRadius: size * 0.22 }} alt="" />;
  return <LoaderIcon loader={inst.loader} size={size} />;
}

function AppInner() {
  const { configureDownloads } = useDownloads();
  const [page, setPageNow] = useState<Page>("play");
  const [fade, setFade] = useState<"in" | "out">("in");
  const pageRef = useRef<Page>("play");
  pageRef.current = page;
  const setPage = (p: Page) => {
    if (p === pageRef.current) return;
    setFade("out");
    setTimeout(() => { setPageNow(p); setFade("in"); }, 160);
  };

  // whether the settings file has finished loading from the backend (avoids
  // overwriting game/launcher/config/settings.json with defaults before it loads)
  const loadedRef = useRef(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [startup, setStartup] = useState(false);
  const [firstRunOpen, setFirstRunOpen] = useState(false);
  const [firstRunStep, setFirstRunStep] = useState(0);
  const [firstRunBusy, setFirstRunBusy] = useState(false);
  const [firstRunError, setFirstRunError] = useState("");

  // accounts
  const [accounts, setAccounts] = useState<Acc[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [addKind, setAddKind] = useState("offline");
  const [addUser, setAddUser] = useState("");
  const [addPass, setAddPass] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addErr, setAddErr] = useState("");
  const [msClientId, setMsClientId] = useState("");
  const [cfKey, setCfKey] = useState("");

  // instances
  const [instances, setInstances] = useState<Instance[]>([]);
  const [instId, setInstId] = useState("");
  const [activeBackground, setActiveBackground] = useState("");
  const [contentInst, setContentInst] = useState<Instance | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuClosing, setMenuClosing] = useState(false);
  const closeMenu = () => {
    setMenuClosing(true);
    setTimeout(() => { setMenuOpen(false); setMenuClosing(false); }, 120);
  };

  // download wizard
  const [tab, setTab] = useState<"download" | "instances">("download");
  const [step, setStep] = useState(1);
  const [wMc, setWMc] = useState("");
  const [wLoader, setWLoader] = useState("vanilla");
  const [support, setSupport] = useState<string[] | null>(null);
  const [wName, setWName] = useState("");
  const [wIcon, setWIcon] = useState("");
  const [wDesc, setWDesc] = useState("");
  const [wBg, setWBg] = useState("");
  const [createErr, setCreateErr] = useState("");
  const nameEdited = useRef(false);

  // managing instances
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editIcon, setEditIcon] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editBg, setEditBg] = useState("");
  const [delId, setDelId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // versions + settings
  const [vinfo, setVinfo] = useState<VersionInfo[]>([]);
  const [filter, setFilter] = useState("");
  const [sysRam, setSysRam] = useState(0);
  const [st, setSt] = useState<Settings>(DEFAULTS);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSt((p) => ({ ...p, [k]: v }));
  const [instanceDirectoryDraft, setInstanceDirectoryDraft] = useState("");
  const [instanceDirectoryBusy, setInstanceDirectoryBusy] = useState(false);
  const [instanceDirectoryMessage, setInstanceDirectoryMessage] = useState("");
  const [javaRuntimeBusy, setJavaRuntimeBusy] = useState(false);
  const [javaRuntimeMessage, setJavaRuntimeMessage] = useState("");
  const [ram, setRam] = useState(4096);
  const [java, setJava] = useState("java");
  const [showCrashReports, setShowCrashReports] = useState(true);

  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [msCode, setMsCode] = useState<{ code: string; url: string } | null>(null);
  const [skinFail, setSkinFail] = useState(false);
  const [skins, setSkins] = useState<Record<string, Skin>>({});
  const fetchedSkins = useRef(new Set<string>());
  const logRef = useRef<HTMLDivElement>(null);
  const [winH, setWinH] = useState(window.innerHeight);

  const add = (s: string) =>
    setLog((l) => {
      const prog = /^(Assets|Libraries) \d+\/\d+/;
      const last = l[l.length - 1];
      if (prog.test(s) && last && prog.test(last)) return [...l.slice(0, -1), s];
      return [...l.slice(-400), s];
    });

  const applyList = (r: AccList) => { setAccounts(r.accounts); setSelected(r.selected); setSkinFail(false); };

  const loadVersions = () =>
    invoke<VersionInfo[]>("mc_versions").then(setVinfo).catch((e) => add(`Could not load versions: ${e}`));

  useEffect(() => {
    // all settings now live in game/launcher/config/settings.json on the backend
    invoke<any>("load_settings").then((d) => {
      if (d.msClientId !== undefined) setMsClientId(d.msClientId);
      if (d.cfKey !== undefined) setCfKey(d.cfKey);
      if (d.ram !== undefined) setRam(d.ram);
      if (d.java !== undefined) setJava(d.java);
      if (d.instance !== undefined) setInstId(d.instance);
      if (d.settings !== undefined) {
        const loadedSettings = { ...DEFAULTS, ...d.settings };
        setSt(loadedSettings);
        setInstanceDirectoryDraft(loadedSettings.instanceDirectory);
      }
      if (d.skins !== undefined) setSkins(d.skins);
      if (d.showCrashReports !== undefined) setShowCrashReports(d.showCrashReports);
      if (d.startup !== undefined) setStartup(d.startup === true);
      else if (d.firstRunComplete !== undefined) setStartup(d.firstRunComplete === true);
      loadedRef.current = true;
    }).catch((e) => {
      add(`Could not load settings: ${e}`);
      loadedRef.current = true;
    }).finally(() => setSettingsLoaded(true));

    invoke<AccList>("list_accounts").then(applyList).catch((e) => {
      add(`Could not load accounts: ${e}`);
    });
    invoke<Instance[]>("list_instances").then((l) => {
      setInstances(l);
      setInstId((cur) => (l.some((i) => i.id === cur) ? cur : l[0]?.id ?? ""));
    }).catch((e) => {
      add(`Could not load instances: ${e}`);
    });
    loadVersions();
    invoke<number>("system_ram").then(setSysRam).catch(() => {});
    const subs = [
      listen<string>("progress", (e) => add(e.payload)),
      listen<{ code: string; url: string }>("ms-code", (e) => setMsCode(e.payload)),
    ];
    return () => { subs.forEach((p) => p.then((un) => un())); };
  }, []);

  useEffect(() => {
    if (settingsLoaded) setFirstRunOpen(!startup);
  }, [settingsLoaded, startup]);

  useEffect(() => {
    configureDownloads(st.downloadConcurrency, st.autoClearDownloads);
  }, [configureDownloads, st.downloadConcurrency, st.autoClearDownloads]);

  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [log, page]);

  // persist everything together into game/launcher/config/settings.json
  useEffect(() => {
    if (!loadedRef.current) return;
    invoke("save_settings", {
      data: { msClientId, cfKey, ram, java, instance: instId, settings: st, skins, showCrashReports, startup },
    }).catch((e) => add(`Could not save settings: ${e}`));
  }, [msClientId, cfKey, ram, java, instId, st, skins, showCrashReports, startup]);

  // Interface size: CSS zoom, with the shell height divided by the zoom so it still fills the window
  useEffect(() => {
    const f = () => setWinH(window.innerHeight);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  useEffect(() => { (document.body.style as any).zoom = String(st.uiScale / 100); }, [st.uiScale]);

  // which loaders exist for the version picked in the wizard
  useEffect(() => {
    if (!wMc) return;
    let dead = false;
    setSupport(null);
    invoke<string[]>("loader_support", { mc: wMc })
      .then((s) => { if (!dead) setSupport(s); })
      .catch(() => { if (!dead) setSupport(LOADERS); });
    return () => { dead = true; };
  }, [wMc]);

  // Ely.by / Microsoft skins come from their own servers (via the backend)
  useEffect(() => {
    accounts.forEach((a) => {
      if (a.kind === "offline" || fetchedSkins.current.has(a.id)) return;
      fetchedSkins.current.add(a.id);
      invoke<Skin>("get_skin", { kind: a.kind, username: a.username, uuid: a.uuid })
        .then((sk) => {
          if (!sk) return;
          setSkins((prev) => ({ ...prev, [a.id]: sk }));
        })
        .catch(() => {});
    });
  }, [accounts]);

  const inst = instances.find((i) => i.id === instId) ?? null;
  const current = accounts.find((a) => a.id === selected) ?? null;
  const effRam = st.ramAuto ? autoRam(sysRam, inst?.loader ?? "vanilla") : ram;

  useEffect(() => {
    if (!inst?.background) {
      setActiveBackground("");
      return;
    }
    let active = true;
    invoke<string | null>("load_instance_background", { id: inst.id })
      .then((background) => { if (active) setActiveBackground(background ?? ""); })
      .catch((e) => {
        if (active) {
          setActiveBackground("");
          add(`Could not load instance background: ${e}`);
        }
      });
    return () => { active = false; };
  }, [inst?.id, inst?.background]);

  const visible = useMemo(() => vinfo.filter((v) => {
    if (v.kind === "release") return true;
    if (isExperimental(v)) return st.showExperimental;
    if (v.kind === "snapshot") return st.showSnapshots;
    if (v.kind === "old_beta") return st.showBeta;
    if (v.kind === "old_alpha") return st.showAlpha;
    return false;
  }), [vinfo, st]);
  const filtered = visible.filter((v) => v.id.includes(filter)).slice(0, 300);
  const firstRunMc = wMc || vinfo.find((v) => v.kind === "release")?.id || "";

  useEffect(() => {
    if (firstRunOpen && vinfo.length > 0 && !wMc) {
      setWMc(vinfo.find((v) => v.kind === "release")?.id ?? vinfo[0].id);
    }
  }, [firstRunOpen, vinfo, wMc]);

  // progress of the current download (looks back to the last "start" line)
  const progress = useMemo(() => {
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i] === "Creating instance..." || log[i] === "Logging in...") break;
      const m = log[i].match(/^(Assets|Libraries) (\d+)\/(\d+)/);
      if (m) return { label: m[1], pct: Math.round((+m[2] / +m[3]) * 100) };
    }
    return null;
  }, [log]);
  const status = log[log.length - 1] ?? "Ready";

  const play = async () => {
    if (!inst) return;
    setBusy(true);
    setMsCode(null);
    try {
      const gameArgs = st.launchFullscreen && !/(^|\s)--fullscreen(?:\s|$)/i.test(st.gameArgs)
        ? `${st.gameArgs} --fullscreen`.trim()
        : st.gameArgs;
      await invoke("play", {
        req: {
          instance: inst.id, ram: effRam, java: java || "java", ms_client_id: msClientId,
          java_mode: st.javaRuntime,
          jvm_args: st.jvmArgs, game_args: gameArgs, hide: st.hide,
          volume: st.volumeOn ? st.volume : null,
        },
      });
      add("Game started.");
    } catch (e) {
      add(`ERROR: ${e}`);
      setPage("console");
    } finally {
      setBusy(false);
      setMsCode(null);
    }
  };

  const addAccount = async (): Promise<boolean> => {
    setAddBusy(true);
    setAddErr("");
    setMsCode(null);
    try {
      const r = await invoke<AccList>("add_account", {
        req: { kind: addKind, username: addUser, password: addPass, ms_client_id: msClientId },
      });
      applyList(r);
      setAddUser("");
      setAddPass("");
      return true;
    } catch (e) {
      setAddErr(String(e));
      return false;
    } finally {
      setAddBusy(false);
      setMsCode(null);
    }
  };
  const firstRunLogin = async () => {
    setFirstRunError("");
    if (await addAccount()) setFirstRunStep(2);
  };
  const firstRunInstall = async () => {
    const mc = wMc || vinfo.find((v) => v.kind === "release")?.id || "";
    if (!mc) {
      setFirstRunError("Minecraft versions are not available yet. Try again in a moment.");
      return;
    }
    setFirstRunBusy(true);
    setFirstRunError("");
    try {
      const list = await invoke<Instance[]>("create_instance", {
        req: {
          name: wName.trim() || `${cap(wLoader)} ${mc}`,
          loader: wLoader,
          mc,
          java: java || "java",
          java_mode: st.javaRuntime,
          icon: "",
          description: "",
          background: "",
        },
      });
      setInstances(list);
      setInstId(list[list.length - 1]?.id ?? "");
      setFirstRunStep(3);
    } catch (e) {
      setFirstRunError(String(e));
    } finally {
      setFirstRunBusy(false);
    }
  };
  const finishFirstRun = async () => {
    setFirstRunError("");
    try {
      await invoke("save_settings", {
        data: { msClientId, cfKey, ram, java, instance: instId, settings: st, skins, showCrashReports, startup: true },
      });
      setStartup(true);
      setFirstRunOpen(false);
    } catch (e) {
      setFirstRunError(`Could not save setup: ${e}`);
    }
  };

  const chooseInstanceDirectory = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choose an instance folder",
        defaultPath: instanceDirectoryDraft || undefined,
      });
      if (typeof selected === "string") {
        setInstanceDirectoryDraft(selected);
        setInstanceDirectoryMessage("");
      }
    } catch (error) {
      setInstanceDirectoryMessage(`Could not open folder picker: ${error}`);
    }
  };

  const changeInstanceDirectory = async () => {
    setInstanceDirectoryBusy(true);
    setInstanceDirectoryMessage("");
    try {
      const result = await invoke<{ path: string; warning?: string | null }>("set_instance_directory", {
        path: instanceDirectoryDraft,
      });
      setInstanceDirectoryDraft(result.path);
      set("instanceDirectory", result.path);
      const alreadySet = st.instanceDirectory.toLowerCase() === result.path.toLowerCase();
      setInstanceDirectoryMessage(result.warning ?? (alreadySet
        ? "This is already the active instance folder."
        : "Instance folder changed. Existing instances were moved when present."));
    } catch (error) {
      setInstanceDirectoryMessage(`Could not change instance folder: ${error}`);
    } finally {
      setInstanceDirectoryBusy(false);
    }
  };
  const downloadJavaRuntime = async () => {
    if (!inst) return;
    setJavaRuntimeBusy(true);
    setJavaRuntimeMessage("");
    try {
      await invoke<string>("download_java_runtime", { mcVersion: inst.mc });
      setJavaRuntimeMessage(`Java runtime for Minecraft ${inst.mc} is ready. It is stored separately from system Java.`);
    } catch (error) {
      setJavaRuntimeMessage(`Could not download Java runtime: ${error}`);
    } finally {
      setJavaRuntimeBusy(false);
    }
  };
  const select = (id: string) => invoke<AccList>("select_account", { id }).then(applyList);
  const remove = (id: string) => invoke<AccList>("remove_account", { id }).then(applyList);

  // ---- instances ----
  const resetWizard = () => {
    setStep(1); setWMc(""); setWLoader("vanilla"); setSupport(null);
    setWName(""); setWIcon(""); setWDesc(""); setWBg(""); setCreateErr(""); nameEdited.current = false;
  };
  const newInstance = () => { resetWizard(); setTab("download"); setPage("versions"); };

  const createInstance = async () => {
    setCreateErr("");
    setStep(4);
    try {
      const list = await invoke<Instance[]>("create_instance", {
        req: { name: wName, loader: wLoader, mc: wMc, java: java || "java", java_mode: st.javaRuntime, icon: wIcon, description: wDesc, background: wBg },
      });
      setInstances(list);
      setInstId(list[list.length - 1].id);
      setStep(5);
    } catch (e) {
      setCreateErr(String(e));
      setStep(3);
    }
  };

  const startEdit = async (i: Instance) => {
    setEditId(null);
    setEditName(i.name); setEditIcon(i.icon);
    setEditDesc(i.description); setEditBg(""); setDelId(null);
    try {
      setEditBg(await invoke<string | null>("load_instance_background", { id: i.id }) ?? "");
      setEditId(i.id);
    } catch (e) {
      add(`Could not load instance background: ${e}`);
      setPage("console");
    }
  };
  const saveEdit = async () => {
    try {
      const updated = await invoke<Instance[]>("edit_instance", {
        req: { id: editId, name: editName, icon: editIcon, description: editDesc, background: editBg },
      });
      setInstances(updated);
      setActiveBackground(editBg);
      setEditId(null);
    } catch (e) { add(`ERROR: ${e}`); setPage("console"); }
  };
  const removeInst = async (id: string, deleteFiles: boolean) => {
    try {
      const l = await invoke<Instance[]>("remove_instance", { req: { id, delete_files: deleteFiles } });
      setInstances(l);
      if (instId === id) setInstId(l[0]?.id ?? "");
      setDelId(null);
    } catch (e) { add(`ERROR: ${e}`); setPage("console"); }
  };

  // custom logo/background: pick a file. Logos are cropped square to 96x96 PNG.
  // Backgrounds: static images (png/jpg) are shrunk to fit 960px wide JPEG; an animated
  // gif is kept as-is (unprocessed), since resizing through canvas would flatten it to
  // a single frame and lose the animation.
  const fileFor = useRef<"logo-new" | "logo-edit" | "bg-new" | "bg-edit">("logo-new");
  const pickFile = (target: "logo-new" | "logo-edit" | "bg-new" | "bg-edit") => {
    fileFor.current = target;
    if (fileRef.current) {
      fileRef.current.accept = target === "bg-new" || target === "bg-edit"
        ? "image/png,image/jpeg,image/gif"
        : "image/*";
    }
    fileRef.current?.click();
  };
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const target = fileFor.current;
    const isBg = target === "bg-new" || target === "bg-edit";

    const apply = (url: string) => {
      if (target === "logo-new") setWIcon(url);
      else if (target === "logo-edit") setEditIcon(url);
      else if (target === "bg-new") setWBg(url);
      else setEditBg(url);
    };

    // Keep GIF bytes untouched so their animation is preserved even when the picker omits MIME type.
    if (isBg && (f.type.toLowerCase() === "image/gif" || /\.gif$/i.test(f.name))) {
      const rd = new FileReader();
      rd.onload = () => {
        if (typeof rd.result !== "string" || !rd.result.startsWith("data:")) {
          add(`Could not read ${f.name} as a GIF image.`);
          return;
        }
        const encoded = rd.result.split(",", 2)[1];
        if (!encoded) {
          add(`Could not read ${f.name} as a GIF image.`);
          return;
        }
        const dataUrl = `data:image/gif;base64,${encoded}`;
        const img = new Image();
        img.onload = () => apply(dataUrl);
        img.onerror = () => add(`Could not decode ${f.name} as a GIF image.`);
        img.src = dataUrl;
      };
      rd.onerror = () => add(`Could not read ${f.name}: ${rd.error?.message ?? "file read failed"}`);
      rd.readAsDataURL(f);
      return;
    }

    // static images: crop/resize through canvas as before
    const rd = new FileReader();
    rd.onload = () => {
      if (typeof rd.result !== "string") {
        add(`Could not read ${f.name} as an image.`);
        return;
      }
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement("canvas");
        let url: string;
        if (isBg) {
          const W = 960, H = Math.round((img.height / img.width) * W);
          cv.width = W; cv.height = H;
          const ctx = cv.getContext("2d");
          if (!ctx) {
            add(`Could not process ${f.name}: image canvas is unavailable.`);
            return;
          }
          ctx.drawImage(img, 0, 0, W, H);
          url = cv.toDataURL("image/jpeg", 0.85);
        } else {
          const S = 96;
          cv.width = S; cv.height = S;
          const m = Math.min(img.width, img.height);
          const ctx = cv.getContext("2d");
          if (!ctx) {
            add(`Could not process ${f.name}: image canvas is unavailable.`);
            return;
          }
          ctx.drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, S, S);
          url = cv.toDataURL("image/png");
        }
        apply(url);
      };
      img.onerror = () => add(`Could not decode ${f.name} as an image.`);
      img.src = rd.result;
    };
    rd.onerror = () => add(`Could not read ${f.name}: ${rd.error?.message ?? "file read failed"}`);
    rd.readAsDataURL(f);
  };

  const shownName = current?.username ?? "No account";
  const skin = `https://mc-heads.net/body/${encodeURIComponent(shownName)}/220`;
  const nav: [Page, string, string][] = [
    ["play", "play", "Home"], ["account", "user", "Accounts"], ["versions", "grid", "Download"], ["mods", "puzzle", "Downloader"], ["console", "term", "Console"],
  ];

  return (
    <div className="shell" style={{ height: winH / (st.uiScale / 100) }}>
      {firstRunOpen && (
        <div className="onboarding-overlay">
          <section className="onboarding-card" aria-labelledby="onboarding-title">
            <header className="onboarding-brand">
              <span className="onboarding-logo"><Icon n="cube" /></span>
              <div><b>Arca Launcher</b><span>FIRST-TIME SETUP</span></div>
            </header>
            <div className="onboarding-progress" aria-label={`Setup step ${firstRunStep + 1} of 4`}>
              {["Welcome", "Login", "Instance", "Done"].map((label, index) => (
                <div key={label} className={"onboarding-progress-step" + (index === firstRunStep ? " active" : "") + (index < firstRunStep ? " complete" : "")}>
                  <span>{index < firstRunStep ? "✓" : index + 1}</span>{label}
                </div>
              ))}
            </div>

            {firstRunStep === 0 && (
              <div className="onboarding-content onboarding-welcome">
                <span className="onboarding-art"><Icon n="cube" /></span>
                <span className="eyebrow">YOUR MINECRAFT, YOUR WAY</span>
                <h1 id="onboarding-title">Welcome to Arca</h1>
                <p>Let’s get your launcher ready. Sign in with an account, then create your first Minecraft instance. You can skip either step and set it up later.</p>
                <button className="btn purple onboarding-primary" onClick={() => { setFirstRunError(""); setFirstRunStep(1); }}>Get started <span>→</span></button>
              </div>
            )}

            {firstRunStep === 1 && (
              <div className="onboarding-content">
                <span className="eyebrow">STEP 1 OF 2</span>
                <h1 id="onboarding-title">Choose how to sign in</h1>
                <p className="onboarding-description">Use an existing account or create an offline profile. You can add more accounts later.</p>
                <div className="onboarding-account-types">
                  {(["offline", "microsoft", "elyby"] as const).map((kind) => (
                    <button key={kind} className={"onboarding-account-type" + (addKind === kind ? " active" : "")} onClick={() => { setAddKind(kind); setAddErr(""); setFirstRunError(""); }}>
                      <span>{kind === "offline" ? "◉" : kind === "microsoft" ? "▦" : "✦"}</span>
                      <b>{KIND_LABEL[kind]}</b>
                      <small>{kind === "offline" ? "No online sign-in" : kind === "microsoft" ? "Official Microsoft login" : "Ely.by account"}</small>
                    </button>
                  ))}
                </div>

                <div className="onboarding-login-fields">
                  {addKind === "offline" && (<>
                    <label>Username</label>
                    <input value={addUser} onChange={(e) => setAddUser(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void firstRunLogin()} autoComplete="username" />
                  </>)}
                  {addKind === "elyby" && (<>
                    <label>Username or email</label>
                    <input value={addUser} onChange={(e) => setAddUser(e.target.value)} autoComplete="username" />
                    <label>Password <span className="field-note">For 2FA, use password:2FACODE</span></label>
                    <input type="password" value={addPass} onChange={(e) => setAddPass(e.target.value)} autoComplete="current-password" />
                  </>)}
                  {addKind === "microsoft" && (<>
                    <label>Azure client ID</label>
                    <input value={msClientId} onChange={(e) => setMsClientId(e.target.value)} placeholder="Your Microsoft application client ID" />
                    <p className="hint onboarding-login-hint">A browser window will open to complete Microsoft sign-in.</p>
                  </>)}
                </div>

                {msCode && addBusy && <div className="code onboarding-code">Enter code <b>{msCode.code}</b> at {msCode.url}</div>}
                {(firstRunError || addErr) && <div className="err">{firstRunError || addErr}</div>}
                <footer className="onboarding-actions">
                  <button className="mini" onClick={() => { setFirstRunError(""); setFirstRunStep(0); }} disabled={addBusy}>Back</button>
                  <button className="onboarding-skip" onClick={() => { setFirstRunError(""); setFirstRunStep(2); }} disabled={addBusy}>Continue without signing in</button>
                  <button className="btn purple" onClick={() => void firstRunLogin()} disabled={addBusy}>
                    {addBusy ? "Signing in..." : addKind === "offline" ? "Add account" : "Sign in"}
                  </button>
                </footer>
              </div>
            )}

            {firstRunStep === 2 && (
              <div className="onboarding-content onboarding-instance">
                <span className="eyebrow">STEP 2 OF 2</span>
                <h1 id="onboarding-title">Install your first instance</h1>
                <p className="onboarding-description">Choose a Minecraft release and loader. This can take a few minutes to download.</p>
                <label>Minecraft version</label>
                <select value={firstRunMc} onChange={(e) => { setWMc(e.target.value); setFirstRunError(""); }}>
                  {vinfo.filter((v) => v.kind === "release").map((v) => <option key={v.id} value={v.id}>{v.id} · Release</option>)}
                </select>
                {!vinfo.length && <p className="hint">Loading Minecraft versions...</p>}
                <label>Mod loader</label>
                <div className="onboarding-loaders">
                  {LOADERS.map((loader) => {
                    const supported = loader === "vanilla" || (support !== null && support.includes(loader));
                    return (
                      <button key={loader} className={"onboarding-loader" + (wLoader === loader ? " active" : "")}
                        disabled={!supported} onClick={() => setWLoader(loader)}>
                        <LoaderIcon loader={loader} size={30} />
                        <span><b>{cap(loader)}</b><small>{supported ? SHORT[loader] : support === null ? "Checking compatibility..." : "Not available for this version"}</small></span>
                      </button>
                    );
                  })}
                </div>
                <label>Instance name <span className="field-note">Optional</span></label>
                <input value={wName} onChange={(e) => setWName(e.target.value)} placeholder={`${cap(wLoader)} ${firstRunMc}`} />
                {firstRunError && <div className="err">{firstRunError}</div>}
                {firstRunBusy && (
                  <div className="onboarding-download">
                    <span>{status}</span>
                    <div className="pbar"><span style={{ width: `${progress?.pct ?? 5}%` }} /></div>
                    {progress && <small>{progress.label} {progress.pct}%</small>}
                  </div>
                )}
                <footer className="onboarding-actions">
                  <button className="mini" onClick={() => { setFirstRunError(""); setFirstRunStep(1); }} disabled={firstRunBusy}>Back</button>
                  <button className="onboarding-skip" onClick={() => { setFirstRunError(""); setFirstRunStep(3); }} disabled={firstRunBusy}>Skip for now</button>
                  <button className="btn purple" onClick={() => void firstRunInstall()} disabled={firstRunBusy || !firstRunMc || (wLoader !== "vanilla" && !support?.includes(wLoader))}>
                    {firstRunBusy ? "Installing..." : "Install instance"}
                  </button>
                </footer>
              </div>
            )}

            {firstRunStep === 3 && (
              <div className="onboarding-content onboarding-welcome">
                <span className="onboarding-art onboarding-success">✓</span>
                <span className="eyebrow">YOU’RE ALL SET</span>
                <h1 id="onboarding-title">Ready to play</h1>
                <p>{current ? `Signed in as ${current.username}.` : "You can sign in any time from Accounts."} {inst ? `${inst.name} is ready to launch.` : "Create an instance whenever you’re ready."}</p>
                {firstRunError && <div className="err">{firstRunError}</div>}
                <button className="btn purple onboarding-primary" onClick={() => void finishFirstRun()}>Start using Arca <span>→</span></button>
              </div>
            )}
          </section>
        </div>
      )}
      <input ref={fileRef} type="file" accept="image/*" onChange={onFile} style={{ display: "none" }} />
      <header className="topbar">
        <div className="logo"><Icon n="cube" /></div>
        <div className="brand">Arca Launcher</div>
        <div className="chips">
          <span className="chip"><i className="dot" />{current ? KIND_LABEL[current.kind] : "No account"}</span>
          <span className="chip">{inst ? `${cap(inst.loader)} ${inst.mc}` : "No instance"}</span>
          <span className="chip">{(effRam / 1024).toFixed(1)} GB RAM</span>
        </div>
      </header>

      <div className="body">
        <nav className="side">
          {nav.map(([p, ic, label]) => (
            <button key={p} className={"nav" + (page === p ? " on" : "")} onClick={() => setPage(p)} title={label}>
              <Icon n={ic} filled={ic === "play"} />
            </button>
          ))}
          <div className="grow" />
          <button className={"nav" + (page === "settings" ? " on" : "")} onClick={() => setPage("settings")} title="Settings">
            <Icon n="gear" />
          </button>
        </nav>

        <main className="content">
          <div key={page === "mods" ? "__mods__" : page} className={"pagewrap " + (fade === "out" ? "out" : "in")}
            style={page === "mods" ? { display: "none" } : undefined}>
          {page === "play" && (
            <>
              <div className="top">
                <section className={"hero" + (activeBackground ? " has-bg" : "")}>
                  {activeBackground && <BgPreview className="hero-background" src={activeBackground} />}
                  <div className="pickwrap">
                    <button className="instpick" onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}>
                      {inst ? (<><InstIcon inst={inst} size={22} /><span>{inst.name}</span></>) : <span>No instance</span>}
                      <span className="chev">▾</span>
                    </button>
                    {menuOpen && (<>
                      <div className="scrim" onClick={closeMenu} />
                      <div className={"menu" + (menuClosing ? " closing" : "")}>
                        {instances.map((i) => (
                          <button key={i.id} className={"mitem" + (i.id === instId ? " on" : "")}
                            onClick={() => { setInstId(i.id); closeMenu(); }}>
                            <InstIcon inst={i} size={30} />
                            <div><b>{i.name}</b><small>{cap(i.loader)} · {i.mc}</small></div>
                          </button>
                        ))}
                        <button className="mitem add" onClick={() => { closeMenu(); newInstance(); }}>＋ New instance</button>
                      </div>
                    </>)}
                  </div>

                  <div className="herohead">
                    {inst && <InstIcon inst={inst} size={72} />}
                    <div>
                      <h1>{inst ? inst.name : "No instance yet"}</h1>
                      {inst && <span className="tag">Minecraft {inst.mc} · {cap(inst.loader)}</span>}
                    </div>
                  </div>
                  <p>{inst ? (inst.description || BLURB[inst.loader]) : "Download a Minecraft version to get started."}</p>

                  <div className="launchrow">
                    <button className="launch" disabled={busy}
                      onClick={!current ? () => setPage("account") : !inst ? newInstance : play}>
                      <b>{busy ? "WORKING..." : !current ? "ADD AN ACCOUNT" : !inst ? "NEW INSTANCE" : `LAUNCH ${inst.mc}`}</b>
                      <small>{busy ? status.slice(0, 34) : !current ? "You need an account to play" : !inst ? "Download a version first" : `${inst.name} · ${KIND_LABEL[current.kind]}`}</small>
                      {busy && progress && <span className="bar" style={{ width: `${progress.pct}%` }} />}
                    </button>
                  </div>
                </section>

                <div className="rightcol">
                <aside className="player">
                  {current && skins[current.id]?.data ? (
                    <SkinModel data={skins[current.id]!.data!} slim={skins[current.id]!.slim} />
                  ) : current?.kind === "offline" && !skinFail ? (
                    <img className="skin" src={skin} alt="" onError={() => setSkinFail(true)} />
                  ) : <div className="skin ph" />}
                  <div className="pname">{shownName}</div>
                  <button className="btn purple" onClick={() => setPage("account")}>Manage Account</button>
                </aside>

                <section className="changelog">
                  <h4>Changelog</h4>
                  {CHANGELOG.map((c) => (
                    <div key={c.v} className="cl">
                      <div className="clhead"><span className="clv">v{c.v}</span><b>{c.title}</b></div>
                      <ul>{c.items.map((it) => <li key={it}>{it}</li>)}</ul>
                    </div>
                  ))}
                </section>
                </div>
              </div>
            </>
          )}

          {page === "account" && (
            <section className="panel account-page">
              <header className="page-heading">
                <div><span className="eyebrow">PLAYER PROFILE</span><h2>Accounts</h2>
                  <p>Choose who you want to play as and manage your sign-in methods.</p></div>
                <span className="count-chip">{accounts.length} {accounts.length === 1 ? "account" : "accounts"}</span>
              </header>

              <div className="account-layout">
                <section className="account-section">
                  <div className="section-heading">
                    <div><h3>Your accounts</h3><p>The selected account will be used when you launch Minecraft.</p></div>
                  </div>
                  <div className="alist">
                    {accounts.length === 0 && (
                      <div className="account-empty"><span className="empty-avatar"><Icon n="user" /></span>
                        <b>No accounts yet</b><p>Add an account to get started.</p></div>
                    )}
                    {accounts.map((a) => (
                      <div key={a.id} className={"acc" + (a.id === selected ? " on" : "")}>
                        <Avatar acc={a} skin={skins[a.id] ?? null} />
                        <div className="ainfo"><b>{a.username}</b><span>{KIND_LABEL[a.kind]}</span></div>
                        {a.id === selected
                          ? <span className="badge">Selected</span>
                          : <button className="mini" onClick={() => select(a.id)}>Select</button>}
                        <button className="mini danger" onClick={() => remove(a.id)}>Remove</button>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="account-section add-account">
                  <div className="section-heading">
                    <div><h3>Add an account</h3><p>Connect a new profile to your launcher.</p></div>
                  </div>
                  <div className="seg">
                    {KINDS.map(([k, l]) => (
                      <button key={k} className={addKind === k ? "on" : ""} onClick={() => { setAddKind(k); setAddErr(""); }}>{l}</button>
                    ))}
                  </div>

                  {addKind === "offline" && (<>
                    <label>Username <span className="field-note">Added instantly</span></label>
                    <input value={addUser} onChange={(e) => setAddUser(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addAccount()} />
                  </>)}
                  {addKind === "elyby" && (<>
                    <label>Ely.by username / email</label>
                    <input value={addUser} onChange={(e) => setAddUser(e.target.value)} />
                    <label>Password <span className="field-note">For 2FA, use password:2FACODE</span></label>
                    <input type="password" value={addPass} onChange={(e) => setAddPass(e.target.value)} />
                  </>)}
                  {addKind === "microsoft" && (
                    <p className="hint account-notice">
                      A browser window opens with a code to enter. {msClientId.trim() ? "" : "Set your Azure client ID in Settings first."}
                    </p>
                  )}

                  {msCode && addBusy && <div className="code">Enter code <b>{msCode.code}</b> at {msCode.url}</div>}
                  {addErr && <div className="err">{addErr}</div>}
                  <button className="btn purple addbtn" disabled={addBusy} onClick={addAccount}>
                    {addBusy ? "Waiting..." : addKind === "offline" ? "Add account" : addKind === "elyby" ? "Sign in & add" : "Sign in with Microsoft"}
                  </button>
                </section>
              </div>
            </section>
          )}

          {page === "versions" && (
            <section className="panel">
              <div className="ptop">
                <div className="page-heading compact">
                  <div><span className="eyebrow">YOUR LIBRARY</span><h2>Instances</h2>
                    <p>Keep separate Minecraft setups for every way you play.</p></div>
                </div>
                <div className="seg">
                  <button className={tab === "download" ? "on" : ""} onClick={() => setTab("download")}>New instance</button>
                  <button className={tab === "instances" ? "on" : ""} onClick={() => setTab("instances")}>My instances ({instances.length})</button>
                </div>
              </div>

              {tab === "download" && (<>
                <div className="steps">
                  {["Version", "Loader", "Name", "Download"].map((s, i) => (
                    <span key={s} className={"stp" + (step === i + 1 || (step === 5 && i === 3) ? " on" : "") + (step > i + 1 ? " done" : "")}>{i + 1}. {s}</span>
                  ))}
                </div>

                <div key={step} className="stepbox">
                {step === 1 && (<>
                  <label>Pick a Minecraft version</label>
                  <input placeholder="Search: 1.20, 1.21.1 ..." value={filter} onChange={(e) => setFilter(e.target.value)} />
                  <div className="vlist">
                    {filtered.map((v) => (
                      <button key={v.id} className={"vrow " + v.kind + (v.id === wMc ? " on" : "")}
                        onClick={() => { setWMc(v.id); setStep(2); }}>
                        <b>{v.id}</b><span className="vkind">{kindLabel(v)}</span>
                      </button>
                    ))}
                  </div>
                  {vinfo.length === 0 && <p className="hint">Loading the version list...</p>}
                  {(st.showBeta || st.showAlpha) && <p className="hint">Old alpha and beta versions need Java 8 and may not start correctly.</p>}
                  {!st.showSnapshots && !st.showBeta && !st.showAlpha && !st.showExperimental && (
                    <p className="hint">Only releases are shown. Turn on snapshots, beta, alpha or experimental in Settings.</p>
                  )}
                </>)}

                {step === 2 && (<>
                  <label>Minecraft {wMc}: pick a loader</label>
                  <div className="lgrid">
                    {LOADERS.map((l) => {
                      const ok = l === "vanilla" || (support !== null && support.includes(l));
                      return (
                        <button key={l} className={"lcard" + (wLoader === l ? " on" : "")} disabled={!ok}
                          onClick={() => { setWLoader(l); if (!nameEdited.current) setWName(`${cap(l)} ${wMc}`); setStep(3); }}>
                          <LoaderIcon loader={l} size={44} />
                          <div><b>{cap(l)}</b><small>{ok ? SHORT[l] : support === null ? "Checking..." : "Not available for this version"}</small></div>
                        </button>
                      );
                    })}
                  </div>
                  <div className="btnrow"><button className="mini" onClick={() => setStep(1)}>← Back</button></div>
                </>)}

                {step === 3 && (<>
                  <label>Name your instance</label>
                  <input value={wName} onChange={(e) => { nameEdited.current = true; setWName(e.target.value); }} />
                  <label>Logo</label>
                  <div className="logorow">
                    <InstIcon inst={{ loader: wLoader, icon: wIcon }} size={64} />
                    <button className="mini" onClick={() => pickFile("logo-new")}>Choose image...</button>
                    <button className="mini" onClick={() => setWIcon("")}>Use default</button>
                  </div>
                  <label>Description (optional)</label>
                  <textarea className="desc" rows={3} value={wDesc} onChange={(e) => setWDesc(e.target.value)}
                    placeholder="What's this instance for?" />
                  <label>Background (optional) — image or gif</label>
                  <div className="bgrow">
                    {wBg ? <BgPreview className="bgpreview" src={wBg} /> : <div className="bgpreview ph" />}
                    <button className="mini" onClick={() => pickFile("bg-new")}>Choose file...</button>
                    {wBg && <button className="mini" onClick={() => setWBg("")}>Remove</button>}
                  </div>
                  <p className="hint">Minecraft {wMc} · {cap(wLoader)}</p>
                  {createErr && <div className="err">{createErr}</div>}
                  <div className="btnrow">
                    <button className="mini" onClick={() => setStep(2)}>← Back</button>
                    <button className="btn purple addbtn" disabled={!wName.trim()} onClick={createInstance}>Create and download</button>
                  </div>
                </>)}

                {step === 4 && (
                  <div className="dl">
                    <InstIcon inst={{ loader: wLoader, icon: wIcon }} size={64} />
                    <h3>Downloading {wName}...</h3>
                    <p className="hint">{status}</p>
                    <div className="pbar"><span style={{ width: `${progress ? progress.pct : 5}%` }} /></div>
                    <p className="hint">{progress ? `${progress.label} ${progress.pct}%` : "Preparing..."}</p>
                  </div>
                )}

                {step === 5 && (
                  <div className="dl">
                    <InstIcon inst={{ loader: wLoader, icon: wIcon }} size={64} />
                    <h3>{wName} is ready</h3>
                    <div className="btnrow">
                      <button className="btn purple addbtn" onClick={() => setPage("play")}>Go to home</button>
                      <button className="mini" onClick={resetWizard}>Download another</button>
                    </div>
                  </div>
                )}
                </div>
              </>)}

              {tab === "instances" && (
                <div className="ilist">
                  {instances.length === 0 && (
                    <div className="instances-empty"><span className="empty-cube"><Icon n="cube" /></span>
                      <b>Your library is empty</b><p>Create an instance to start playing.</p>
                      <button className="btn purple" onClick={() => setTab("download")}>Create an instance</button></div>
                  )}
                  {instances.map((i) => (
                    <div key={i.id} className={"icard" + (i.id === instId ? " on" : "")}>
                      <div className="icard-top">
                        <div className="icard-art"><InstIcon inst={i} size={52} /><span>{i.mc}</span></div>
                        {i.id === instId && <span className="badge">Selected</span>}
                      </div>
                      <div className="iinfo">
                        <b>{i.name}</b><span>{cap(i.loader)} <i /> Minecraft {i.mc}</span>
                        {i.description && <p>{i.description}</p>}
                      </div>
                      <div className="icard-actions">
                        {delId === i.id ? (<>
                          <span className="hint">Delete?</span>
                          <button className="mini danger" onClick={() => removeInst(i.id, false)}>Remove</button>
                          <button className="mini danger" onClick={() => removeInst(i.id, true)}>Remove + delete files</button>
                          <button className="mini" onClick={() => setDelId(null)}>Cancel</button>
                        </>) : (<>
                          <button className="mini" onClick={() => setContentInst(i)}>Content</button>
                          {i.id !== instId && <button className="mini select-instance" onClick={() => setInstId(i.id)}>Select</button>}
                          <button className="mini" onClick={() => startEdit(i)}>Edit</button>
                          <button className="mini danger" onClick={() => setDelId(i.id)}>Delete</button>
                        </>)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {page === "console" && (
            <section className="panel full console-page">
              <header className="page-heading">
                <div><span className="eyebrow">LIVE OUTPUT</span><h2>Console</h2>
                  <p>Launcher activity, downloads, and game launch diagnostics.</p></div>
                <div className="console-heading-actions">
                  <span className="count-chip">{log.length} {log.length === 1 ? "entry" : "entries"}</span>
                  <button className="mini" onClick={() => setLog([])} disabled={log.length === 0}>Clear log</button>
                </div>
              </header>
              <div className="console-toolbar"><span className={"console-indicator" + (busy ? " active" : "")} />
                <b>{busy ? "Operation in progress" : status}</b><span className="console-session">SESSION OUTPUT</span></div>
              <div className="log" ref={logRef} role="log" aria-live="polite" aria-label="Launcher console output">
                {log.length === 0
                  ? <div className="console-empty"><span>›_</span><b>All quiet for now</b><p>Launcher activity will appear here.</p></div>
                  : log.map((l, i) => <div key={i} className={"log-line" + (/error|failed|could not/i.test(l) ? " error" : "")}>
                    <span className="log-index">{String(i + 1).padStart(3, "0")}</span><span>{l}</span>
                  </div>)}
              </div>
            </section>
          )}

          {page === "settings" && (
            <section className="panel settings-page">
              <header className="page-heading">
                <div><span className="eyebrow">PREFERENCES</span><h2>Settings</h2>
                  <p>Fine-tune performance, game behavior, and launcher integrations.</p></div>
              </header>
              <div className="settings-list">
                <section className="setting-card">
                  <div className="setting-title"><span className="setting-icon">▧</span><div><h3>Memory</h3><p>Choose how much RAM Minecraft can use.</p></div></div>
                  <label className="check">
                    <input type="checkbox" checked={st.ramAuto} onChange={(e) => set("ramAuto", e.target.checked)} />
                    Auto ({(autoRam(sysRam, inst?.loader ?? "vanilla") / 1024).toFixed(1)} GB{sysRam ? ` of ${(sysRam / 1024).toFixed(0)} GB` : ""})
                  </label>
                  <label>Memory allocation <span className="field-value">{(effRam / 1024).toFixed(1)} GB</span></label>
                  <input type="range" disabled={st.ramAuto} min={1024} max={Math.max(2048, Math.floor((sysRam || 16384) / 512) * 512)}
                    step={512} value={ram} onChange={(e) => setRam(+e.target.value)} />
                </section>

                <section className="setting-card">
                  <div className="setting-title"><span className="setting-icon">⌘</span><div><h3>Game</h3><p>Runtime, launch arguments, and in-game options.</p></div></div>
                  <label>Java runtime</label>
                  <select value={st.javaRuntime} onChange={(e) => {
                    set("javaRuntime", e.target.value as Settings["javaRuntime"]);
                    setJavaRuntimeMessage("");
                  }}>
                    <option value="system">System Java (default)</option>
                    <option value="launcher">Launcher-managed Java</option>
                  </select>
                  <p className="setting-note">
                    System uses Java installed on Windows or available in PATH. Launcher-managed downloads a private runtime into the launcher's jre folder when needed.
                  </p>
                  {st.javaRuntime === "launcher" && <>
                    <button className="btn" onClick={downloadJavaRuntime} disabled={!inst || javaRuntimeBusy}>
                      {javaRuntimeBusy ? "Downloading Java..." : `Download Java for ${inst?.mc ?? "selected instance"}`}
                    </button>
                    {javaRuntimeMessage && <p className="setting-note">{javaRuntimeMessage}</p>}
                  </>}
                  <label>Custom Java path <span className="field-note">Leave as "java" to use the selected runtime</span></label>
                  <input value={java} onChange={(e) => setJava(e.target.value)} />
                  <label>JVM arguments</label>
                  <input placeholder="-XX:+UseG1GC -XX:MaxGCPauseMillis=50" value={st.jvmArgs} onChange={(e) => set("jvmArgs", e.target.value)} />
                  <label>Game arguments</label>
                  <input placeholder="--fullscreen" value={st.gameArgs} onChange={(e) => set("gameArgs", e.target.value)} />
                  <label className="check">
                    <input type="checkbox" checked={st.launchFullscreen} onChange={(e) => set("launchFullscreen", e.target.checked)} />
                    Start Minecraft in fullscreen
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={showCrashReports} onChange={(e) => setShowCrashReports(e.target.checked)} />
                    Show a crash report when the game crashes
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={st.volumeOn} onChange={(e) => set("volumeOn", e.target.checked)} />
                    Set game master volume on launch
                  </label>
                  <label>Master volume <span className="field-value">{st.volume}%</span></label>
                  <input type="range" min={0} max={100} step={5} disabled={!st.volumeOn} value={st.volume} onChange={(e) => set("volume", +e.target.value)} />
                </section>

                <section className="setting-card">
                  <div className="setting-title"><span className="setting-icon">◈</span><div><h3>Launcher</h3><p>Set the launch experience and interface scale.</p></div></div>
                  <label>When the game starts</label>
                  <select value={st.hide} onChange={(e) => set("hide", e.target.value as Settings["hide"])}>
                    <option value="keep">Keep the launcher open</option>
                    <option value="hide">Hide it until the game closes</option>
                    <option value="close">Close the launcher</option>
                  </select>
                  <label>Interface size <span className="field-value">{st.uiScale}%</span></label>
                  <input type="range" min={80} max={140} step={5} value={st.uiScale} onChange={(e) => set("uiScale", +e.target.value)} />
                </section>

                <section className="setting-card">
                  <div className="setting-title"><span className="setting-icon">◷</span><div><h3>Version list</h3><p>Choose which Minecraft releases appear in the browser.</p></div></div>
                  <label className="check"><input type="checkbox" checked={st.showSnapshots} onChange={(e) => set("showSnapshots", e.target.checked)} /> Snapshots</label>
                  <label className="check"><input type="checkbox" checked={st.showExperimental} onChange={(e) => set("showExperimental", e.target.checked)} /> Experimental and special versions</label>
                  <label className="check"><input type="checkbox" checked={st.showBeta} onChange={(e) => set("showBeta", e.target.checked)} /> Old beta</label>
                  <label className="check"><input type="checkbox" checked={st.showAlpha} onChange={(e) => set("showAlpha", e.target.checked)} /> Old alpha</label>
                </section>

                <section className="setting-card">
                  <div className="setting-title"><span className="setting-icon">◎</span><div><h3>Microsoft account</h3><p>Required to authenticate Microsoft accounts.</p></div></div>
                  <label>Azure client ID</label>
                  <input value={msClientId} onChange={(e) => setMsClientId(e.target.value)} />
                </section>

                <section className="setting-card">
                  <div className="setting-title"><span className="setting-icon">⬡</span><div><h3>CurseForge</h3><p>Optional key for browsing CurseForge content.</p></div></div>
                  <label>CurseForge API key <span className="field-note">Free at console.curseforge.com</span></label>
                  <input type="password" value={cfKey} onChange={(e) => setCfKey(e.target.value)} />
                </section>

                <section className="setting-card">
                  <div className="setting-title"><span className="setting-icon">▦</span><div><h3>Instances</h3><p>Manage instance storage and installation activity.</p></div></div>
                  <label>Instance folder</label>
                  <div className="folder-picker-row">
                    <span className="folder-picker-path" title={displayPath(instanceDirectoryDraft) || "No folder selected"}>
                      {displayPath(instanceDirectoryDraft) || "No folder selected"}
                    </span>
                    <button className="mini" onClick={chooseInstanceDirectory} disabled={instanceDirectoryBusy}>
                      Browse…
                    </button>
                  </div>
                  <button className="btn" onClick={changeInstanceDirectory} disabled={instanceDirectoryBusy || !instanceDirectoryDraft.trim()}>
                    {instanceDirectoryBusy ? "Moving instances..." : "Move instances to folder"}
                  </button>
                  <p className="setting-note">Existing instances move to this folder. Choose an empty folder and keep it available while using the launcher.</p>
                  {instanceDirectoryMessage && <p className="setting-note">{instanceDirectoryMessage}</p>}
                  <label>Simultaneous installs <span className="field-value">{st.downloadConcurrency}</span></label>
                  <input type="range" min={1} max={5} step={1} value={st.downloadConcurrency}
                    onChange={(e) => set("downloadConcurrency", +e.target.value)} />
                  <p className="setting-note">Higher values can use more bandwidth and system resources.</p>
                  <label className="check">
                    <input type="checkbox" checked={st.autoClearDownloads}
                      onChange={(e) => set("autoClearDownloads", e.target.checked)} />
                    Automatically clear completed downloads
                  </label>
                  <p className="setting-note">Turn this off to keep completed downloads in the tray until dismissed.</p>
                </section>
              </div>
            </section>
          )}
          </div>

          <div className={"pagewrap " + (fade === "out" ? "out" : "in")} style={page === "mods" ? undefined : { display: "none" }}>
            <ModsPage
              inst={inst}
              cfKey={cfKey}
              java={java}
              javaMode={st.javaRuntime}
              active={page === "mods"}
              goSettings={() => setPage("settings")}
              onPackInstalled={(list) => {
                const next = list.map((i) => ({
                  ...i,
                  description: (i as Partial<Instance>).description ?? "",
                  background: (i as Partial<Instance>).background ?? "",
                }) as Instance);
                setInstances(next);
                setInstId(next[next.length - 1]?.id ?? "");
              }}
            />
          </div>
        </main>
      </div>

      {contentInst && (
        <Modal title={`Installed content — ${contentInst.name}`} wide onClose={() => setContentInst(null)}>
          <ContentPage inst={contentInst} />
        </Modal>
      )}

      {editId && (
        <div className="editbackdrop" onClick={() => setEditId(null)}>
          <section
            className="editdialog pop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-instance-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="editdialoghead">
              <div className="editdialogtitle">
                <h2 id="edit-instance-title">Edit instance</h2>
                <p>Customize how this instance looks in your launcher.</p>
              </div>
              <button className="mini editclose" type="button" aria-label="Close edit instance dialog" onClick={() => setEditId(null)}>✕</button>
            </header>
            <form
              className="editdialogbody"
              onSubmit={(e) => { e.preventDefault(); void saveEdit(); }}
            >
              <div className="editfield">
                <label htmlFor="edit-instance-name">Name</label>
                <input
                  id="edit-instance-name"
                  className="editinput"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="editfield">
                <label>Logo</label>
                <div className="editassetrow">
                  <div className="editiconpreview">
                    <InstIcon inst={{ loader: instances.find((x) => x.id === editId)?.loader ?? "vanilla", icon: editIcon }} size={64} />
                  </div>
                  <div className="editassetactions">
                    <button className="mini" type="button" onClick={() => pickFile("logo-edit")}>Choose image...</button>
                    <button className="mini" type="button" onClick={() => setEditIcon("")}>Use default</button>
                  </div>
                </div>
              </div>

              <div className="editfield">
                <label htmlFor="edit-instance-description">Description</label>
                <textarea
                  id="edit-instance-description"
                  className="desc edittextarea"
                  rows={4}
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  placeholder="What's this instance for?"
                />
              </div>

              <div className="editfield">
                <label>Background <span className="editoptional">Image or GIF</span></label>
                <div className="editassetrow editbackgroundrow">
                  {editBg
                    ? <BgPreview className="bgpreview editbgpreview" src={editBg} />
                    : <div className="bgpreview ph editbgpreview"><span>No background selected</span></div>}
                  <div className="editassetactions">
                    <button className="mini" type="button" onClick={() => pickFile("bg-edit")}>Choose file...</button>
                    {editBg && <button className="mini" type="button" onClick={() => setEditBg("")}>Remove</button>}
                  </div>
                </div>
              </div>

              <footer className="btnrow editdialogfooter">
                <button className="mini" type="button" onClick={() => setEditId(null)}>Cancel</button>
                <button className="btn purple addbtn" type="submit" disabled={!editName.trim()}>Save changes</button>
              </footer>
            </form>
          </section>
        </div>
      )}

      <DownloadOverlay />
      <CrashWatcher />
    </div>
  );
}

export default function App() {
  return (
    <DownloadsProvider>
      <AppInner />
    </DownloadsProvider>
  );
}