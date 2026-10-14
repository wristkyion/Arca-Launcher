import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ModsPage from "./mods";
import { DownloadsProvider, DownloadOverlay } from "./downloads";
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
  hide: "keep" | "hide" | "close";
  volumeOn: boolean; volume: number; uiScale: number;
  showSnapshots: boolean; showExperimental: boolean; showBeta: boolean; showAlpha: boolean;
};
const DEFAULTS: Settings = {
  ramAuto: true, jvmArgs: "", gameArgs: "", hide: "keep",
  volumeOn: false, volume: 100, uiScale: 100,
  showSnapshots: false, showExperimental: false, showBeta: false, showAlpha: false,
};

// Edit this list to publish your own launcher changelogs (newest first).
const CHANGELOG: { v: string; title: string; items: string[] }[] = [
  { v: "1.0", title: "Arca Launcher", items: ["First public release"] },
];

/** Auto RAM: 3 GB for vanilla, 6 GB for modded, never more than 60% of the machine. */
const autoRam = (total: number, loader: string) => {
  const want = loader === "vanilla" ? 3072 : 6144;
  const cap = total ? Math.floor((total * 0.6) / 512) * 512 : want;
  return Math.max(1024, Math.min(want, cap));
};
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

const pref = (k: string, d: string) => localStorage.getItem(k) ?? d;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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

/** Stand-in loader logos (original artwork). Pick a custom image to use official logos. */
function LoaderIcon({ loader, size }: { loader: string; size: number }) {
  const p = { width: size, height: size, viewBox: "0 0 64 64", style: { flexShrink: 0 } } as const;
  switch (loader) {
    case "forge":
      return (<svg {...p}><rect width="64" height="64" rx="14" fill="#25314a" />
        <path d="M10 22h36c0 7-5 10-10 11v6h7v7H20v-7h7v-6c-6-1-11-4-11-11H10z" fill="#e8742a" />
        <path d="M46 22l9-4v7l-9 1z" fill="#e8742a" /></svg>);
    case "fabric":
      return (<svg {...p}><defs><clipPath id="fabc"><rect width="64" height="64" rx="14" /></clipPath></defs>
        <rect width="64" height="64" rx="14" fill="#d9c9a3" />
        <g clipPath="url(#fabc)" stroke="#a98f55" strokeWidth="6" fill="none">
          <path d="M-4 20L44 68M20 -4L68 44M-4 44L20 68M44 -4L68 20" /></g></svg>);
    case "quilt":
      return (<svg {...p}><rect width="64" height="64" rx="14" fill="#1b1830" />
        <rect x="6" y="6" width="24" height="24" rx="4" fill="#6c8cff" /><rect x="34" y="6" width="24" height="24" rx="4" fill="#f2b84b" />
        <rect x="6" y="34" width="24" height="24" rx="4" fill="#e0607e" /><rect x="34" y="34" width="24" height="24" rx="4" fill="#5ec98e" />
        <path d="M32 4V60M4 32H60" stroke="#fff" strokeDasharray="3 3" opacity=".6" /></svg>);
    case "neoforge":
      return (<svg {...p}><rect width="64" height="64" rx="14" fill="#2a1d12" />
        <path d="M32 8l20 12v24L32 56 12 44V20z" fill="#f08a24" />
        <path d="M24 42V22h4l8 12V22h4v20h-4l-8-12v12z" fill="#2a1d12" /></svg>);
    default:
      return (<svg {...p}><rect width="64" height="64" rx="14" fill="#1b2a1b" />
        <path d="M32 10l22 11-22 11L10 21z" fill="#6cc51f" />
        <path d="M10 21l22 11v22L10 43z" fill="#8b5a2b" />
        <path d="M54 21v22L32 54V32z" fill="#6e4421" /></svg>);
  }
}

function InstIcon({ inst, size }: { inst: { loader: string; icon?: string }; size: number }) {
  if (inst.icon)
    return <img className="insticon" src={inst.icon} width={size} height={size} style={{ borderRadius: size * 0.22 }} alt="" />;
  return <LoaderIcon loader={inst.loader} size={size} />;
}

function AppInner() {
  const [page, setPageNow] = useState<Page>("play");
  const [fade, setFade] = useState<"in" | "out">("in");
  const pageRef = useRef<Page>("play");
  pageRef.current = page;
  const setPage = (p: Page) => {
    if (p === pageRef.current) return;
    setFade("out");
    setTimeout(() => { setPageNow(p); setFade("in"); }, 160);
  };

  // accounts
  const [accounts, setAccounts] = useState<Acc[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [addKind, setAddKind] = useState("offline");
  const [addUser, setAddUser] = useState("");
  const [addPass, setAddPass] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addErr, setAddErr] = useState("");
  const [msClientId, setMsClientId] = useState(pref("msClientId", ""));
  const [cfKey, setCfKey] = useState(pref("cfKey", ""));

  // instances
  const [instances, setInstances] = useState<Instance[]>([]);
  const [instId, setInstId] = useState(pref("instance", ""));
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
  const [st, setSt] = useState<Settings>(() => {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("settings") ?? "{}") }; } catch { return DEFAULTS; }
  });
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSt((p) => ({ ...p, [k]: v }));
  const [ram, setRam] = useState(parseInt(pref("ram", "4096")));
  const [java, setJava] = useState(pref("java", "java"));

  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [msCode, setMsCode] = useState<{ code: string; url: string } | null>(null);
  const [skinFail, setSkinFail] = useState(false);
  const [skins, setSkins] = useState<Record<string, Skin>>(() => {
    try { return JSON.parse(localStorage.getItem("skins") ?? "{}"); } catch { return {}; }
  });
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
    invoke<AccList>("list_accounts").then(applyList);
    invoke<Instance[]>("list_instances").then((l) => {
      setInstances(l);
      setInstId((cur) => (l.some((i) => i.id === cur) ? cur : l[0]?.id ?? ""));
    });
    loadVersions();
    invoke<number>("system_ram").then(setSysRam).catch(() => {});
    const subs = [
      listen<string>("progress", (e) => add(e.payload)),
      listen<{ code: string; url: string }>("ms-code", (e) => setMsCode(e.payload)),
    ];
    return () => { subs.forEach((p) => p.then((un) => un())); };
  }, []);

  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [log, page]);
  useEffect(() => {
    Object.entries({ msClientId, cfKey, ram: String(ram), java, instance: instId })
      .forEach(([k, v]) => localStorage.setItem(k, v));
  }, [msClientId, cfKey, ram, java, instId]);
  useEffect(() => { localStorage.setItem("settings", JSON.stringify(st)); }, [st]);

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
          setSkins((prev) => {
            const n = { ...prev, [a.id]: sk };
            localStorage.setItem("skins", JSON.stringify(n));
            return n;
          });
        })
        .catch(() => {});
    });
  }, [accounts]);

  const inst = instances.find((i) => i.id === instId) ?? null;
  const current = accounts.find((a) => a.id === selected) ?? null;
  const effRam = st.ramAuto ? autoRam(sysRam, inst?.loader ?? "vanilla") : ram;

  const visible = useMemo(() => vinfo.filter((v) => {
    if (v.kind === "release") return true;
    if (isExperimental(v)) return st.showExperimental;
    if (v.kind === "snapshot") return st.showSnapshots;
    if (v.kind === "old_beta") return st.showBeta;
    if (v.kind === "old_alpha") return st.showAlpha;
    return false;
  }), [vinfo, st]);
  const filtered = visible.filter((v) => v.id.includes(filter)).slice(0, 300);

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
      await invoke("play", {
        req: {
          instance: inst.id, ram: effRam, java: java || "java", ms_client_id: msClientId,
          jvm_args: st.jvmArgs, game_args: st.gameArgs, hide: st.hide,
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

  const addAccount = async () => {
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
    } catch (e) {
      setAddErr(String(e));
    } finally {
      setAddBusy(false);
      setMsCode(null);
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
        req: { name: wName, loader: wLoader, mc: wMc, java: java || "java", icon: wIcon, description: wDesc, background: wBg },
      });
      setInstances(list);
      setInstId(list[list.length - 1].id);
      setStep(5);
    } catch (e) {
      setCreateErr(String(e));
      setStep(3);
    }
  };

  const startEdit = (i: Instance) => {
    setEditId(i.id); setEditName(i.name); setEditIcon(i.icon);
    setEditDesc(i.description); setEditBg(i.background); setDelId(null);
  };
  const saveEdit = async () => {
    try {
      setInstances(await invoke<Instance[]>("edit_instance", {
        req: { id: editId, name: editName, icon: editIcon, description: editDesc, background: editBg },
      }));
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

  // custom logo/background: pick an image; logos are cropped square to 96x96, backgrounds shrink to fit 960px wide
  const fileFor = useRef<"logo-new" | "logo-edit" | "bg-new" | "bg-edit">("logo-new");
  const pickFile = (target: "logo-new" | "logo-edit" | "bg-new" | "bg-edit") => { fileFor.current = target; fileRef.current?.click(); };
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const target = fileFor.current;
    const rd = new FileReader();
    rd.onload = () => {
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement("canvas");
        let url: string;
        if (target === "bg-new" || target === "bg-edit") {
          const W = 960, H = Math.round((img.height / img.width) * W);
          cv.width = W; cv.height = H;
          cv.getContext("2d")!.drawImage(img, 0, 0, W, H);
          url = cv.toDataURL("image/jpeg", 0.85);
        } else {
          const S = 96;
          cv.width = S; cv.height = S;
          const m = Math.min(img.width, img.height);
          cv.getContext("2d")!.drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, S, S);
          url = cv.toDataURL("image/png");
        }
        if (target === "logo-new") setWIcon(url);
        else if (target === "logo-edit") setEditIcon(url);
        else if (target === "bg-new") setWBg(url);
        else setEditBg(url);
      };
      img.src = String(rd.result);
    };
    rd.readAsDataURL(f);
  };

  const shownName = current?.username ?? "No account";
  const skin = `https://mc-heads.net/body/${encodeURIComponent(shownName)}/220`;
  const nav: [Page, string, string][] = [
    ["play", "play", "Home"], ["account", "user", "Accounts"], ["versions", "grid", "Download"], ["mods", "puzzle", "Mods"], ["console", "term", "Console"],
  ];

  return (
    <div className="shell" style={{ height: winH / (st.uiScale / 100) }}>
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
                <section className={"hero" + (inst?.background ? " has-bg" : "")}
                  style={inst?.background ? ({ ["--bg" as any]: `url(${inst.background})` }) : undefined}>
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
                  <button className="btn ghost" onClick={() => setPage("versions")}>Change Version</button>
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
            <section className="panel">
              <h2>Accounts</h2>
              <div className="alist">
                {accounts.length === 0 && <p className="hint">No accounts yet. Add one below.</p>}
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

              <h3>Add account</h3>
              <div className="seg">
                {KINDS.map(([k, l]) => (
                  <button key={k} className={addKind === k ? "on" : ""} onClick={() => { setAddKind(k); setAddErr(""); }}>{l}</button>
                ))}
              </div>

              {addKind === "offline" && (<>
                <label>Username (added instantly)</label>
                <input value={addUser} onChange={(e) => setAddUser(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addAccount()} />
              </>)}
              {addKind === "elyby" && (<>
                <label>Ely.by username / email</label>
                <input value={addUser} onChange={(e) => setAddUser(e.target.value)} />
                <label>Password (use password:2FACODE if 2FA is on)</label>
                <input type="password" value={addPass} onChange={(e) => setAddPass(e.target.value)} />
              </>)}
              {addKind === "microsoft" && (
                <p className="hint">
                  A browser window opens with a code to enter. {msClientId.trim() ? "" : "Set your Azure client ID in Settings first."}
                </p>
              )}

              {msCode && addBusy && <div className="code">Enter code <b>{msCode.code}</b> at {msCode.url}</div>}
              {addErr && <div className="err">{addErr}</div>}
              <button className="btn purple addbtn" disabled={addBusy} onClick={addAccount}>
                {addBusy ? "Waiting..." : addKind === "offline" ? "Add account" : addKind === "elyby" ? "Sign in & add" : "Sign in with Microsoft"}
              </button>
            </section>
          )}

          {page === "versions" && (
            <section className="panel">
              <div className="ptop">
                <h2>Instances</h2>
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
                  <label>Background (optional)</label>
                  <div className="bgrow">
                    {wBg ? <img className="bgpreview" src={wBg} alt="" /> : <div className="bgpreview ph" />}
                    <button className="mini" onClick={() => pickFile("bg-new")}>Choose image...</button>
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
                  {instances.length === 0 && <p className="hint">No instances yet. Use "New instance" to download one.</p>}
                  {instances.map((i) => (
                    <div key={i.id} className={"icard" + (i.id === instId ? " on" : "")}>
                      <InstIcon inst={editId === i.id ? { loader: i.loader, icon: editIcon } : i} size={48} />
                      <div className="iinfo">
                        {editId === i.id
                          ? <input value={editName} onChange={(e) => setEditName(e.target.value)} />
                          : (<><b>{i.name}</b><span>Minecraft {i.mc} · {cap(i.loader)}</span></>)}
                      </div>
                      {editId === i.id ? (<>
                        <button className="mini" onClick={() => pickFile("logo-edit")}>Logo...</button>
                        <button className="mini" onClick={() => setEditIcon("")}>Default logo</button>
                        <input className="editdesc" placeholder="Description" value={editDesc} onChange={(e) => setEditDesc(e.target.value)} />
                        <button className="mini" onClick={() => pickFile("bg-edit")}>Background...</button>
                        {editBg && <button className="mini" onClick={() => setEditBg("")}>Remove background</button>}
                        <button className="mini" onClick={saveEdit}>Save</button>
                        <button className="mini" onClick={() => setEditId(null)}>Cancel</button>
                      </>) : delId === i.id ? (<>
                        <span className="hint">Delete?</span>
                        <button className="mini danger" onClick={() => removeInst(i.id, false)}>Remove</button>
                        <button className="mini danger" onClick={() => removeInst(i.id, true)}>Remove + delete files</button>
                        <button className="mini" onClick={() => setDelId(null)}>Cancel</button>
                      </>) : (<>
                        {i.id === instId ? <span className="badge">Selected</span> : <button className="mini" onClick={() => setInstId(i.id)}>Select</button>}
                        <button className="mini" onClick={() => startEdit(i)}>Edit</button>
                        <button className="mini danger" onClick={() => setDelId(i.id)}>Delete</button>
                      </>)}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {page === "console" && (
            <section className="panel full">
              <h2>Console</h2>
              <div className="log" ref={logRef}>{log.map((l, i) => <div key={i}>{l}</div>)}</div>
            </section>
          )}

          {page === "settings" && (
            <section className="panel">
              <h2>Settings</h2>

              <h3>Memory</h3>
              <label className="check">
                <input type="checkbox" checked={st.ramAuto} onChange={(e) => set("ramAuto", e.target.checked)} />
                Auto ({(autoRam(sysRam, inst?.loader ?? "vanilla") / 1024).toFixed(1)} GB{sysRam ? ` of ${(sysRam / 1024).toFixed(0)} GB` : ""})
              </label>
              <label>Memory: {(effRam / 1024).toFixed(1)} GB</label>
              <input type="range" disabled={st.ramAuto} min={1024} max={Math.max(2048, Math.floor((sysRam || 16384) / 512) * 512)}
                step={512} value={ram} onChange={(e) => setRam(+e.target.value)} />

              <h3>Game</h3>
              <label>Java path (leave as "java" to use jre/javaruntime, then system Java)</label>
              <input value={java} onChange={(e) => setJava(e.target.value)} />
              <label>JVM arguments</label>
              <input placeholder="-XX:+UseG1GC -XX:MaxGCPauseMillis=50" value={st.jvmArgs} onChange={(e) => set("jvmArgs", e.target.value)} />
              <label>Game arguments</label>
              <input placeholder="--fullscreen" value={st.gameArgs} onChange={(e) => set("gameArgs", e.target.value)} />
              <label className="check">
              <input
                type="checkbox"
                defaultChecked={localStorage.getItem("launcher.showCrashReports") !== "off"}
                onChange={(e) => localStorage.setItem("launcher.showCrashReports", e.target.checked ? "on" : "off")}
              />
              Show a crash report when the game crashes
            </label>
              <label className="check">
                <input type="checkbox" checked={st.volumeOn} onChange={(e) => set("volumeOn", e.target.checked)} />
                Set game master volume on launch: {st.volume}%
              </label>
              <input type="range" min={0} max={100} step={5} disabled={!st.volumeOn} value={st.volume} onChange={(e) => set("volume", +e.target.value)} />

              <h3>Launcher</h3>
              <label>When the game starts</label>
              <select value={st.hide} onChange={(e) => set("hide", e.target.value as Settings["hide"])}>
                <option value="keep">Keep the launcher open</option>
                <option value="hide">Hide it until the game closes</option>
                <option value="close">Close the launcher</option>
              </select>
              <label>Interface size: {st.uiScale}%</label>
              <input type="range" min={80} max={140} step={5} value={st.uiScale} onChange={(e) => set("uiScale", +e.target.value)} />

              <h3>Version list</h3>
              <label className="check"><input type="checkbox" checked={st.showSnapshots} onChange={(e) => set("showSnapshots", e.target.checked)} /> Snapshots</label>
              <label className="check"><input type="checkbox" checked={st.showExperimental} onChange={(e) => set("showExperimental", e.target.checked)} /> Experimental and special versions</label>
              <label className="check"><input type="checkbox" checked={st.showBeta} onChange={(e) => set("showBeta", e.target.checked)} /> Old beta</label>
              <label className="check"><input type="checkbox" checked={st.showAlpha} onChange={(e) => set("showAlpha", e.target.checked)} /> Old alpha</label>

              <h3>Microsoft</h3>
              <label>Azure client ID (needed for Microsoft accounts)</label>
              <input value={msClientId} onChange={(e) => setMsClientId(e.target.value)} />

              <h3>CurseForge</h3>
              <label>CurseForge API key (free at console.curseforge.com)</label>
              <input type="password" value={cfKey} onChange={(e) => setCfKey(e.target.value)} />
            </section>
          )}
          </div>

          <div className={"pagewrap " + (fade === "out" ? "out" : "in")} style={page === "mods" ? undefined : { display: "none" }}>
            <ModsPage
              inst={inst}
              cfKey={cfKey}
              java={java}
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