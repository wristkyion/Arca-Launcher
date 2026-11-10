import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import ModsPage from "./mods";
import ContentPage from "./content";
import { DownloadsProvider, DownloadsFloat, useDownloads } from "./downloads";
import CrashWatcher from "./CrashWatcher";
// @ts-ignore CSS is handled by the bundler; TypeScript may not have a CSS module declaration.
import "./styles.css";

type Page = "play" | "account" | "versions" | "mods" | "console" | "settings";
type Acc = { id: string; kind: string; username: string; uuid: string; custom_icon?: string | null; custom_background?: string | null };
type AccList = { selected: string | null; accounts: Acc[] };
type VersionInfo = { id: string; kind: string };
type Instance = { id: string; name: string; loader: string; mc: string; version_id: string; icon: string; description: string; background: string };
type InstanceArchiveInfo = { has_metadata: boolean; name: string; loader: string; mc: string };
type ThemeInfo = { id: string; name: string; author: string; builtin: boolean };
type ThemeCatalog = { themes: ThemeInfo[]; warnings: string[] };
type ThemeStylesheet = { id: string; name: string; author: string; css: string };
type LauncherUpdateCheck = {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  notes?: string;
};
type MinecraftNewsEntry = {
  title: string;
  tag: string | null;
  category: string | null;
  date: string | null;
  text: string | null;
  imageUrl: string | null;
  link: string | null;
};
type MaintenanceAction = "delete_instances" | "delete_java" | "clean_accounts" | "factory_reset";
const MAINTENANCE_DETAILS: Record<MaintenanceAction, { title: string; description: string }> = {
  delete_instances: {
    title: "Delete all instances?",
    description: "All recognized Arca instances and their saves, mods, resource packs, and configuration files will be permanently deleted.",
  },
  delete_java: {
    title: "Delete downloaded Java?",
    description: "Only Java runtimes downloaded and managed by Arca Launcher will be removed. System Java and custom Java installations are untouched.",
  },
  clean_accounts: {
    title: "Clean saved accounts?",
    description: "Saved account credentials and cached skins will be removed from this launcher.",
  },
  factory_reset: {
    title: "Reset Arca Launcher?",
    description: "This permanently deletes all recognized instances, launcher-managed Java runtimes, saved accounts, and launcher settings. Shared Minecraft game assets and the launcher installation will remain.",
  },
};
type CSSVars = CSSProperties & { [key: `--${string}`]: string | number };
declare global {
  interface Window {
    __arcaShowStartupWizard?: () => void;
  }
}
const INSTANCE_EDIT_ICON = new URL("../assets/icons/edit.svg", import.meta.url).href;
const getPortalRoot = () => document.getElementById("portals") ?? document.body;
const BUILTIN_THEMES: ThemeInfo[] = [
  { id: "builtin:default", name: "Default", author: "Built-in", builtin: true },
  { id: "builtin:minimal", name: "Minimal", author: "Built-in", builtin: true },
  { id: "builtin:minecraft", name: "Minecraft style", author: "Built-in", builtin: true },
];
const DEFAULT_THEME_ID = "builtin:default";
const normalizeThemeId = (value: unknown) => {
  if (value === "default") return DEFAULT_THEME_ID;
  if (value === "minimal") return "builtin:minimal";
  if (value === "minecraft") return "builtin:minecraft";
  if (typeof value === "string" && /^custom:[^/\\]+$/.test(value)) return value;
  return BUILTIN_THEMES.some((theme) => theme.id === value) ? value as string : DEFAULT_THEME_ID;
};

type Settings = {
  ramAuto: boolean; jvmArgs: string; gameArgs: string;
  launchFullscreen: boolean;
  hide: "keep" | "hide" | "close";
  volumeOn: boolean; volume: number; uiScale: number;
  showSnapshots: boolean; showExperimental: boolean; showBeta: boolean; showAlpha: boolean;
  downloadConcurrency: number; autoClearDownloads: boolean;
  instanceDirectory: string;
  javaRuntime: "system" | "custom";
  theme: string;
  reduceAnimations: boolean;
};
const DEFAULTS: Settings = {
  ramAuto: true, jvmArgs: "", gameArgs: "", launchFullscreen: false, hide: "keep",
  volumeOn: false, volume: 100, uiScale: 100,
  showSnapshots: false, showExperimental: false, showBeta: false, showAlpha: false,
  downloadConcurrency: 3, autoClearDownloads: true,
  instanceDirectory: "",
  javaRuntime: "system",
  theme: DEFAULT_THEME_ID,
  reduceAnimations: false,
};

// Edit this list to publish your own launcher changelogs (newest first).
type ChangelogSection = { title: string; items: string[] };
type ChangelogEntry =
  | { v: string; title: string; sections: ChangelogSection[] }
  | { v: string; title: string; items: string[] };

const CHANGELOG: ChangelogEntry[] = [
  {
    v: "0.2.2",
    title: "Cross",
    items: [
      "No changes update, only a new cross-platform build for Windows, macOS, and Linux for the release",
    ],
  },
  {
    v: "0.2.1",
    title: "Huge Update",
    sections: [
      {
        title: "Instance management",
        items: [
          "Added multi-select instance deletion with a two-step confirmation.",
          "Added instance ZIP export and import, including a setup flow for archives without instances.json.",
          "Added support for importing Modrinth .mrpack files.",
          "Added task-panel progress and completion or error status for archive imports and exports.",
        ],
      },
      {
        title: "Library and downloader",
        items: [
          "Reworked Installed Content with category navigation, search, refreshed icons, and smoother category transitions.",
          "Added loading overlays for Installed Content and downloader searches.",
          "Improved instance search, refresh, and selection controls.",
        ],
      },
      {
        title: "Polish",
        items: [
          "Updated instance actions with compact icon buttons and consistent hover behavior.",
          "Improved selection checkboxes and refreshed content controls.",
        ],
      },
    ],
  },
  {
    v: "0.2.0",
    title: "Power",
    sections: [
      {
        title: "Features",
        items: [
          "Added signed launcher updates with release notes, download progress, signature verification, and user-controlled installation.",
          "Modpack installs now carry over the pack name, description, icon, and available thumbnail as the instance background.",
          "Expanded the content browser with grid and list views, richer project details, pagination, and advanced filters.",
        ],
      },
      {
        title: "Rework",
        items: [
          "Refined the downloader layout, project cards, thumbnails, and sticky navigation for browsing content.",
          "Improved project detail descriptions with formatted Markdown and clearer metadata.",
        ],
      },
      {
        title: "Fixes and reliability",
        items: [
          "Fixed NeoForge detection and installation for modern Minecraft version formats such as 26.x.",
          "Kept NeoForge availability checks consistent with the shared loader installer.",
          "Restricted automatic updates to signed releases verified by the launcher's configured public key.",
        ],
      },
    ],
  },
  {
    v: "0.1.6",
    title: "Rework",
    items: [
      "New Logo/icon",
      "Enhanced the UI with new startup animations",
      "Introduced a new title bar design that displays the latest version of Arca",
      "Fixed issues where the Java Runtime would fail or could not be executed",
      "Resolved issues where Java would fail during execution",
      "Improved the task panel with a new visual style",
      "Focused on optimizations",
    ],
  },
  {
    v: "0.1.5",
    title: "Instances",
    items: [
      "Fixed custom instance path handling for Windows device paths (\\?\) and DOS device path escaping issues.",
      "Fixed permission-related errors when running from Program Files, including (OS Error 3) and (OS Error 5) when accessing directories or writing settings.",
      "Improved custom path handling for better compatibility with different storage locations.",
      "Updated instance management logic to store (instances.json) separately within each Minecraft instance directory, keeping instance configuration files alongside their respective instances.",
      "Added mod loader and Minecraft version information when downloading mods.",
      "Updated NSIS and MSI installer configurations to set the required directory permissions during installation, allowing Arca-Launcher to access its required files and folders more reliably.",
    ],
  },
  {
    v: "0.1.4",
    title: "Small Update",
    items: [
      "Fixed download queue and progress bar issues.",
      "Fixed Hide/Close behavior when launching a game.",
      "Disabled download logs in the console to reduce unnecessary output.",
      "Improved launcher loading and update checking.",
      "Added mod loader and Minecraft version information when downloading mods.",
      "Added a task queue for instance downloads, with progress tracking and a cancel button.",
      "Added a startup window to display loading progress and update checks before the main window opens.",
      "Improved CurseForge and Modrinth content browsing.",
    ],
  },
  {
    v: "0.1.3",
    title: "Bug Fixes and Improvements",
    items: [
      "Fix Forge 1.7.10 downloads and legacy installer setup",
      "Fix old Minecraft launch compatibility by selecting Java 8 when required",
      "Fix NeoForge launch and instance handling issues",
      "Add an Installed Content page within Instances with search and content controls",
      "Show marketplace and embedded mod logos, plus resource-pack artwork",
      "Improve Modrinth and CurseForge content browsing with project details",
      "Remove credential entry from settings; use publisher-configured Microsoft sign-in and CurseForge proxy",
      "Add a launcher update check",
    ],
  },
  { v: "0.1.2", title: "Customized Improvements", items: ["Add custom themes", "Add new icons", "Fix terminal launch", "Add custom backgrounds from the launcher library", "Increase maximum interface scale from 135% to 200%", "Fix bugs"] },
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
  play: new URL("../assets/icons/homepage.svg", import.meta.url).href,
  user: new URL("../assets/icons/manage-account.svg", import.meta.url).href,
  grid: new URL("../assets/icons/instance.svg", import.meta.url).href,
  term: new URL("../assets/icons/terminal.svg", import.meta.url).href,
  gear: new URL("../assets/icons/settings.svg", import.meta.url).href,
  cube: new URL("../assets/icons/instance.svg", import.meta.url).href,
  puzzle: new URL("../assets/icons/downloader.svg", import.meta.url).href,
  theme: new URL("../assets/icons/theme-settings.svg", import.meta.url).href,
  memory: new URL("../assets/icons/memory-settings.svg", import.meta.url).href,
  game: new URL("../assets/icons/game-settings.svg", import.meta.url).href,
  launcher: new URL("../assets/icons/launcher-settings.svg", import.meta.url).href,
  version: new URL("../assets/icons/version-settings.svg", import.meta.url).href,
  microsoft: new URL("../assets/icons/microsoft-settings.svg", import.meta.url).href,
  curseforge: new URL("../assets/icons/curseforge-settings.svg", import.meta.url).href,
  instances: new URL("../assets/icons/instance-settings.svg", import.meta.url).href,
};
const LAUNCHER_LOGO = new URL("../assets/icons/ics-launcher.png", import.meta.url).href;
const LAUNCHER_BACKGROUNDS = [
  { name: "Wilderness Bound", src: new URL("../assets/background/WildernessBound.png", import.meta.url).href },
  { name: "Pride 2022", src: new URL("../assets/background/Pride2022.png", import.meta.url).href },
  { name: "Java Edition", src: new URL("../assets/background/Java Edition.png", import.meta.url).href },
  { name: "Crocs", src: new URL("../assets/background/Crocs.png", import.meta.url).href },
  { name: "Burberry", src: new URL("../assets/background/Burberry.png", import.meta.url).href },
];
const Icon = ({ n }: { n: string }) => (
  <img className="ui-icon" src={ICONS[n] ?? ICONS.instance} alt="" aria-hidden="true" />
);

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Shows a saved background image (including an animated gif). */
function BgPreview({ src, className }: { src: string; className?: string }) {
  if (!src) return null;
  return <img className={className} src={src} alt="" />;
}

/** A simple centered dialog with a dark scrim backdrop. Click outside or the ✕ to close. */
function Modal({ title, onClose, children, wide = false, compact = false, hideClose = false, overlayClassName = "" }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; compact?: boolean; hideClose?: boolean; overlayClassName?: string }) {
  return createPortal(
    <div className={"app-modal-backdrop" + (overlayClassName ? ` ${overlayClassName}` : "")} onClick={onClose}>
      <div className={"app-modal-card" + (wide ? " wide" : "") + (compact ? " compact" : "")} onClick={(e) => e.stopPropagation()}>
        <div className="app-modal-header">
          <h3 className="app-modal-title">{title}</h3>
          {!hideClose && <button className="mini" onClick={onClose}>✕</button>}
        </div>
        {children}
      </div>
    </div>,
    getPortalRoot(),
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
  return <canvas ref={ref} width={head ? 8 : 16} height={head ? 8 : 32} className="skincv" style={{ "--skin-height": `${height}px` } as CSSVars} />;
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
    <div className="cube" style={{ "--cube-transform": `translate3d(${at[0] * s}px,${at[1] * s}px,${at[2] * s}px)` } as CSSVars}>
      {faces.map((f, i) => {
        const sx = (f.fw * s) / f.r[2], sy = (f.fh * s) / f.r[3];
        return (
          <i key={i} style={{
            "--face-width": `${f.fw * s}px`,
            "--face-height": `${f.fh * s}px`,
            "--face-left": `${-(f.fw * s) / 2}px`,
            "--face-top": `${-(f.fh * s) / 2}px`,
            "--face-transform": f.t,
            "--face-image": `url(${tex})`,
            "--face-background-size": `${tw * sx}px ${th * sy}px`,
            "--face-background-position": `${-f.r[0] * sx}px ${-f.r[1] * sy}px`,
          } as CSSVars} />
        );
      })}
    </div>
  );
}

/** 3D skin preview. Starts viewed from the top-left; drag to rotate, double-click to reset. */
function SkinModel({ data, slim, s = 5, className, initialRotation }: {
  data: string;
  slim: boolean;
  s?: number;
  className?: string;
  initialRotation?: { x: number; y: number };
}) {
  const HOME = { x: -24, y: 32 }; // x: tilt (negative = camera above), y: turn (positive = camera to the left)
  const [dim, setDim] = useState<[number, number]>([64, 64]);
  const [rot, setRot] = useState(initialRotation ?? HOME);

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
    <div className={"stage" + (className ? ` ${className}` : "")}>
      <div className="rig" style={{ "--rig-transform": `rotateX(${rot.x}deg) rotateY(${rot.y}deg)` } as CSSVars}>
        <Cube {...c} g={[8, 8, 8]} d={[8, 8, 8]} o={[0, 0]} at={[0, -10 - Y, 0]} />
        <Cube {...c} g={[9, 9, 9]} d={[8, 8, 8]} o={[32, 0]} at={[0, -10 - Y, 0]} />
        <Cube {...c} g={[8, 12, 4]} d={[8, 12, 4]} o={[16, 16]} at={[0, -Y, 0]} />
        <Cube {...c} g={[aw, 12, 4]} d={[aw, 12, 4]} o={[40, 16]} at={[-ax, -Y, 0]} />
        <Cube {...c} g={[aw, 12, 4]} d={[aw, 12, 4]} o={legacy ? [40, 16] : [32, 48]} at={[ax, -Y, 0]} />
        <Cube {...c} g={[4, 12, 4]} d={[4, 12, 4]} o={[0, 16]} at={[-2, 12 - Y, 0]} />
        <Cube {...c} g={[4, 12, 4]} d={[4, 12, 4]} o={legacy ? [0, 16] : [16, 48]} at={[2, 12 - Y, 0]} />
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
  if (acc.custom_icon) return <img className="avimg custom-account-avatar" src={acc.custom_icon} alt="" />;
  if (skin?.data) return <SkinCanvas url={skin.data} slim={skin.slim} head height={36} />;
  if (acc.kind === "offline")
    return <img className="avimg" src={`https://mc-heads.net/avatar/${encodeURIComponent(acc.username)}/36`} alt=""
      onError={(e) => e.currentTarget.classList.add("is-hidden")} />;
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
      style={{ "--icon-size": `${size}px` } as CSSVars}
      alt=""
    />
  );
}

function InstIcon({ inst, size }: { inst: { loader: string; icon?: string }; size: number }) {
  if (inst.icon)
    return <img className="insticon" src={inst.icon} style={{ "--icon-size": `${size}px` } as CSSVars} alt="" />;
  return <LoaderIcon loader={inst.loader} size={size} />;
}

function InstanceRowBackground({
  instance,
  className,
  style,
  children,
  onBackgroundError,
}: {
  instance: Instance;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  onBackgroundError: (message: string) => void;
}) {
  const rowRef = useRef<HTMLElement>(null);
  const onBackgroundErrorRef = useRef(onBackgroundError);
  const [background, setBackground] = useState("");
  onBackgroundErrorRef.current = onBackgroundError;

  useEffect(() => {
    let active = true;
    setBackground("");
    if (!instance.background) return () => { active = false; };

    const loadBackground = () => {
      void invoke<string | null>("load_instance_background", { id: instance.id })
        .then((image) => { if (active) setBackground(image ?? ""); })
        .catch((error) => {
          if (active) onBackgroundErrorRef.current(`Could not load background for ${instance.name}: ${error}`);
        });
    };

    const row = rowRef.current;
    if (!row || typeof IntersectionObserver === "undefined") {
      loadBackground();
      return () => { active = false; };
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        loadBackground();
      }
    });
    observer.observe(row);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [instance.id, instance.name, instance.background]);

  return (
    <article
      ref={rowRef}
      className={"instance-row" + (className ? ` ${className}` : "") + (background ? " has-background" : "")}
      style={{
        ...style,
        ...(background ? { "--instance-background": `url("${background}")` } as CSSVars : {}),
      }}
    >
      {children}
    </article>
  );
}

function AppInner() {
  const isSplashWindow = (() => {
    try {
      return getCurrentWindow().label === "splash";
    } catch {
      return new URLSearchParams(window.location.search).get("window") === "splash";
    }
  })();
  const { configureDownloads, installInstance, startMigration, startTask, anyRunning } = useDownloads();
  const [contentInst, setContentInst] = useState<Instance | null>(null);
  const [page, setPageNow] = useState<Page>("play");
  const [fade, setFade] = useState<"in" | "out">("in");
  const pageRef = useRef<Page>("play");
  pageRef.current = page;
  const setPage = (p: Page) => {
    setContentInst(null);
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
  const [firstRunClosing, setFirstRunClosing] = useState(false);
  const [firstRunStep, setFirstRunStep] = useState(0);
  const [firstRunBusy, setFirstRunBusy] = useState(false);
  const [firstRunError, setFirstRunError] = useState("");
  const [firstRunTransition, setFirstRunTransition] = useState<"idle" | "exit" | "enter">("idle");
  const firstRunTransitionTimer = useRef<number | null>(null);
  const firstRunTransitionLocked = useRef(false);
  const [accountsReady, setAccountsReady] = useState(false);
  const [instancesReady, setInstancesReady] = useState(false);
  const [versionsReady, setVersionsReady] = useState(false);
  const [updateCheckComplete, setUpdateCheckComplete] = useState(false);
  const [bootMinimumElapsed, setBootMinimumElapsed] = useState(false);
  const [bootTimedOut, setBootTimedOut] = useState(false);
  const [splashHandoffComplete, setSplashHandoffComplete] = useState(false);
  const mainWindowRestored = useRef(false);

  // accounts
  const [accounts, setAccounts] = useState<Acc[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusedAccountId, setFocusedAccountId] = useState<string | null>(null);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [addKind, setAddKind] = useState("offline");
  const [addUser, setAddUser] = useState("");
  const [addPass, setAddPass] = useState("");
  const [addAccountIcon, setAddAccountIcon] = useState("");
  const [addAccountBackground, setAddAccountBackground] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addErr, setAddErr] = useState("");
  const [homeAccountPickerOpen, setHomeAccountPickerOpen] = useState(false);

  // instances
  const [instances, setInstances] = useState<Instance[]>([]);
  const [instId, setInstId] = useState("");
  const [instanceSearch, setInstanceSearch] = useState("");
  const [activeBackground, setActiveBackground] = useState("");
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
  const [backgroundPickerOpen, setBackgroundPickerOpen] = useState(false);
  const [showLauncherBackgrounds, setShowLauncherBackgrounds] = useState(false);
  const [backgroundPickerError, setBackgroundPickerError] = useState("");
  const [backgroundPickerTarget, setBackgroundPickerTarget] = useState<"new" | "edit">("new");
  const nameEdited = useRef(false);

  // managing instances
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editIcon, setEditIcon] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editBg, setEditBg] = useState("");
  const [instanceSelectionMode, setInstanceSelectionMode] = useState(false);
  const [selectedInstanceIds, setSelectedInstanceIds] = useState<string[]>([]);
  const [deleteInstancesConfirm, setDeleteInstancesConfirm] = useState<"warning" | "confirm" | null>(null);
  const [deleteInstancesBusy, setDeleteInstancesBusy] = useState(false);
  const [instancesRefreshing, setInstancesRefreshing] = useState(false);
  const [instanceActionError, setInstanceActionError] = useState("");
  const [instanceImportBusy, setInstanceImportBusy] = useState(false);
  const [importArchivePath, setImportArchivePath] = useState<string | null>(null);
  const [importName, setImportName] = useState("");
  const [importLoader, setImportLoader] = useState("vanilla");
  const [importMc, setImportMc] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // versions + settings
  const [vinfo, setVinfo] = useState<VersionInfo[]>([]);
  const [filter, setFilter] = useState("");
  const [versionPage, setVersionPage] = useState(1);
  const [sysRam, setSysRam] = useState(0);
  const [st, setSt] = useState<Settings>(DEFAULTS);
  const [activeSettingsTab, setActiveSettingsTab] = useState<"game" | "launcher">("game");
  const [themeCatalog, setThemeCatalog] = useState<ThemeInfo[]>(BUILTIN_THEMES);
  const [themesReady, setThemesReady] = useState(false);
  const [themeWarnings, setThemeWarnings] = useState<string[]>([]);
  const [themeError, setThemeError] = useState("");
  const [releaseLinkError, setReleaseLinkError] = useState("");
  const [networkOnline, setNetworkOnline] = useState(navigator.onLine);
  const [launcherUpdate, setLauncherUpdate] = useState<LauncherUpdateCheck | null>(null);
  const [updateCheckError, setUpdateCheckError] = useState("");
  const [updateCheckBusy, setUpdateCheckBusy] = useState(false);
  const [minecraftNews, setMinecraftNews] = useState<MinecraftNewsEntry[]>([]);
  const [minecraftNewsLoading, setMinecraftNewsLoading] = useState(false);
  const [minecraftNewsError, setMinecraftNewsError] = useState("");
  const [minecraftNewsLinkError, setMinecraftNewsLinkError] = useState("");
  const [minecraftNewsRefresh, setMinecraftNewsRefresh] = useState(0);
  const [updateInstallError, setUpdateInstallError] = useState("");
  const [updateInstallBusy, setUpdateInstallBusy] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [updateDownloaded, setUpdateDownloaded] = useState(false);
  const updateRef = useRef<Update | null>(null);
  const downloadedBytesRef = useRef(0);
  const updateSizeRef = useRef<number | null>(null);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSt((p) => ({ ...p, [k]: v }));
  const [instanceDirectoryDraft, setInstanceDirectoryDraft] = useState("");
  const [instanceDirectoryBusy, setInstanceDirectoryBusy] = useState(false);
  const [instanceDirectoryMessage, setInstanceDirectoryMessage] = useState("");
  const [javaRuntimeBusy, setJavaRuntimeBusy] = useState(false);
  const [javaRuntimeMessage, setJavaRuntimeMessage] = useState("");
  const [maintenanceAction, setMaintenanceAction] = useState<MaintenanceAction | null>(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const [ram, setRam] = useState(4096);
  const [java, setJava] = useState("java");
  const [showCrashReports, setShowCrashReports] = useState(true);

  const [busy, setBusy] = useState(false);
  // True once the Minecraft process has actually been spawned (not just while
  // checking assets/libraries/Java) and until it exits. Keeps Launch disabled
  // for the whole play session instead of just the pre-launch checks.
  const [gameRunning, setGameRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [activityLog, setActivityLog] = useState<string[]>([]);
  const [msCode, setMsCode] = useState<{ code: string; url: string } | null>(null);
  const [skinFail, setSkinFail] = useState(false);
  const [skins, setSkins] = useState<Record<string, Skin>>({});
  const fetchedSkins = useRef(new Set<string>());
  const logRef = useRef<HTMLDivElement>(null);
  const [winH, setWinH] = useState(window.innerHeight);

  useEffect(() => {
    if (!addAccountOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !addBusy) setAddAccountOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [addAccountOpen, addBusy]);

  const add = (s: string) =>
    setActivityLog((l) => {
      const prog = /^(Assets|Libraries) \d+\/\d+/;
      const last = l[l.length - 1];
      if (prog.test(s) && last && prog.test(last)) return [...l.slice(0, -1), s];
      return [...l.slice(-400), s];
    });
  const addGameLog = (line: string) => setLog((lines) => [...lines.slice(-400), line]);

  const applyList = (r: AccList) => { setAccounts(r.accounts); setSelected(r.selected); setFocusedAccountId(r.selected); setSkinFail(false); };
  const goToFirstRunStep = (nextStep: number) => {
    if (firstRunTransitionLocked.current || nextStep === firstRunStep) return;
    firstRunTransitionLocked.current = true;
    setFirstRunTransition("exit");
    firstRunTransitionTimer.current = window.setTimeout(() => {
      setFirstRunStep(nextStep);
      setFirstRunTransition("enter");
      firstRunTransitionTimer.current = window.setTimeout(() => {
        setFirstRunTransition("idle");
        firstRunTransitionLocked.current = false;
        firstRunTransitionTimer.current = null;
      }, 220);
    }, 140);
  };

  const loadVersions = () =>
    invoke<VersionInfo[]>("mc_versions")
      .then(setVinfo)
      .catch((e) => add(`Could not load versions: ${e}`))
      .finally(() => setVersionsReady(true));

  const checkLauncherUpdate = async () => {
    setUpdateCheckBusy(true);
    setUpdateCheckError("");
    setUpdateInstallError("");
    setUpdateDownloaded(false);
    setUpdateProgress(null);
    try {
      await updateRef.current?.close();
      updateRef.current = null;
      if (import.meta.env.DEV) {
        setLauncherUpdate(await invoke<LauncherUpdateCheck>("check_launcher_update"));
      } else {
        const [currentVersion, update] = await Promise.all([getVersion(), check()]);
        updateRef.current = update;
        setLauncherUpdate({
          current_version: currentVersion,
          latest_version: update?.version ?? currentVersion,
          update_available: update !== null,
          notes: update?.body,
        });
      }
    } catch (error) {
      setLauncherUpdate(null);
      setUpdateCheckError(`Could not check for launcher updates: ${error}`);
    } finally {
      setUpdateCheckBusy(false);
      setUpdateCheckComplete(true);
    }
  };

  const downloadLauncherUpdate = async () => {
    const update = updateRef.current;
    if (!update) return;
    setUpdateInstallBusy(true);
    setUpdateInstallError("");
    setUpdateProgress(0);
    downloadedBytesRef.current = 0;
    updateSizeRef.current = null;
    try {
      await update.download((event) => {
        if (event.event === "Started") {
          updateSizeRef.current = event.data.contentLength ?? null;
        } else if (event.event === "Progress") {
          downloadedBytesRef.current += event.data.chunkLength;
          const total = updateSizeRef.current;
          setUpdateProgress(total ? Math.min(100, (downloadedBytesRef.current / total) * 100) : null);
        } else if (event.event === "Finished") {
          setUpdateProgress(100);
        }
      });
      setUpdateDownloaded(true);
    } catch (error) {
      setUpdateInstallError(`Could not download the update: ${error}`);
      setUpdateProgress(null);
    } finally {
      setUpdateInstallBusy(false);
    }
  };

  const installLauncherUpdate = async () => {
    const update = updateRef.current;
    if (!update || !updateDownloaded) return;
    setUpdateInstallBusy(true);
    setUpdateInstallError("");
    try {
      await update.install();
      await relaunch();
    } catch (error) {
      setUpdateInstallError(`Could not install the update: ${error}`);
      setUpdateInstallBusy(false);
    }
  };

  useEffect(() => {
    const minimum = setTimeout(() => setBootMinimumElapsed(true), 900);
    const maximum = setTimeout(() => setBootTimedOut(true), 12000);
    return () => { clearTimeout(minimum); clearTimeout(maximum); };
  }, []);

  useEffect(() => {
    const preventContextMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", preventContextMenu);
    return () => document.removeEventListener("contextmenu", preventContextMenu);
  }, []);

  useEffect(() => {
    const updateNetworkStatus = () => setNetworkOnline(navigator.onLine);
    window.addEventListener("online", updateNetworkStatus);
    window.addEventListener("offline", updateNetworkStatus);
    void checkLauncherUpdate();
    return () => {
      window.removeEventListener("online", updateNetworkStatus);
      window.removeEventListener("offline", updateNetworkStatus);
    };
  }, []);

  useEffect(() => {
    if (page !== "play") return;
    let active = true;
    setMinecraftNewsLoading(true);
    setMinecraftNewsError("");
    invoke<MinecraftNewsEntry[]>("get_minecraft_news")
      .then((entries) => {
        if (active) setMinecraftNews(entries);
      })
      .catch((error) => {
        if (active) setMinecraftNewsError(`Could not load Minecraft news: ${error}`);
      })
      .finally(() => {
        if (active) setMinecraftNewsLoading(false);
      });
    return () => { active = false; };
  }, [page, minecraftNewsRefresh]);

  const openMinecraftNews = async (url: string | null) => {
    if (!url) return;
    setMinecraftNewsLinkError("");
    try {
      await invoke("open_minecraft_news", { url });
    } catch (error) {
      setMinecraftNewsLinkError(`Could not open Minecraft news: ${error}`);
    }
  };

  useEffect(() => {
    // all settings now live in game/launcher/config/settings.json on the backend
    invoke<any>("load_settings").then((d) => {
      if (d.ram !== undefined) setRam(d.ram);
      if (d.java !== undefined) setJava(d.java);
      if (d.instance !== undefined) setInstId(d.instance);
      if (d.settings !== undefined) {
        const savedSettings = d.settings && typeof d.settings === "object" ? d.settings : {};
        const loadedSettings = {
          ...DEFAULTS,
          ...savedSettings,
          theme: normalizeThemeId(savedSettings.theme),
        };
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
    }).finally(() => setAccountsReady(true));
    (async () => {
      try {
        if (await invoke<boolean>("legacy_migration_pending")) {
          await startMigration();
        }
        const l = await invoke<Instance[]>("list_instances");
        setInstances(l);
        setInstId((cur) => (l.some((i) => i.id === cur) ? cur : l[0]?.id ?? ""));
      } catch (e) {
        add(`Could not load instances: ${e}`);
      } finally {
        setInstancesReady(true);
      }
    })();
    loadVersions();
    invoke<number>("system_ram").then(setSysRam).catch(() => {});
    const subs = [
      listen<string>("progress", (e) => {
        add(e.payload);
        // Emitted from the backend once the spawned Minecraft process exits.
        if (/^Game exited/.test(e.payload)) setGameRunning(false);
      }),
      listen<string>("game-log", (e) => addGameLog(e.payload)),
      listen<{ code: string; url: string }>("ms-code", (e) => setMsCode(e.payload)),
    ];
    return () => { subs.forEach((p) => p.then((un) => un())); };
  }, []);

  useEffect(() => {
    invoke<ThemeCatalog>("list_themes")
      .then((catalog) => {
        setThemeCatalog(catalog.themes);
        setThemeWarnings(catalog.warnings);
      })
      .catch((e) => {
        setThemeError(`Could not list custom themes: ${e}`);
      })
      .finally(() => setThemesReady(true));
  }, []);

  useEffect(() => {
    if (settingsLoaded && !startup) setFirstRunOpen(true);
  }, [settingsLoaded, startup]);

  useEffect(() => {
    return () => {
      if (firstRunTransitionTimer.current !== null) {
        window.clearTimeout(firstRunTransitionTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    const showStartupWizard = () => {
      if (firstRunTransitionTimer.current !== null) {
        window.clearTimeout(firstRunTransitionTimer.current);
        firstRunTransitionTimer.current = null;
      }
      firstRunTransitionLocked.current = false;
      setFirstRunTransition("idle");
      setFirstRunClosing(false);
      setFirstRunStep(0);
      setFirstRunError("");
      setAddErr("");
      setAddUser("");
      setAddPass("");
      setMsCode(null);
      setFirstRunOpen(true);
    };
    window.__arcaShowStartupWizard = showStartupWizard;
    return () => {
      if (window.__arcaShowStartupWizard === showStartupWizard) {
        delete window.__arcaShowStartupWizard;
      }
    };
  }, []);

  useEffect(() => {
    configureDownloads(st.downloadConcurrency, st.autoClearDownloads);
  }, [configureDownloads, st.downloadConcurrency, st.autoClearDownloads]);

  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [log, page]);
  useEffect(() => {
    if (!themesReady) return;
    if (!themeCatalog.some((theme) => theme.id === st.theme)) {
      setThemeError(`The selected theme is unavailable. Switched to ${BUILTIN_THEMES[0].name}.`);
      setSt((current) => ({ ...current, theme: DEFAULT_THEME_ID }));
      return;
    }
    if (BUILTIN_THEMES.some((theme) => theme.id === st.theme)) {
      document.documentElement.dataset.theme = st.theme;
      document.getElementById("selected-theme")?.remove();
      setThemeError("");
      return;
    }
    let active = true;
    invoke<ThemeStylesheet>("load_theme", { id: st.theme })
      .then((theme) => {
        if (!active) return;
        let style = document.getElementById("selected-theme") as HTMLStyleElement | null;
        if (!style) {
          style = document.createElement("style");
          style.id = "selected-theme";
          document.head.appendChild(style);
        }
        document.documentElement.dataset.theme = theme.id;
        style.textContent = theme.css;
      })
      .catch((e) => {
        if (!active) return;
        document.documentElement.dataset.theme = DEFAULT_THEME_ID;
        const style = document.getElementById("selected-theme");
        if (style) style.textContent = "";
        setThemeError(`Could not load the selected theme; using Default. ${e}`);
        if (st.theme !== DEFAULT_THEME_ID)
          setSt((current) => ({ ...current, theme: DEFAULT_THEME_ID }));
      });
    return () => { active = false; };
  }, [st.theme, themeCatalog, themesReady]);

  // persist everything together into game/launcher/config/settings.json
  useEffect(() => {
    if (!loadedRef.current) return;
    invoke("save_settings", {
      data: { ram, java, instance: instId, settings: st, skins, showCrashReports, startup },
    }).catch((e) => add(`Could not save settings: ${e}`));
  }, [ram, java, instId, st, skins, showCrashReports, startup]);

  // Interface size: CSS zoom, with the shell height divided by the zoom so it still fills the window
  useEffect(() => {
    const f = () => setWinH(window.innerHeight);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
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

  // Load skin textures through the backend so every account uses the same 3D viewer.
  useEffect(() => {
    accounts.forEach((a) => {
      if (fetchedSkins.current.has(a.id)) return;
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
  const focusedAccount = accounts.find((a) => a.id === focusedAccountId) ?? current ?? accounts[0] ?? null;
  const focusedSkin = focusedAccount ? skins[focusedAccount.id] ?? null : null;
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
  const filtered = visible.filter((v) => v.id.includes(filter));
  const filteredInstances = useMemo(() => {
    const query = instanceSearch.trim().toLowerCase();
    if (!query) return instances;
    return instances.filter((instance) =>
      [instance.name, instance.id, instance.loader, instance.mc, instance.version_id, instance.description]
        .some((value) => value.toLowerCase().includes(query)),
    );
  }, [instances, instanceSearch]);
  const versionsPerPage = 20;
  const versionPageCount = Math.max(1, Math.ceil(filtered.length / versionsPerPage));
  const currentVersionPage = Math.min(versionPage, versionPageCount);
  const pagedVersions = filtered.slice(0, currentVersionPage * versionsPerPage);
  const firstRunMc = wMc || vinfo.find((v) => v.kind === "release")?.id || "";

  useEffect(() => {
    if (firstRunOpen && vinfo.length > 0 && !wMc) {
      setWMc(vinfo.find((v) => v.kind === "release")?.id ?? vinfo[0].id);
    }
  }, [firstRunOpen, vinfo, wMc]);

  // progress of the current download (looks back to the last "start" line)
  const progress = useMemo(() => {
    for (let i = activityLog.length - 1; i >= 0; i--) {
      if (activityLog[i] === "Creating instance..." || activityLog[i] === "Logging in...") break;
      const m = activityLog[i].match(/^(Assets|Libraries) (\d+)\/(\d+)/);
      if (m) return { label: m[1], pct: Math.round((+m[2] / +m[3]) * 100) };
    }
    return null;
  }, [activityLog]);
  const status = activityLog[activityLog.length - 1] ?? "Ready";
  const startupChecks = [
    { label: "Launcher settings", ready: settingsLoaded },
    { label: "Accounts and instances", ready: accountsReady && instancesReady },
    { label: "Minecraft version catalog", ready: versionsReady },
    { label: "Themes", ready: themesReady },
    { label: "Launcher update check", ready: updateCheckComplete },
  ];
  const completedStartupChecks = startupChecks.filter((check) => check.ready).length;
  const activeStartupCheck = startupChecks.find((check) => !check.ready);
  const startupReady = (completedStartupChecks === startupChecks.length && bootMinimumElapsed) || bootTimedOut;
  useEffect(() => {
    const root = document.getElementById("root");
    if (root) {
      (root.style as any).zoom = String(isSplashWindow ? 1 : st.uiScale / 100);
    }
    document.getElementById("portals")?.style.setProperty("--modal-ui-scale", String(isSplashWindow ? 1 : st.uiScale / 100));
    document.body.className = st.reduceAnimations ? "reduce-animations" : "";
  }, [st.uiScale, st.reduceAnimations, isSplashWindow]);

  useEffect(() => {
    if (!isSplashWindow || !startupReady || mainWindowRestored.current) return;
    mainWindowRestored.current = true;
    invoke("finish_startup")
      .catch((error) => add(`Could not restore the launcher window size: ${error}`))
      .finally(() => setSplashHandoffComplete(true));
  }, [isSplashWindow, startupReady]);

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
          instance: inst.id, ram: effRam, java: java || "java",
          java_mode: st.javaRuntime,
          jvm_args: st.jvmArgs, game_args: gameArgs, hide: st.hide,
          volume: st.volumeOn ? st.volume : null,
        },
      });
      add("Game started.");
      // The backend's `play` command returns once the process is spawned (right
      // after the asset/library/Java checks), not when the game exits — so this
      // is the moment to switch from "busy/checking" to "the instance is running".
      setGameRunning(true);
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
      const r = editingAccountId
        ? await invoke<AccList>("update_account_profile", {
          req: {
            id: editingAccountId,
            custom_icon: addAccountIcon || null,
            custom_background: addAccountBackground || null,
          },
        })
        : await invoke<AccList>("add_account", {
          req: {
            kind: addKind,
            username: addUser,
            password: addPass,
            custom_icon: addAccountIcon || null,
            custom_background: addAccountBackground || null,
          },
        });
      applyList(r);
      setAddUser("");
      setAddPass("");
      setAddAccountIcon("");
      setAddAccountBackground("");
      setEditingAccountId(null);
      return true;
    } catch (e) {
      setAddErr(String(e));
      return false;
    } finally {
      setAddBusy(false);
      setMsCode(null);
    }
  };
  const openAddAccount = () => {
    setEditingAccountId(null);
    setAddAccountIcon("");
    setAddAccountBackground("");
    setAddErr("");
    setAddAccountOpen(true);
  };
  const openEditAccount = (account: Acc) => {
    setEditingAccountId(account.id);
    setAddAccountIcon(account.custom_icon ?? "");
    setAddAccountBackground(account.custom_background ?? "");
    setAddErr("");
    setAddAccountOpen(true);
  };
  const firstRunLogin = async () => {
    setFirstRunError("");
    if (await addAccount()) goToFirstRunStep(2);
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
      goToFirstRunStep(3);
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
        data: { ram, java, instance: instId, settings: st, skins, showCrashReports, startup: true },
      });
      setStartup(true);
      setFirstRunClosing(true);
      firstRunTransitionTimer.current = window.setTimeout(() => {
        setFirstRunOpen(false);
        setFirstRunClosing(false);
        firstRunTransitionTimer.current = null;
      }, 180);
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
  const runMaintenanceAction = async () => {
    if (!maintenanceAction) return;
    setMaintenanceBusy(true);
    setMaintenanceMessage("");
    try {
      const message = await invoke<string>("run_maintenance_action", { action: maintenanceAction });
      if (maintenanceAction === "delete_instances" || maintenanceAction === "factory_reset") {
        setInstances([]);
        setInstId("");
        setContentInst(null);
      }
      if (maintenanceAction === "clean_accounts" || maintenanceAction === "factory_reset") {
        setAccounts([]);
        setSelected(null);
        setSkins({});
        setSkinFail(false);
      }
      if (maintenanceAction === "factory_reset") {
        setSt(DEFAULTS);
        setInstanceDirectoryDraft("");
        setInstanceDirectoryMessage("");
        setRam(4096);
        setJava("java");
        setShowCrashReports(true);
        setStartup(false);
        setActiveSettingsTab("game");
      }
      setMaintenanceMessage(message);
      setMaintenanceAction(null);
    } catch (error) {
      setMaintenanceMessage(`Could not complete the requested cleanup: ${error}`);
    } finally {
      setMaintenanceBusy(false);
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
  const selectFromHome = (id: string) => {
    select(id)
      .then(() => setHomeAccountPickerOpen(false))
      .catch((error) => add(`Could not switch account: ${error}`));
  };
  const remove = (id: string) => invoke<AccList>("remove_account", { id }).then(applyList);

  // ---- instances ----
  const resetWizard = () => {
    setStep(1); setWMc(""); setWLoader("vanilla"); setSupport(null);
    setWName(""); setWIcon(""); setWDesc(""); setWBg(""); nameEdited.current = false;
    setBackgroundPickerOpen(false); setShowLauncherBackgrounds(false); setBackgroundPickerError("");
    setBackgroundPickerTarget("new");
    setVersionPage(1);
  };
  const newInstance = () => { resetWizard(); setTab("download"); setPage("versions"); };

  const enqueueInstance = () => {
    const name = wName.trim();
    if (!name || !wMc) return;
    installInstance({
      name, loader: wLoader, mc: wMc, icon: wIcon || LOADER_ICONS[wLoader],
      description: wDesc, background: wBg, java: java || "java", javaMode: st.javaRuntime,
      onInstalled: (list) => {
        const created = list[list.length - 1];
        setInstances(list);
        if (created) setInstId(created.id);
      },
    });
    resetWizard();
  };

  const startEdit = async (i: Instance) => {
    setEditId(null);
    setEditName(i.name); setEditIcon(i.icon);
    setEditDesc(i.description); setEditBg("");
    try {
      setEditBg(await invoke<string | null>("load_instance_background", { id: i.id }) ?? "");
      setEditId(i.id);
    } catch (e) {
      add(`Could not load instance background: ${e}`);
      setPage("console");
    }
  };
  const saveEdit = async () => {
    const editedId = editId;
    if (!editedId) return;
    try {
      const updated = await invoke<Instance[]>("edit_instance", {
        req: { id: editedId, name: editName, icon: editIcon, description: editDesc, background: editBg },
      });
      setInstances(updated);
      setContentInst((current) => current?.id === editedId
        ? updated.find((instance) => instance.id === editedId) ?? current
        : current);
      if (editedId === instId) setActiveBackground(editBg);
      setEditId(null);
    } catch (e) { add(`ERROR: ${e}`); setPage("console"); }
  };
  const toggleInstanceSelection = (id: string) => {
    setSelectedInstanceIds((selectedIds) => selectedIds.includes(id)
      ? selectedIds.filter((selectedId) => selectedId !== id)
      : [...selectedIds, id]);
  };
  const cancelInstanceSelection = () => {
    setInstanceSelectionMode(false);
    setSelectedInstanceIds([]);
  };
  const refreshInstances = async () => {
    if (instancesRefreshing) return;
    setInstancesRefreshing(true);
    try {
      const [refreshed] = await Promise.all([
        invoke<Instance[]>("list_instances"),
        new Promise((resolve) => window.setTimeout(resolve, 650)),
      ]);
      setInstances(refreshed);
      setInstId((current) => refreshed.some((instance) => instance.id === current)
        ? current
        : refreshed[0]?.id ?? "");
      setSelectedInstanceIds((selectedIds) => selectedIds.filter((id) =>
        refreshed.some((instance) => instance.id === id)));
      setContentInst((current) => current && refreshed.some((instance) => instance.id === current.id)
        ? refreshed.find((instance) => instance.id === current.id) ?? current
        : current ? null : current);
      setInstanceActionError("");
    } catch (error) {
      setInstanceActionError(`Could not refresh instances: ${error}`);
    } finally {
      setInstancesRefreshing(false);
    }
  };
  const removeSelectedInstances = async () => {
    const ids = selectedInstanceIds.filter((id) => instances.some((instance) => instance.id === id));
    if (!ids.length) {
      setDeleteInstancesConfirm(null);
      return;
    }
    setDeleteInstancesBusy(true);
    setInstanceActionError("");
    try {
      const updated = await invoke<Instance[]>("remove_instances", { req: { ids } });
      setInstances(updated);
      if (ids.includes(instId)) setInstId(updated[0]?.id ?? "");
      if (contentInst && ids.includes(contentInst.id)) setContentInst(null);
      cancelInstanceSelection();
      setDeleteInstancesConfirm(null);
    } catch (error) {
      setInstanceActionError(String(error));
      add(`ERROR: ${error}`);
      try {
        const refreshed = await invoke<Instance[]>("list_instances");
        setInstances(refreshed);
        setSelectedInstanceIds((selectedIds) => selectedIds.filter((id) => refreshed.some((instance) => instance.id === id)));
        if (ids.includes(instId) && !refreshed.some((instance) => instance.id === instId)) {
          setInstId(refreshed[0]?.id ?? "");
        }
        if (contentInst && ids.includes(contentInst.id) && !refreshed.some((instance) => instance.id === contentInst.id)) {
          setContentInst(null);
        }
      } catch (refreshError) {
        add(`ERROR: Could not refresh instances after deletion: ${refreshError}`);
      }
    } finally {
      setDeleteInstancesBusy(false);
    }
  };
  const importZipArchive = async (path: string, fallback?: { name: string; loader: string; mc: string }) => {
    setInstanceImportBusy(true);
    setInstanceActionError("");
    try {
      await startTask(fallback ? `Importing ${fallback.name}` : "Importing instance", "", async (taskId) => {
        const updated = await invoke<Instance[]>("import_instance_archive", {
          req: {
            path,
            fallback_name: fallback?.name ?? "",
            fallback_loader: fallback?.loader ?? "vanilla",
            fallback_mc: fallback?.mc ?? "",
            java: java || "java",
            java_mode: st.javaRuntime,
            task_id: taskId,
          },
        });
        setInstances(updated);
        setInstId(updated[updated.length - 1]?.id ?? "");
      }, true);
      setImportArchivePath(null);
    } catch (error) {
      setInstanceActionError(String(error));
    } finally {
      setInstanceImportBusy(false);
    }
  };
  const chooseInstanceImport = async () => {
    setInstanceActionError("");
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "Arca instance or Modrinth pack", extensions: ["zip", "mrpack"] }],
      });
      if (typeof path !== "string") return;
      if (path.toLowerCase().endsWith(".mrpack")) {
        setInstanceImportBusy(true);
        await startTask("Importing Modrinth pack", "", async (taskId) => {
          const updated = await invoke<Instance[]>("modpack_install", {
            req: {
              source: "modrinth",
              id: "",
              name: "",
              icon: "",
              description: "",
              java: java || "java",
              java_mode: st.javaRuntime,
              task_id: taskId,
              archive_path: path,
            },
          });
          setInstances(updated);
          setInstId(updated[updated.length - 1]?.id ?? "");
        }, true);
        return;
      }
      const info = await invoke<InstanceArchiveInfo>("inspect_instance_archive", { path });
      if (!info.has_metadata) {
        setImportArchivePath(path);
        setImportName(info.name);
        setImportLoader("vanilla");
        setImportMc("");
        return;
      }
      await importZipArchive(path);
    } catch (error) {
      setInstanceActionError(String(error));
    } finally {
      setInstanceImportBusy(false);
    }
  };
  const exportInstanceArchive = async (instance: Pick<Instance, "id" | "name" | "icon">) => {
    const path = await save({
      defaultPath: `${instance.name}.zip`,
      filters: [{ name: "ZIP archive", extensions: ["zip"] }],
    });
    if (path) {
      await startTask(`Exporting ${instance.name}`, instance.icon, (taskId) =>
        invoke("export_instance", { id: instance.id, path, taskId }));
    }
  };

  // custom logo/background: pick a file. Logos are cropped square to 96x96 PNG.
  // Backgrounds: static images (png/jpg) are shrunk to fit 960px wide JPEG; an animated
  // gif is kept as-is (unprocessed), since resizing through canvas would flatten it to
  // a single frame and lose the animation.
  const fileFor = useRef<"logo-new" | "logo-edit" | "bg-new" | "bg-edit" | "account-icon" | "account-background">("logo-new");
  const pickFile = (target: "logo-new" | "logo-edit" | "bg-new" | "bg-edit" | "account-icon" | "account-background") => {
    fileFor.current = target;
    if (target === "account-icon" || target === "account-background") setAddErr("");
    if (fileRef.current) {
      fileRef.current.accept = target === "bg-new" || target === "bg-edit" || target === "account-background"
        ? "image/png,image/jpeg,image/gif"
        : "image/*";
    }
    fileRef.current?.click();
  };
  const chooseLauncherBackground = async (src: string) => {
    setBackgroundPickerError("");
    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error(`Image request failed (${response.status})`);
      const blob = await response.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string"
          ? resolve(reader.result)
          : reject(new Error("Could not read the selected background image"));
        reader.onerror = () => reject(reader.error ?? new Error("Could not read the selected background image"));
        reader.readAsDataURL(blob);
      });
      if (backgroundPickerTarget === "new") setWBg(dataUrl);
      else setEditBg(dataUrl);
      setBackgroundPickerOpen(false);
      setShowLauncherBackgrounds(false);
    } catch (e) {
      setBackgroundPickerError(`Could not load the selected background: ${e}`);
    }
  };
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const target = fileFor.current;
    const isBg = target === "bg-new" || target === "bg-edit" || target === "account-background";
    const reportFileError = (message: string) => {
      if (target === "account-icon" || target === "account-background") setAddErr(message);
      else add(message);
    };

    const apply = (url: string) => {
      if (target === "logo-new") setWIcon(url);
      else if (target === "logo-edit") setEditIcon(url);
      else if (target === "bg-new") setWBg(url);
      else if (target === "bg-edit") setEditBg(url);
      else if (target === "account-icon") setAddAccountIcon(url);
      else setAddAccountBackground(url);
    };

    // Keep GIF bytes untouched so their animation is preserved even when the picker omits MIME type.
    if (isBg && (f.type.toLowerCase() === "image/gif" || /\.gif$/i.test(f.name))) {
      const rd = new FileReader();
      rd.onload = () => {
        if (typeof rd.result !== "string" || !rd.result.startsWith("data:")) {
          reportFileError(`Could not read ${f.name} as a GIF image.`);
          return;
        }
        const encoded = rd.result.split(",", 2)[1];
        if (!encoded) {
          reportFileError(`Could not read ${f.name} as a GIF image.`);
          return;
        }
        const dataUrl = `data:image/gif;base64,${encoded}`;
        const img = new Image();
        img.onload = () => apply(dataUrl);
        img.onerror = () => reportFileError(`Could not decode ${f.name} as a GIF image.`);
        img.src = dataUrl;
      };
      rd.onerror = () => reportFileError(`Could not read ${f.name}: ${rd.error?.message ?? "file read failed"}`);
      rd.readAsDataURL(f);
      return;
    }

    // static images: crop/resize through canvas as before
    const rd = new FileReader();
    rd.onload = () => {
      if (typeof rd.result !== "string") {
        reportFileError(`Could not read ${f.name} as an image.`);
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
            reportFileError(`Could not process ${f.name}: image canvas is unavailable.`);
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
            reportFileError(`Could not process ${f.name}: image canvas is unavailable.`);
            return;
          }
          ctx.drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, S, S);
          url = cv.toDataURL("image/png");
        }
        apply(url);
      };
      img.onerror = () => reportFileError(`Could not decode ${f.name} as an image.`);
      img.src = rd.result;
    };
    rd.onerror = () => reportFileError(`Could not read ${f.name}: ${rd.error?.message ?? "file read failed"}`);
    rd.readAsDataURL(f);
  };

  const shownName = current?.username ?? "No account";
  const skin = `https://mc-heads.net/body/${encodeURIComponent(shownName)}/220`;
  const nav: [Page, string, string][] = [
    ["play", "play", "Home"], ["account", "user", "Accounts"], ["versions", "grid", "Instance"], ["mods", "puzzle", "Downloader"], ["console", "term", "Console"],
  ];

  if (isSplashWindow) {
    const progressPct = Math.round((completedStartupChecks / startupChecks.length) * 100);
    return (
      <main className="splash-window" role="status" aria-live="polite">
        <div className="splash-top">
          <span className="splash-brand">ARCA LAUNCHER</span>
          <div className="splash-loading-label">
            <span>{splashHandoffComplete ? "Opening launcher" : activeStartupCheck?.label ?? "Starting launcher"}</span>
            <span>{progressPct}%</span>
          </div>
        </div>
        {!networkOnline && <p className="splash-offline">Offline right now. Online features may be unavailable.</p>}
        <div className="splash-progress"><span style={{ "--progress-width": `${progressPct}%` } as CSSVars} /></div>
      </main>
    );
  }

  return (
    <div className="shell" style={{ "--shell-height": `${winH / (st.uiScale / 100)}px` } as CSSVars}>
      {firstRunOpen && createPortal(
        <div className={"onboarding-overlay" + (firstRunClosing ? " is-closing" : "")}>
          <section className="onboarding-card" aria-labelledby="onboarding-title">

            <div key={firstRunStep} className={`onboarding-step${firstRunTransition === "exit" ? " is-exiting" : firstRunTransition === "enter" ? " is-entering" : ""}`}>
            {firstRunStep === 0 && (
              <div className="onboarding-content onboarding-welcome">
                <h1 id="onboarding-title">Welcome to Arca</h1>
                <p>Let’s get your launcher ready. Sign in with an account, then create your first Minecraft instance. You can skip either step and set it up later.</p>
                <button className="btn purple onboarding-primary" onClick={() => { setFirstRunError(""); goToFirstRunStep(1); }}>Get started <span>→</span></button>
              </div>
            )}

            {firstRunStep === 1 && (
              <div className="onboarding-content">
                <span className="eyebrow">STEP 1 OF 3</span>
                <h1 id="onboarding-title">Choose how to sign in</h1>
                <p className="onboarding-description">Use an existing account or create an offline profile. You can add more accounts later.</p>
                <div className="onboarding-account-types">
                  {(["offline", "microsoft", "elyby"] as const).map((kind) => (
                    <button key={kind} className={"onboarding-account-type" + (addKind === kind ? " active" : "")} onClick={() => { setAddKind(kind); setAddErr(""); setFirstRunError(""); }}>
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
                  {addKind === "microsoft" && (
                    <p className="hint onboarding-login-hint">A browser window will open to complete Microsoft sign-in.</p>
                  )}
                </div>

                {msCode && addBusy && <div className="code onboarding-code">Enter code <b>{msCode.code}</b> at {msCode.url}</div>}
                {(firstRunError || addErr) && <div className="err">{firstRunError || addErr}</div>}
                <footer className="onboarding-actions">
                  <button className="mini" onClick={() => { setFirstRunError(""); goToFirstRunStep(0); }} disabled={addBusy}>Back</button>
                  <button className="onboarding-skip" onClick={() => { setFirstRunError(""); goToFirstRunStep(2); }} disabled={addBusy}>Continue without signing in</button>
                  <button className="btn purple" onClick={() => void firstRunLogin()} disabled={addBusy}>
                    {addBusy ? "Signing in..." : addKind === "offline" ? "Add account" : "Sign in"}
                  </button>
                </footer>
              </div>
            )}

            {firstRunStep === 2 && (
              <div className="onboarding-content onboarding-instance">
                <span className="eyebrow">STEP 2 OF 3</span>
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
                    <div className="pbar"><span style={{ "--progress-width": `${progress?.pct ?? 5}%` } as CSSVars} /></div>
                    {progress && <small>{progress.label} {progress.pct}%</small>}
                  </div>
                )}
                <footer className="onboarding-actions">
                  <button className="mini" onClick={() => { setFirstRunError(""); goToFirstRunStep(1); }} disabled={firstRunBusy}>Back</button>
                  <button className="onboarding-skip" onClick={() => { setFirstRunError(""); goToFirstRunStep(3); }} disabled={firstRunBusy}>Skip for now</button>
                  <button className="btn purple" onClick={() => void firstRunInstall()} disabled={firstRunBusy || !firstRunMc || (wLoader !== "vanilla" && !support?.includes(wLoader))}>
                    {firstRunBusy ? "Installing..." : "Install instance"}
                  </button>
                </footer>
              </div>
            )}

            {firstRunStep === 3 && (
              <div className="onboarding-content onboarding-tips">
                <span className="eyebrow">QUICK TOUR</span>
                <h1 id="onboarding-title">A few helpful tips</h1>
                <p className="onboarding-description">You can change these choices later. Here are a few places to start.</p>
                <div className="onboarding-tip-list">
                  <article className="onboarding-tip">
                    <span>01</span>
                    <div><b>Keep profiles organized</b><p>Add or switch accounts from Accounts. You can personalize each profile with its own icon and banner.</p></div>
                  </article>
                  <article className="onboarding-tip">
                    <span>02</span>
                    <div><b>Make another instance anytime</b><p>Instances keep Minecraft versions, loaders, saves, and settings separate. Create and manage them from Instance.</p></div>
                  </article>
                  <article className="onboarding-tip">
                    <span>03</span>
                    <div><b>Find more content</b><p>Browse mods and modpacks in Downloader. Check Settings to adjust memory, Java, appearance, and more.</p></div>
                  </article>
                </div>
                <footer className="onboarding-actions">
                  <button className="mini" onClick={() => goToFirstRunStep(2)}>Back</button>
                  <button className="btn purple" onClick={() => goToFirstRunStep(4)}>Continue</button>
                </footer>
              </div>
            )}

            {firstRunStep === 4 && (
              <div className="onboarding-content onboarding-welcome">
                <h1 id="onboarding-title">Ready to play</h1>
                <p>{current ? `Signed in as ${current.username}.` : "You can sign in any time from Accounts."} {inst ? `${inst.name} is ready to launch.` : "Create an instance whenever you’re ready."}</p>
                {firstRunError && <div className="err">{firstRunError}</div>}
                <div className="onboarding-ready-actions">
                  <button className="btn purple onboarding-primary" onClick={() => void finishFirstRun()}>Start using Arca <span>→</span></button>
                </div>
              </div>
            )}
            </div>
          </section>
        </div>,
        getPortalRoot(),
      )}
      <input ref={fileRef} className="file-input-hidden" type="file" accept="image/*" onChange={onFile} />
      <header className="topbar">
        <div className="logo"><img className="launcher-logo-image" src={LAUNCHER_LOGO} alt="" /></div>
        <div className="brand">Arca Launcher</div>
        <div className="chips">
          <span className={"chip network-chip " + (networkOnline ? "online" : "offline")} aria-label={"Network " + (networkOnline ? "online" : "offline")}>
            <i className="dot" />{networkOnline ? "Online" : "Offline"}
          </span>
          {launcherUpdate?.update_available && (
            <button className="chip update-chip" onClick={() => setPage("settings")} title="Open settings to download the latest launcher release">
              Update available · {launcherUpdate.latest_version}
            </button>
          )}
          <span className="chip">{inst ? `${cap(inst.loader)} ${inst.mc}` : "No instance"}</span>
          <span className="chip">{(effRam / 1024).toFixed(1)} GB RAM</span>
        </div>
      </header>

      <div className="body">
        <nav className="side">
          {nav.map(([p, ic, label]) => (
            <button key={p} className={"nav" + (page === p ? " on" : "")} onClick={() => setPage(p)} title={label}>
              <Icon n={ic} />
            </button>
          ))}
          <div className="grow" />
          <button className={"nav" + (page === "settings" ? " on" : "")} onClick={() => setPage("settings")} title="Settings">
            <Icon n="gear" />
          </button>
        </nav>

        <main className="content">
          <div key={page === "mods" ? "__mods__" : page} className={"pagewrap " + (fade === "out" ? "out" : "in") + (page === "mods" ? " hidden" : "")}>
          {page === "play" && (
            <div className="play-screen">
              <div className="top play-feature-row">
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
                        {instances.map((i, index) => (
                          <button key={i.id} className={("mitem" + (i.id === instId ? " on" : "") + " animate-stagger")}
                            style={{ animationDelay: `${Math.min(index, 20) * 0.03}s` }}
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
                    <button className={"launch" + (gameRunning ? " is-running" : "")} disabled={busy || gameRunning}
                      onClick={!current ? () => setPage("account") : !inst ? newInstance : play}>
                      <b>{gameRunning ? "RUNNING" : busy ? "WORKING..." : !current ? "ADD AN ACCOUNT" : !inst ? "NEW INSTANCE" : `LAUNCH ${inst.mc}`}</b>
                      <small>{gameRunning ? "The instance is running right now" : busy ? status.slice(0, 34) : !current ? "You need an account to play" : !inst ? "Download a version first" : `${inst.name} · ${KIND_LABEL[current.kind]}`}</small>
                      {busy && progress && <span className="bar" style={{ "--progress-width": `${progress.pct}%` } as CSSVars} />}
                      <span className="launch-arrow" aria-hidden="true">→</span>
                    </button>
                  </div>
                </section>

                <div className="rightcol">
                <aside
                  className={"player" + (current?.custom_background ? " has-profile-background" : "")}
                  style={current?.custom_background ? {
                    backgroundImage: `linear-gradient(180deg, rgba(10,9,16,.48), rgba(10,9,16,.78) 58%, rgba(10,9,16,.94)), url("${current.custom_background}")`,
                  } : undefined}
                >
                  <div className="play-profile-heading">
                    <span className="eyebrow">PLAYER PROFILE</span>
                    <span className={"play-profile-state" + (current ? " ready" : "")}><i />{current ? "Ready" : "Account needed"}</span>
                  </div>
                  {current && skins[current.id]?.data ? (
                    <SkinModel data={skins[current.id]!.data!} slim={skins[current.id]!.slim} className="home-player-model" />
                  ) : current?.kind === "offline" && !skinFail ? (
                    <img className="skin" src={skin} alt="" onError={() => setSkinFail(true)} />
                  ) : <div className="skin ph" />}
                  <div className="pname">{shownName}</div>
                  <div className="home-account-wrap">
                    <button
                      className="btn purple home-account-trigger"
                      aria-expanded={homeAccountPickerOpen}
                      aria-haspopup="listbox"
                      onClick={() => setHomeAccountPickerOpen((open) => !open)}
                    >
                      Switch Account <span className="chev">▾</span>
                    </button>
                    {homeAccountPickerOpen && (<>
                      <div className="scrim" onClick={() => setHomeAccountPickerOpen(false)} />
                      <div className="menu home-account-menu" role="listbox" aria-label="Switch account">
                        {accounts.length === 0
                          ? <p className="home-account-empty">No saved accounts. Add one from Accounts.</p>
                          : accounts.map((account, index) => (
                            <button
                              key={account.id}
                              className={("mitem home-account-option" + (account.id === selected ? " on" : "") + " animate-stagger")}
                              style={{ animationDelay: `${Math.min(index, 20) * 0.03}s` }}
                              role="option"
                              aria-selected={account.id === selected}
                              onClick={() => selectFromHome(account.id)}
                            >
                              <Avatar acc={account} skin={skins[account.id] ?? null} />
                              <span className="home-account-option-info">
                                <b>{account.username}</b>
                                <small>{KIND_LABEL[account.kind]}</small>
                              </span>
                              {account.id === selected && <span className="home-account-current">Current</span>}
                            </button>
                          ))}
                      </div>
                    </>)}
                  </div>
                </aside>
                <section className="changelog" aria-label="Launcher changelog">
                <header className="play-changelog-heading">
                  <div><span className="eyebrow">WHAT'S NEW</span><h2>Launcher updates</h2></div>
                  <span className="play-changelog-count">{CHANGELOG.length} releases</span>
                </header>
                <div className="play-changelog-list" aria-label="Recent launcher updates">
                  {CHANGELOG.map((c) => (
                    <article key={c.v} className="cl">
                      <div className="clhead"><span className="clv">v{c.v}</span><b>{c.title}</b></div>
                      {"sections" in c
                        ? c.sections.map((section) => (
                          <div key={section.title}>
                            <b className="cl-section-title">{section.title}</b>
                            <ul>{section.items.map((it) => <li key={it}>{it}</li>)}</ul>
                          </div>
                        ))
                        : <ul>{c.items.map((it) => <li key={it}>{it}</li>)}
                      </ul>}
                    </article>
                  ))}
                </div>
                </section>
                </div>
              </div>
              <section className="minecraft-news" aria-label="Minecraft news">
                <header className="play-news-heading">
                  <div><span className="eyebrow">FROM MINECRAFT.NET</span><h2>Latest Minecraft news</h2></div>
                  <span className="play-news-count">{minecraftNews.length ? `${minecraftNews.length} stories` : "Official news feed"}</span>
                </header>
                {minecraftNewsError && (
                  <div className="play-news-status" role="status">
                    <span>{minecraftNewsError}</span>
                    <button className="mini" onClick={() => setMinecraftNewsRefresh((value) => value + 1)} disabled={minecraftNewsLoading}>
                      {minecraftNewsLoading ? "Loading..." : "Retry"}
                    </button>
                  </div>
                )}
                {minecraftNewsLinkError && <p className="play-news-link-error" role="status">{minecraftNewsLinkError}</p>}
                <div className="play-news-viewport">
                  {minecraftNewsLoading && minecraftNews.length === 0
                    ? <div className="play-news-track is-loading">{Array.from({ length: 4 }, (_, index) => <div key={index} className="play-news-skeleton" aria-hidden="true" />)}</div>
                    : minecraftNews.length > 0 && (
                      <div className="play-news-track" style={{ "--news-slide-duration": `${Math.max(45, minecraftNews.length * 5)}s` } as CSSVars}>
                        {[false, true].map((duplicate) => (
                          <div key={duplicate ? "clone" : "news"} className="play-news-group" aria-hidden={duplicate || undefined}>
                            {minecraftNews.map((entry, index) => duplicate ? (
                              <a
                                key={`${entry.title}-${entry.date ?? ""}-${index}`}
                                className="play-news-card"
                                href={entry.link ?? undefined}
                                tabIndex={-1}
                                onClick={(event) => {
                                  event.preventDefault();
                                  void openMinecraftNews(entry.link);
                                }}
                              >
                                {entry.imageUrl
                                  ? <img className="play-news-image" src={entry.imageUrl} alt="" loading="lazy" />
                                  : <span className="play-news-image play-news-image-placeholder" aria-hidden="true" />}
                                <span className="play-news-copy">
                                  <span className="play-news-meta">
                                    <span className="play-news-labels">
                                      <span className="play-news-tag">{entry.category || "Minecraft"}</span>
                                      {entry.tag && <span className="play-news-type">{entry.tag}</span>}
                                    </span>
                                    {entry.date && <time dateTime={entry.date}>{entry.date}</time>}
                                  </span>
                                  <b>{entry.title}</b>
                                  {entry.text && <span className="play-news-description">{entry.text}</span>}
                                  {entry.link && <span className="play-news-readmore">Read story <span aria-hidden="true">→</span></span>}
                                </span>
                              </a>
                            ) : (
                              <button
                                key={`${entry.title}-${entry.date ?? ""}-${index}`}
                                className="play-news-card"
                                onClick={() => void openMinecraftNews(entry.link)}
                                disabled={!entry.link}
                                aria-label={entry.link ? `Read ${entry.title}` : entry.title}
                              >
                                {entry.imageUrl
                                  ? <img className="play-news-image" src={entry.imageUrl} alt="" loading="lazy" />
                                  : <span className="play-news-image play-news-image-placeholder" aria-hidden="true" />}
                                <span className="play-news-copy">
                                  <span className="play-news-meta">
                                    <span className="play-news-labels">
                                      <span className="play-news-tag">{entry.category || "Minecraft"}</span>
                                      {entry.tag && <span className="play-news-type">{entry.tag}</span>}
                                    </span>
                                    {entry.date && <time dateTime={entry.date}>{entry.date}</time>}
                                  </span>
                                  <b>{entry.title}</b>
                                  {entry.text && <span className="play-news-description">{entry.text}</span>}
                                  {entry.link && <span className="play-news-readmore">Read story <span aria-hidden="true">→</span></span>}
                                </span>
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  {!minecraftNewsLoading && !minecraftNewsError && minecraftNews.length === 0 && (
                    <p className="play-news-empty">No recent Minecraft news is available right now.</p>
                  )}
                </div>
              </section>
            </div>
          )}

          {page === "account" && (
            <section className="panel account-page">
              <header className="page-heading">
                <div><span className="eyebrow">PLAYER PROFILES</span><h2>Accounts</h2>
                  <p>Manage your profiles and choose who joins your next adventure.</p></div>
                <div className="account-heading-actions">
                  <span className="count-chip">{accounts.length} {accounts.length === 1 ? "account" : "accounts"}</span>
                  <button className="library-icon-action library-icon-action-expand account-add-trigger" onClick={openAddAccount} aria-label="Add account">
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
                    <span>Add account</span>
                  </button>
                </div>
              </header>

              <div className="account-layout">
                <section className="account-section account-list-section">
                  <div className="section-heading account-list-heading">
                    <div><h3>Your profiles</h3><p>Select a profile to see its details.</p></div>
                  </div>
                  <div className="alist">
                    {accounts.length === 0 && (
                      <div className="account-empty"><span className="empty-avatar"><Icon n="user" /></span>
                        <b>No accounts yet</b><p>Add a profile to get started.</p>
                        <button className="mini account-empty-add" onClick={openAddAccount}>Add your first account</button>
                      </div>
                    )}
                    {accounts.map((a, index) => (
                      <button
                        key={a.id}
                        className={"account-entry" + (a.id === focusedAccount?.id ? " focused" : "") + " animate-stagger"}
                        style={{ animationDelay: `${Math.min(index, 20) * 0.03}s` }}
                        aria-pressed={a.id === focusedAccount?.id}
                        onClick={() => setFocusedAccountId(a.id)}
                      >
                        <span className="account-entry-avatar"><Avatar acc={a} skin={skins[a.id] ?? null} /></span>
                        <span className="account-entry-info">
                          <b>{a.username}</b>
                          <small>{KIND_LABEL[a.kind] ?? a.kind}</small>
                        </span>
                        {a.id === selected
                          ? <span className="account-active-indicator"><i />Active</span>
                          : <span className="account-entry-chevron" aria-hidden="true">›</span>}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="account-section account-detail-section" aria-live="polite">
                  {focusedAccount ? (
                    <>
                      <div className="account-profile-banner">
                        {focusedAccount.custom_background && (
                          <span
                            className="account-custom-banner-background"
                            style={{ backgroundImage: `linear-gradient(90deg, rgba(23,20,32,.38), rgba(23,20,32,.08)), url("${focusedAccount.custom_background}")` }}
                          />
                        )}
                        <div className="account-banner-figure" aria-hidden="true">
                          {focusedSkin?.data && (
                            <SkinModel
                              data={focusedSkin.data}
                              slim={focusedSkin.slim}
                              s={4.5}
                              className="account-banner-model"
                              initialRotation={{ x: -24, y: -32 }}
                            />
                          )}
                        </div>
                        <span className="account-profile-avatar"><Avatar acc={focusedAccount} skin={skins[focusedAccount.id] ?? null} /></span>
                        <button
                          className="account-banner-edit"
                          type="button"
                          aria-label={`Edit ${focusedAccount.username} profile appearance`}
                          title="Edit profile appearance"
                          onClick={() => openEditAccount(focusedAccount)}
                        >
                          <img src={INSTANCE_EDIT_ICON} alt="" />
                        </button>
                        {focusedAccount.id === selected && <span className="account-profile-active"><i /> Active account</span>}
                      </div>
                      <div className="account-profile-heading">
                        <div>
                          <span className="eyebrow">MINECRAFT PROFILE</span>
                          <h3 title={focusedAccount.username}>{focusedAccount.username}</h3>
                          <p>{KIND_LABEL[focusedAccount.kind] ?? focusedAccount.kind} account</p>
                        </div>
                      </div>
                      <div className="account-detail-list">
                        <div className="account-detail-row">
                          <span>Account type</span><b>{KIND_LABEL[focusedAccount.kind] ?? focusedAccount.kind}</b>
                        </div>
                        <div className="account-detail-row account-uuid-row">
                          <span>Player UUID</span><b title={focusedAccount.uuid}>{focusedAccount.uuid || "Not available"}</b>
                        </div>
                      </div>
                      <div className="account-profile-actions">
                        {focusedAccount.id !== selected && (
                          <button
                            className="library-icon-action library-icon-action-expand account-set-active"
                            aria-label="Set as active"
                            onClick={() => {
                              setFocusedAccountId(focusedAccount.id);
                              select(focusedAccount.id).catch((error) => add(`Could not switch account: ${error}`));
                            }}
                          >
                            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8.2 3.2 3.1L13 4.7" /></svg>
                          <span>Set as active</span>
                          </button>
                        )}
                        <button className="library-icon-action library-icon-action-expand account-remove" aria-label="Remove account" onClick={() => remove(focusedAccount.id).catch((error) => add(`Could not remove account: ${error}`))}>
                          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4m2.5 0-.7 9.5H4.2L3.5 4m2.7 2v5m3.6-5v5" /></svg>
                          <span>Remove account</span>
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="account-detail-empty">
                      <span className="empty-avatar"><Icon n="user" /></span>
                      <h3>Your next adventure starts here</h3>
                      <p>Add a Minecraft profile to see its details and set it as active.</p>
                      <button className="btn purple" onClick={openAddAccount}>Add an account</button>
                    </div>
                  )}
                </section>
              </div>

              {addAccountOpen && createPortal(
                <div className="editbackdrop account-modal-backdrop" onClick={(event) => {
                  if (event.target === event.currentTarget && !addBusy) setAddAccountOpen(false);
                }}>
                  <section className={`editdialog account-add-dialog ${editingAccountId ? "account-edit-dialog" : "account-create-dialog"} pop`} role="dialog" aria-modal="true" aria-labelledby="account-modal-title">
                    <header className="editdialoghead">
                      <div className="editdialogtitle">
                        <h2 id="account-modal-title">{editingAccountId ? "Edit profile appearance" : "Create account"}</h2>
                        <p>{editingAccountId ? "Customize the icon and banner shown for this profile." : "Choose how you want to sign in to Arca Launcher."}</p>
                      </div>
                    </header>
                    <form className={`editdialogbody account-add-form${editingAccountId ? " account-edit-form" : " account-create-form"}`} onSubmit={(event) => {
                      event.preventDefault();
                      void addAccount().then((success) => { if (success) setAddAccountOpen(false); });
                    }}>
                      {!editingAccountId && <div className="account-kind-grid" role="group" aria-label="Account type">
                        {KINDS.map(([kind, label]) => (
                          <button
                            key={kind}
                            type="button"
                            className={"account-kind-option" + (addKind === kind ? " active" : "")}
                            disabled={addBusy}
                            onClick={() => { setAddKind(kind); setAddErr(""); }}
                          >
                            <b>{label}</b>
                            <small>{kind === "offline" ? "Quick local profile" : kind === "elyby" ? "Sign in with Ely.by" : "Official Microsoft login"}</small>
                          </button>
                        ))}
                      </div>}
                      {editingAccountId && (
                        <>
                          <div className="editfield">
                            <label>Profile icon <span className="editoptional">Optional</span></label>
                            <div className="editassetrow">
                              <div className="editiconpreview account-icon-preview">
                                {addAccountIcon
                                  ? <img src={addAccountIcon} alt="Custom profile icon preview" />
                                  : <span className="empty-avatar"><Icon n="user" /></span>}
                              </div>
                              <div className="editassetactions">
                                <button className="mini" type="button" disabled={addBusy} onClick={() => pickFile("account-icon")}>Choose image...</button>
                                {addAccountIcon && <button className="mini" type="button" disabled={addBusy} onClick={() => setAddAccountIcon("")}>Use default</button>}
                              </div>
                            </div>
                          </div>
                          <div className="editfield">
                            <label>Profile banner <span className="editoptional">Optional · Image or GIF</span></label>
                            <div className="editassetrow editbackgroundrow account-banner-assetrow">
                              {addAccountBackground
                                ? <div className="bgpreview editbgpreview account-banner-preview"><img src={addAccountBackground} alt="Custom banner preview" /></div>
                                : <div className="bgpreview ph editbgpreview account-banner-preview"><span>No custom banner</span></div>}
                              <div className="editassetactions">
                                <button className="mini" type="button" disabled={addBusy} onClick={() => pickFile("account-background")}>Choose banner...</button>
                                {addAccountBackground && <button className="mini" type="button" disabled={addBusy} onClick={() => setAddAccountBackground("")}>Remove</button>}
                              </div>
                            </div>
                          </div>
                        </>
                      )}
                      {!editingAccountId && addKind === "offline" && (
                        <div className="editfield">
                          <label htmlFor="account-username">Username <span className="field-note">Added instantly</span></label>
                          <input id="account-username" autoFocus className="editinput" value={addUser} onChange={(event) => setAddUser(event.target.value)} required maxLength={16} placeholder="Choose a player name" />
                        </div>
                      )}
                      {!editingAccountId && addKind === "elyby" && (
                        <>
                          <div className="editfield">
                            <label htmlFor="account-elyby-username">Ely.by username or email</label>
                            <input id="account-elyby-username" autoFocus className="editinput" value={addUser} onChange={(event) => setAddUser(event.target.value)} required placeholder="Username or email" />
                          </div>
                          <div className="editfield">
                            <label htmlFor="account-elyby-password">Password <span className="field-note">For 2FA, use password:2FACODE</span></label>
                            <input id="account-elyby-password" className="editinput" type="password" value={addPass} onChange={(event) => setAddPass(event.target.value)} required placeholder="Enter your password" />
                          </div>
                        </>
                      )}
                      {!editingAccountId && addKind === "microsoft" && (
                        <p className="hint account-notice">A secure browser window will open with a code to enter and complete sign-in.</p>
                      )}
                      {msCode && addBusy && <div className="code">Enter code <b>{msCode.code}</b> at {msCode.url}</div>}
                      {addErr && <div className="err" role="alert">{addErr}</div>}
                      <footer className="btnrow editdialogfooter account-modal-footer">
                        <button className="mini" type="button" disabled={addBusy} onClick={() => setAddAccountOpen(false)}>Cancel</button>
                        <button className="btn purple addbtn" type="submit" disabled={addBusy}>
                          {addBusy ? "Waiting..." : editingAccountId ? "Save changes" : addKind === "offline" ? "Add account" : addKind === "elyby" ? "Sign in & add" : "Sign in with Microsoft"}
                        </button>
                      </footer>
                    </form>
                  </section>
                </div>,
                getPortalRoot(),
              )}
            </section>
          )}

          {page === "versions" && (
            contentInst ? (
              <div key={contentInst.id} className="content-detail-enter">
                <ContentPage
                  inst={contentInst}
                  onBack={() => setContentInst(null)}
                  onEdit={() => void startEdit(contentInst)}
                  onExport={exportInstanceArchive}
                />
              </div>
            ) : (
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
                <div className="new-instance-flow">
                  <nav className="steps" aria-label="New instance setup">
                    {[
                      ["Version", "Choose game version"],
                      ["Loader", "Pick mod support"],
                      ["Details", "Make it yours"],
                    ].map(([label, hint], i) => (
                      <button
                        key={label}
                        type="button"
                        className={"stp" + (step === i + 1 ? " on" : "") + (step > i + 1 ? " done" : "")}
                        disabled={step < i + 1}
                        onClick={() => setStep(i + 1)}
                        aria-current={step === i + 1 ? "step" : undefined}
                      >
                        <span className="stp-number">{step > i + 1 ? "✓" : i + 1}</span>
                        <span className="stp-copy"><b>{label}</b><small>{hint}</small></span>
                      </button>
                    ))}
                  </nav>

                <div key={step} className={"stepbox new-instance-step" + (step === 2 ? " new-instance-loader-step" : "")}>
                {step === 1 && (<>
                  <div className="new-step-heading">
                    <div><h3>Choose your Minecraft version</h3><p>Pick the release you want this instance to run.</p></div>
                    <span className="new-step-count">{filtered.length} available</span>
                  </div>
                  <label className="version-search">
                    <span className="instance-search-glyph" aria-hidden="true" />
                    <input placeholder="Search versions, e.g. 1.20.4..." value={filter} onChange={(e) => { setFilter(e.target.value); setVersionPage(1); }} />
                  </label>
                  <div className="vlist">
                    {pagedVersions.map((v) => (
                      <button key={v.id} className={"vrow " + v.kind + (v.id === wMc ? " on" : "")}
                        onClick={() => setWMc(v.id)}
                        aria-pressed={v.id === wMc}>
                        <span className="vrow-main"><LoaderIcon loader="vanilla" size={28} /><b>{v.id}</b></span>
                        <span className="vrow-trailing"><span className="vkind">{kindLabel(v)}</span><span className="vrow-check">{v.id === wMc ? "✓" : "○"}</span></span>
                      </button>
                    ))}
                    {filtered.length > versionsPerPage && (
                    <div className="version-pagination">
                      <span>Showing {Math.min(currentVersionPage * versionsPerPage, filtered.length)} of {filtered.length} versions</span>
                      {currentVersionPage < versionPageCount && <button className="mini" onClick={() => setVersionPage(currentVersionPage + 1)}>Load more versions</button>}
                    </div>
                  )}
                    {filtered.length === 0 && <div className="new-version-empty">No versions match that search.</div>}
                  </div>
                  {vinfo.length === 0 && <p className="hint">Loading the version list...</p>}
                  {(st.showBeta || st.showAlpha) && <p className="hint">Old alpha and beta versions need Java 8 and may not start correctly.</p>}
                  <div className="btnrow new-step-footer">
                    <span className="new-selection-hint">{wMc ? `Selected: Minecraft ${wMc}` : "Select a version to continue."}</span>
                    <button className="btn purple addbtn" disabled={!wMc} onClick={() => setStep(2)}>Next: choose loader <span aria-hidden="true">→</span></button>
                  </div>
                </>)}

                {step === 2 && (<>
                  <div className="new-step-heading">
                    <div><h3>How do you want to play?</h3><p>Choose a loader for Minecraft {wMc}. Vanilla needs no extra loader.</p></div>
                    <span className="new-step-count">Minecraft {wMc}</span>
                  </div>
                  <div className="lgrid">
                    {LOADERS.map((l) => {
                      const ok = l === "vanilla" || (support !== null && support.includes(l));
                      return (
                        <button key={l} className={"lcard" + (wLoader === l ? " on" : "")} disabled={!ok}
                          onClick={() => { setWLoader(l); if (!nameEdited.current) setWName(`${cap(l)} ${wMc}`); }}
                          aria-pressed={wLoader === l}>
                          <span className="lcard-icon"><LoaderIcon loader={l} size={40} /></span>
                          <span className="lcard-copy"><b>{cap(l)}</b><small>{ok ? SHORT[l] : support === null ? "Checking..." : "Not available for this version"}</small></span>
                          <span className="lcard-check">{wLoader === l ? "✓" : "→"}</span>
                        </button>
                      );
                    })}
                  </div>
                  {support === null && <p className="new-step-note">Checking loader compatibility for this Minecraft version…</p>}
                  <div className="btnrow new-step-footer">
                    <button className="mini" onClick={() => setStep(1)}>← Back to versions</button>
                    <button className="btn purple addbtn" onClick={() => setStep(3)}>Next: instance details <span aria-hidden="true">→</span></button>
                  </div>
                </>)}

                {step === 3 && (<>
                  <div className="new-step-heading">
                    <div><h3>Give this instance a name</h3><p>Personalize its identity. You can change these details later.</p></div>
                    <div className="new-build-chip"><InstIcon inst={{ loader: wLoader, icon: wIcon }} size={28} /><span><b>Minecraft {wMc}</b><small>{cap(wLoader)}</small></span></div>
                  </div>
                  <div className="new-instance-form">
                    <section className="new-form-section">
                      <label htmlFor="new-instance-name">Instance name</label>
                      <input id="new-instance-name" value={wName} onChange={(e) => { nameEdited.current = true; setWName(e.target.value); }} placeholder="e.g. Survival with friends" autoFocus />
                      <label htmlFor="new-instance-description">Description <span className="field-note">Optional</span></label>
                      <textarea id="new-instance-description" className="desc" rows={2} value={wDesc} onChange={(e) => setWDesc(Array.from(e.target.value).slice(0, 1200).join(""))}
                        placeholder="What will you use this setup for?" />
                      <span className="description-counter">{Array.from(wDesc).length}/1200</span>
                    </section>
                    <section className="new-form-section new-form-assets">
                      <div className="new-asset-group">
                        <label>Instance icon</label>
                        <div className="new-icon-preview"><InstIcon inst={{ loader: wLoader, icon: wIcon }} size={48} /></div>
                        <div className="new-asset-actions">
                          <button className="mini" onClick={() => pickFile("logo-new")}>Choose icon</button>
                          <button className="mini" onClick={() => setWIcon("")}>Reset</button>
                        </div>
                      </div>
                      <div className="new-asset-group new-background-group">
                        <label>Card background <span className="field-note">Optional</span></label>
                        <div className="new-background-preview">
                          {wBg ? <BgPreview className="bgpreview" src={wBg} /> : <span className="new-background-placeholder">No background selected</span>}
                        </div>
                        <div className="new-asset-actions">
                          <button className="mini" onClick={() => {
                            setBackgroundPickerTarget("new");
                            setBackgroundPickerError("");
                            setShowLauncherBackgrounds(false);
                            setBackgroundPickerOpen(true);
                          }}>Choose background</button>
                          {wBg && <button className="mini" onClick={() => setWBg("")}>Remove</button>}
                        </div>
                      </div>
                    </section>
                  </div>
                  <div className="btnrow new-step-footer">
                    <button className="mini" onClick={() => setStep(2)}>← Back to loader</button>
                    <button className="btn purple addbtn" disabled={!wName.trim()} onClick={enqueueInstance}>Create and install <span aria-hidden="true">→</span></button>
                  </div>
                </>)}
                </div>
                </div>
              </>)}

              {tab === "instances" && (
                <>
                  <div className="instances-toolbar">
                    <label className="instance-search">
                      <span className="instance-search-glyph" aria-hidden="true" />
                      <input
                        type="text"
                        value={instanceSearch}
                        onChange={(event) => setInstanceSearch(event.target.value)}
                        placeholder="Search by name, version, or loader..."
                        aria-label="Search instances"
                      />
                      {instanceSearch && <button className="instance-search-clear" aria-label="Clear search" onClick={() => setInstanceSearch("")}>×</button>}
                    </label>
                    <span className="instance-count">{filteredInstances.length} of {instances.length} instances</span>
                    <div className="instance-toolbar-actions">
                      <button
                        className={"library-icon-action library-icon-action-expand instance-toolbar-icon instance-toolbar-refresh instance-refresh" + (instancesRefreshing ? " refreshing" : "")}
                        onClick={() => void refreshInstances()}
                        disabled={instancesRefreshing}
                        aria-label="Refresh instances"
                      >
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M13.2 6A5.5 5.5 0 0 0 3 4.4L1.8 5.7M1.8 2.8v2.9h2.9M2.8 10a5.5 5.5 0 0 0 10.2 1.6l1.2-1.3m0 2.9v-2.9h-2.9" />
                        </svg>
                        <span>Refresh</span>
                      </button>
                      <button className="library-icon-action library-icon-action-expand instance-toolbar-icon instance-toolbar-import" onClick={() => void chooseInstanceImport()} disabled={instanceImportBusy}>
                        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 10V2.5m0 0L5 5.5m3-3 3 3M2.5 9v4.5h11V9" /></svg>
                        <span>{instanceImportBusy ? "Importing..." : "Import"}</span>
                      </button>
                      {instanceSelectionMode ? <>
                        <button className="library-icon-action instance-selection-cancel-action" onClick={cancelInstanceSelection}>Cancel selection</button>
                        <button
                          className="library-icon-action instance-delete-selected-action"
                          onClick={() => setDeleteInstancesConfirm("warning")}
                          disabled={!selectedInstanceIds.length || busy || gameRunning || anyRunning}
                        >Delete selected ({selectedInstanceIds.length})</button>
                      </> : (
                        <button className="library-icon-action library-icon-action-expand instance-toolbar-icon instance-toolbar-delete" onClick={() => { setInstanceSelectionMode(true); setInstanceActionError(""); }}>
                          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4m2.5 0-.7 9.5H4.2L3.5 4m2.7 2v5m3.6-5v5" /></svg>
                          <span>Select to delete</span>
                        </button>
                      )}
                    </div>
                  </div>
                  {instanceActionError && <div className="err" role="alert">{instanceActionError}</div>}
                  <div className="ilist">
                    {instances.length === 0 ? (
                      <div className="instances-empty"><span className="empty-cube"><Icon n="cube" /></span>
                        <b>Your library is empty</b><p>Create an instance to start playing.</p>
                        <button className="btn purple" onClick={() => setTab("download")}>Create an instance</button></div>
                    ) : filteredInstances.length === 0 ? (
                      <div className="instances-empty instance-no-results">
                        <b>No instances found</b><p>Try another name, Minecraft version, or loader.</p>
                      </div>
                    ) : filteredInstances.map((i, index) => (
                      <InstanceRowBackground
                        key={i.id}
                        instance={i}
                        className={(i.id === instId ? "on " : "") + (selectedInstanceIds.includes(i.id) ? "is-delete-selected " : "") + (instancesRefreshing ? "is-refreshing" : "")}
                        onBackgroundError={(message) => add(message)}
                      >
                        <button
                          className="instance-row-main"
                          onClick={() => setInstId(i.id)}
                          aria-pressed={i.id === instId}
                          title={`Set ${i.name} as the active instance`}
                        >
                          <span className="instance-row-icon"><InstIcon inst={i} size={38} /></span>
                          <span className="instance-row-info">
                            <b>{i.name}</b>
                            <span className="instance-row-meta">
                              <span>{cap(i.loader)}</span><i />
                              <span>Minecraft {i.mc}</span>
                              {i.version_id !== i.mc && <><i /><span>{i.version_id}</span></>}
                            </span>
                            {i.description && <span className="instance-row-description">{i.description}</span>}
                          </span>
                        </button>
                        <span className="instance-row-status">
                          {i.id === instId
                            ? <span className="instance-active"><i />Active</span>
                            : <button className="mini select-instance" onClick={() => setInstId(i.id)}>Set active</button>}
                        </span>
                        <div className="instance-row-actions">
                          {instanceSelectionMode ? (
                            <button
                              type="button"
                              className={"instance-select-button" + (selectedInstanceIds.includes(i.id) ? " selected" : "")}
                              aria-pressed={selectedInstanceIds.includes(i.id)}
                              aria-label={`${selectedInstanceIds.includes(i.id) ? "Deselect" : "Select"} ${i.name} for deletion`}
                              onClick={() => toggleInstanceSelection(i.id)}
                              disabled={busy || gameRunning || anyRunning}
                            >
                              <span className="instance-select-indicator" aria-hidden="true">{selectedInstanceIds.includes(i.id) ? "✓" : ""}</span>
                            </button>
                          ) : <>
                            <button className="library-icon-action instance-content-action" aria-label={`Open content for ${i.name}`} title="Open instance content" onClick={() => {
                              setTab("instances");
                              setPage("versions");
                              setContentInst(i);
                            }}>
                              <img src={INSTANCE_EDIT_ICON} alt="" />
                            </button>
                          </>}
                        </div>
                      </InstanceRowBackground>
                    ))}
                  </div>
                </>
              )}
            </section>
            )
          )}

          {page === "console" && (
            <section className="panel full console-page">
              <header className="page-heading">
                <div><span className="eyebrow">LIVE OUTPUT</span><h2>Console</h2>
                  <p>Minecraft output from the current game session.</p></div>
                <div className="console-heading-actions">
                  <span className="count-chip">{log.length} {log.length === 1 ? "entry" : "entries"}</span>
                  <button className="mini" onClick={() => setLog([])} disabled={log.length === 0}>Clear log</button>
                </div>
              </header>
              <div className="console-toolbar"><span className={"console-indicator" + (busy ? " active" : "")} />
                <b>Minecraft process output</b><span className="console-session">GAME LOG</span></div>
              <div className="log" ref={logRef} role="log" aria-live="polite" aria-label="Minecraft process output">
                {log.length === 0
                  ? <div className="console-empty"><span>›_</span><b>No game output yet</b><p>Minecraft process logs will appear here.</p></div>
                  : log.map((l, i) => <div key={i} className={"log-line" + (/error|failed|could not/i.test(l) ? " error" : "")}>
                    <span className="log-index">{String(i + 1).padStart(3, "0")}</span><span>{l}</span>
                  </div>)}
              </div>
            </section>
          )}
          {page === "settings" && (
            <section className="panel settings-page">
              <div className="settings-layout">
                <aside className="settings-sidebar">
                  <div className="settings-sidebar-heading">
                    <span className="eyebrow">PREFERENCES</span>
                    <h2>Settings</h2>
                  </div>
                  <nav className="settings-nav" aria-label="Settings categories" role="tablist" aria-orientation="vertical">
                    <button
                      id="settings-tab-game"
                      className={activeSettingsTab === "game" ? "active" : ""}
                      role="tab"
                      aria-selected={activeSettingsTab === "game"}
                      aria-controls="settings-panel-game"
                      onClick={() => setActiveSettingsTab("game")}
                    >Game Settings</button>
                    <button
                      id="settings-tab-launcher"
                      className={activeSettingsTab === "launcher" ? "active" : ""}
                      role="tab"
                      aria-selected={activeSettingsTab === "launcher"}
                      aria-controls="settings-panel-launcher"
                      onClick={() => setActiveSettingsTab("launcher")}
                    >Launcher Settings</button>
                  </nav>
                  <p className="settings-sidebar-note">Changes are saved automatically.</p>
                </aside>
                <div className="settings-content">
                  <header className="page-heading settings-heading">
                    <div><span className="eyebrow">ARCA LAUNCHER</span>
                      <h2>{activeSettingsTab === "game" ? "Game Settings" : "Launcher Settings"}</h2>
                      <p>{activeSettingsTab === "game"
                        ? "Configure Minecraft runtime, memory, and versions."
                        : "Customize the launcher interface, themes, and updates."}</p>
                    </div>
                  </header>
                  <div className="settings-groups">
                {activeSettingsTab === "game" && <div className="settings-group" id="settings-panel-game" role="tabpanel" aria-labelledby="settings-tab-game">
                  <div className="settings-grid">
                    <section className="setting-card" id="settings-game-java">
                      <div className="setting-title"><span className="setting-icon"><Icon n="game" /></span><div><h3>Game & Java</h3><p>Runtime, launch arguments, and in-game options.</p></div></div>
                      <label>Java runtime</label>
                      <select value={st.javaRuntime} onChange={(e) => {
                        set("javaRuntime", e.target.value as Settings["javaRuntime"]);
                        setJavaRuntimeMessage("");
                      }}>
                        <option value="system">Default System - (Default)</option>
                        <option value="custom">Custom Java path</option>
                      </select>
                      {st.javaRuntime === "system" && <>
                        <p className="setting-note">Launcher automatically downloads the correct Java version for each Minecraft release.</p>
                      </>}
                      {st.javaRuntime === "custom" && <>
                        <p className="setting-note">Use Java installed on your computer. Specify the full path to java.exe below.</p>
                        <label>Custom Java path</label>
                        <input value={java} onChange={(e) => setJava(e.target.value)} placeholder="C:\Program Files\Java\jre-1.8\bin\java.exe" />
                      </>}
                      <label>JVM arguments</label>
                      <input placeholder="-XX:+UseG1GC -XX:MaxGCPauseMillis=50" value={st.jvmArgs} onChange={(e) => set("jvmArgs", e.target.value)} />
                      <label>Game arguments</label>
                      <input placeholder="--fullscreen" value={st.gameArgs} onChange={(e) => set("gameArgs", e.target.value)} />
                      <label className="check"><input type="checkbox" checked={st.launchFullscreen} onChange={(e) => set("launchFullscreen", e.target.checked)} /> Start Minecraft in fullscreen</label>
                      <label className="check"><input type="checkbox" checked={showCrashReports} onChange={(e) => setShowCrashReports(e.target.checked)} /> Show a crash report when the game crashes</label>
                      <label className="check"><input type="checkbox" checked={st.volumeOn} onChange={(e) => set("volumeOn", e.target.checked)} /> Set game master volume on launch</label>
                      <label>Master volume <span className="field-value">{st.volume}%</span></label>
                      <input type="range" min={0} max={100} step={5} disabled={!st.volumeOn} value={st.volume} onChange={(e) => set("volume", +e.target.value)} />
                    </section>

                    <section className="setting-card" id="settings-memory">
                      <div className="setting-title"><span className="setting-icon"><Icon n="memory" /></span><div><h3>Memory</h3><p>Choose how much RAM Minecraft can use.</p></div></div>
                      <label className="check">
                        <input type="checkbox" checked={st.ramAuto} onChange={(e) => set("ramAuto", e.target.checked)} />
                        Auto ({(autoRam(sysRam, inst?.loader ?? "vanilla") / 1024).toFixed(1)} GB{sysRam ? ` of ${(sysRam / 1024).toFixed(0)} GB` : ""})
                      </label>
                      <label>Memory allocation <span className="field-value">{(effRam / 1024).toFixed(1)} GB</span></label>
                      <input type="range" disabled={st.ramAuto} min={1024} max={Math.max(2048, Math.floor((sysRam || 16384) / 512) * 512)}
                        step={512} value={ram} onChange={(e) => setRam(+e.target.value)} />
                    </section>

                    <section className="setting-card" id="settings-versions">
                      <div className="setting-title"><span className="setting-icon"><Icon n="version" /></span><div><h3>Version list</h3><p>Choose which Minecraft releases appear in the browser.</p></div></div>
                      <label className="check"><input type="checkbox" checked={st.showSnapshots} onChange={(e) => set("showSnapshots", e.target.checked)} /> Snapshots</label>
                      <label className="check"><input type="checkbox" checked={st.showExperimental} onChange={(e) => set("showExperimental", e.target.checked)} /> Experimental and special versions</label>
                      <label className="check"><input type="checkbox" checked={st.showBeta} onChange={(e) => set("showBeta", e.target.checked)} /> Old beta</label>
                      <label className="check"><input type="checkbox" checked={st.showAlpha} onChange={(e) => set("showAlpha", e.target.checked)} /> Old alpha</label>
                    </section>

                    <section className="setting-card" id="settings-instances">
                      <div className="setting-title"><span className="setting-icon"><Icon n="instances" /></span><div><h3>Instances</h3><p>Manage instance storage and installation activity.</p></div></div>
                      <label>Instance folder</label>
                      <div className="folder-picker-row">
                        <span className="folder-picker-path" title={displayPath(instanceDirectoryDraft) || "No folder selected"}>
                          {displayPath(instanceDirectoryDraft) || "No folder selected"}
                        </span>
                        <button className="mini" onClick={chooseInstanceDirectory} disabled={instanceDirectoryBusy}>Browse…</button>
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
                        <input type="checkbox" checked={st.autoClearDownloads} onChange={(e) => set("autoClearDownloads", e.target.checked)} />
                        Automatically clear completed tasks
                      </label>
                    </section>
                  </div>
                </div>}

                {activeSettingsTab === "launcher" && <div className="settings-group" id="settings-panel-launcher" role="tabpanel" aria-labelledby="settings-tab-launcher">
                  <div className="settings-grid">
                    <section className="setting-card" id="settings-interface">
                      <div className="setting-title"><span className="setting-icon"><Icon n="launcher" /></span><div><h3>Interface</h3><p>Set the launch experience and interface scale.</p></div></div>
                      <label>When the game starts</label>
                      <select value={st.hide} onChange={(e) => set("hide", e.target.value as Settings["hide"])}>
                        <option value="keep">Keep the launcher open</option>
                        <option value="hide">Hide it until the game closes</option>
                        <option value="close">Close the launcher</option>
                      </select>
                      <label>Interface size <span className="field-value">{st.uiScale}%</span></label>
                      <input type="range" min={80} max={130} step={5} value={st.uiScale} onChange={(e) => set("uiScale", +e.target.value)} />
                      <label className="check">
                        <input type="checkbox" checked={st.reduceAnimations} onChange={(e) => set("reduceAnimations", e.target.checked)} />
                        Reduce animations
                      </label>
                      <p className="setting-note">Minimizes motion effects throughout the launcher. Helpful for motion sensitivity or performance.</p>
                    </section>

                    <section className="setting-card" id="settings-themes">
                      <div className="setting-title"><span className="setting-icon"><Icon n="theme" /></span><div><h3>Theme</h3><p>Choose the look and feel of Arca Launcher.</p></div></div>
                      <label htmlFor="launcher-theme">Active theme</label>
                      <select id="launcher-theme" value={st.theme} disabled={!themesReady} onChange={(e) => {
                        if (themeCatalog.some((theme) => theme.id === e.target.value))
                          set("theme", e.target.value);
                      }}>
                        {themeCatalog.map((theme) => (
                          <option key={theme.id} value={theme.id}>{theme.name} — {theme.author}</option>
                        ))}
                      </select>
                      <p className="setting-note">Custom CSS themes go in <code>launcher/themes</code>. Remote imports and assets are supported; use themes you trust.</p>
                      <button className="mini" onClick={() => {
                        invoke<ThemeCatalog>("list_themes")
                          .then((catalog) => {
                            setThemeCatalog(catalog.themes);
                            setThemeWarnings(catalog.warnings);
                            setThemeError("");
                          })
                          .catch((e) => setThemeError(`Could not reload themes: ${e}`));
                      }}>Reload themes</button>
                      {themeWarnings.map((warning) => <p key={warning} className="setting-note">{warning}</p>)}
                      {themeError && <p className="setting-note setting-error">{themeError}</p>}
                    </section>

                    <section className="setting-card maintenance-card" id="settings-maintenance">
                      <div className="setting-title"><span className="setting-icon"><Icon n="cube" /></span><div><h3>Maintenance</h3><p>Remove launcher data. These actions cannot be undone.</p></div></div>
                      <div className="maintenance-actions">
                        <div className="maintenance-row">
                          <span><b>Delete all instances</b><small>Removes instance folders, including saves, mods, and configs.</small></span>
                          <button className="mini danger" onClick={() => { setMaintenanceMessage(""); setMaintenanceAction("delete_instances"); }}>Delete</button>
                        </div>
                        <div className="maintenance-row">
                          <span><b>Delete downloaded Java</b><small>Removes only Java runtimes managed by Arca Launcher.</small></span>
                          <button className="mini danger" onClick={() => { setMaintenanceMessage(""); setMaintenanceAction("delete_java"); }}>Delete</button>
                        </div>
                        <div className="maintenance-row">
                          <span><b>Clean accounts</b><small>Removes saved account credentials and cached skins.</small></span>
                          <button className="mini danger" onClick={() => { setMaintenanceMessage(""); setMaintenanceAction("clean_accounts"); }}>Clean</button>
                        </div>
                        <div className="maintenance-row factory-reset-row">
                          <span><b>Factory reset</b><small>Deletes instances, downloaded Java, saved accounts, and settings. Shared game assets and the launcher stay.</small></span>
                          <button className="mini danger" onClick={() => { setMaintenanceMessage(""); setMaintenanceAction("factory_reset"); }}>Reset</button>
                        </div>
                      </div>
                      {maintenanceMessage && <p className={"setting-note" + (maintenanceMessage.startsWith("Could not") ? " setting-error" : " maintenance-success")} role="status">{maintenanceMessage}</p>}
                    </section>

                    <section className="setting-card update-setting-card" id="settings-updates">
                      <div className="setting-title"><span className="setting-icon"><Icon n="launcher" /></span><div><h3>Launcher updates</h3><p>Check automatically on startup, then choose when to download and install.</p></div></div>
                      <p className={"setting-note" + (launcherUpdate?.update_available ? " update-available" : "")}>
                        {updateCheckBusy
                          ? "Checking for the latest signed release..."
                          : updateCheckError
                            ? updateCheckError
                            : launcherUpdate?.update_available
                              ? `Version ${launcherUpdate.latest_version} is available (you have ${launcherUpdate.current_version}).`
                              : launcherUpdate
                                ? `You’re up to date — version ${launcherUpdate.current_version}.`
                                : "Update status has not been checked yet."}
                      </p>
                      {launcherUpdate?.update_available && launcherUpdate.notes && (
                        <p className="setting-note update-notes">{launcherUpdate.notes}</p>
                      )}
                      {updateInstallBusy && (
                        <p className="setting-note" role="status">
                          {updateDownloaded ? "Installing update..." : updateProgress === null ? "Downloading update..." : `Downloading update... ${Math.round(updateProgress)}%`}
                        </p>
                      )}
                      {updateDownloaded && !updateInstallBusy && (
                        <p className="setting-note update-available" role="status">Update downloaded and signature verified. Install when you’re ready.</p>
                      )}
                      {updateInstallError && <p className="setting-note setting-error" role="alert">{updateInstallError}</p>}
                      <div className="update-actions">
                        {launcherUpdate?.update_available && !updateDownloaded && (
                          <button className="mini" onClick={() => void downloadLauncherUpdate()} disabled={updateCheckBusy || updateInstallBusy}>
                            {updateInstallBusy ? "Downloading..." : "Download update"}
                          </button>
                        )}
                        {updateDownloaded && (
                          <button className="mini" onClick={() => void installLauncherUpdate()} disabled={updateInstallBusy}>
                            {updateInstallBusy ? "Installing..." : "Install and restart"}
                          </button>
                        )}
                        <button className="mini" onClick={() => void checkLauncherUpdate()} disabled={updateCheckBusy || updateInstallBusy || updateDownloaded}>
                          {updateCheckBusy ? "Checking..." : "Check for updates"}
                        </button>
                      </div>
                    </section>

                  </div>
                </div>}

              </div>
                </div>
              </div>
            </section>
          )}
          </div>

          <div className={"pagewrap " + (fade === "out" ? "out" : "in") + (page === "mods" ? "" : " hidden")}>
            <ModsPage
              inst={inst}
              java={java}
              javaMode={st.javaRuntime}
              showSnapshots={st.showSnapshots}
              showExperimental={st.showExperimental}
              showBeta={st.showBeta}
              showAlpha={st.showAlpha}
              active={page === "mods"}
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

      {maintenanceAction && (
        <Modal
          title={MAINTENANCE_DETAILS[maintenanceAction].title}
          compact
          hideClose
          onClose={() => { if (!maintenanceBusy) setMaintenanceAction(null); }}
        >
          <div className="maintenance-confirm">
            <p>{MAINTENANCE_DETAILS[maintenanceAction].description}</p>
            {maintenanceMessage.startsWith("Could not") && (
              <p className="setting-error" role="alert">{maintenanceMessage}</p>
            )}
            {(anyRunning || busy || javaRuntimeBusy || gameRunning) && (
              <p className="setting-error" role="alert">
                Finish active downloads, Java downloads, and close Minecraft before running maintenance.
              </p>
            )}
            <footer className="btnrow">
              <button className="mini" onClick={() => setMaintenanceAction(null)} disabled={maintenanceBusy}>Cancel</button>
              <button
                className="mini danger"
                onClick={() => void runMaintenanceAction()}
                disabled={maintenanceBusy || anyRunning || busy || javaRuntimeBusy || gameRunning}
              >
                {maintenanceBusy ? "Working..." : maintenanceAction === "factory_reset" ? "Reset everything" : "Confirm"}
              </button>
            </footer>
          </div>
        </Modal>
      )}

      {backgroundPickerOpen && (
        <Modal title="Choose instance background" wide compact overlayClassName="background-picker-overlay" onClose={() => {
          setBackgroundPickerOpen(false);
          setShowLauncherBackgrounds(false);
        }}>
          {showLauncherBackgrounds ? (
            <>
              <div className="background-picker-subhead">
                <button className="mini" onClick={() => { setShowLauncherBackgrounds(false); setBackgroundPickerError(""); }}>← Back</button>
                <p>Choose a background from Arca Launcher.</p>
              </div>
              <div className="background-gallery">
                {LAUNCHER_BACKGROUNDS.map((background) => (
                  <button key={background.name} className="background-choice" onClick={() => { void chooseLauncherBackground(background.src); }}>
                    <img src={background.src} alt="" />
                    <span>{background.name}</span>
                  </button>
                ))}
              </div>
              {backgroundPickerError && <div className="err">{backgroundPickerError}</div>}
            </>
          ) : (
            <>
              <p className="hint background-picker-hint">Choose how you want to set this instance's background.</p>
              <div className="background-source-list">
                <button className="background-source" onClick={() => {
                  if (backgroundPickerTarget === "new") setWBg("");
                  else setEditBg("");
                  setBackgroundPickerOpen(false);
                }}>
                  <span className="background-source-preview none">Aa</span>
                  <span><b>None</b><small>Use the launcher's default background.</small></span>
                </button>
                <button className="background-source" onClick={() => { setShowLauncherBackgrounds(true); setBackgroundPickerError(""); }}>
                  <span className="background-source-preview"><img src={LAUNCHER_BACKGROUNDS[0].src} alt="" /></span>
                  <span><b>Library</b><small>Choose from built-in backgrounds.</small></span>
                </button>
                <button className="background-source" onClick={() => {
                  setBackgroundPickerOpen(false);
                  pickFile(backgroundPickerTarget === "new" ? "bg-new" : "bg-edit");
                }}>
                  <span className="background-source-preview upload">＋</span>
                  <span><b>Custom </b><small>Choose a PNG, JPEG, or GIF from your device.</small></span>
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {deleteInstancesConfirm && (
        <Modal
          title={deleteInstancesConfirm === "warning" ? "Review instance deletion" : "Confirm permanent deletion"}
          compact
          hideClose
          overlayClassName="delete-confirm-overlay"
          onClose={() => { if (!deleteInstancesBusy) setDeleteInstancesConfirm(null); }}
        >
          <div className="delete-instances-confirm">
            {deleteInstancesConfirm === "warning" ? (
              <>
                <p className="delete-instances-warning">
                  You selected <b>{selectedInstanceIds.length}</b> instance{selectedInstanceIds.length === 1 ? "" : "s"}.
                  Deleting them will permanently remove their folders, including worlds, mods, resource packs, and settings.
                </p>
                <p>This cannot be undone. Continue to the final confirmation?</p>
                {instanceActionError && <p className="setting-error" role="alert">{instanceActionError}</p>}
                <footer className="btnrow editdialogfooter delete-confirm-actions">
                  <button className="mini" onClick={() => setDeleteInstancesConfirm(null)}>Cancel</button>
                  <button
                    className="mini danger"
                    disabled={deleteInstancesBusy || !selectedInstanceIds.length}
                    onClick={() => { setInstanceActionError(""); setDeleteInstancesConfirm("confirm"); }}
                  >Continue</button>
                </footer>
              </>
            ) : (
              <>
                <p className="delete-instances-warning">
                  Final check: permanently delete <b>{selectedInstanceIds.length}</b> selected instance{selectedInstanceIds.length === 1 ? "" : "s"} and all their files?
                </p>
                <div className="delete-instances-list">
                  {instances.filter((instance) => selectedInstanceIds.includes(instance.id)).map((instance) => (
                    <span key={instance.id}>{instance.name}</span>
                  ))}
                </div>
                {instanceActionError && <p className="setting-error" role="alert">{instanceActionError}</p>}
                <footer className="btnrow editdialogfooter delete-confirm-actions">
                  <button className="mini" onClick={() => setDeleteInstancesConfirm("warning")} disabled={deleteInstancesBusy}>Go back</button>
                  <button className="mini danger" onClick={() => void removeSelectedInstances()} disabled={deleteInstancesBusy}>
                    {deleteInstancesBusy ? "Deleting..." : "Permanently delete"}
                  </button>
                </footer>
              </>
            )}
          </div>
        </Modal>
      )}

      {importArchivePath && (
        <Modal
          title="Import archive without instance metadata"
          compact
          onClose={() => { if (!instanceImportBusy) setImportArchivePath(null); }}
        >
          <form onSubmit={(event) => {
            event.preventDefault();
            void importZipArchive(importArchivePath, { name: importName, loader: importLoader, mc: importMc });
          }}>
            <p className="setting-error" role="alert">
              This ZIP does not contain <code>instances.json</code>. Set up the instance details to import its files.
            </p>
            <label>Instance name</label>
            <input value={importName} onChange={(event) => setImportName(event.target.value)} maxLength={120} required />
            <label>Minecraft version</label>
            <input value={importMc} onChange={(event) => setImportMc(event.target.value)} placeholder="e.g. 1.21.1" maxLength={64} required />
            <label>Mod loader</label>
            <select value={importLoader} onChange={(event) => setImportLoader(event.target.value)}>
              <option value="vanilla">Vanilla</option>
              <option value="fabric">Fabric</option>
              <option value="forge">Forge</option>
              <option value="neoforge">NeoForge</option>
              <option value="quilt">Quilt</option>
            </select>
            {instanceActionError && <p className="setting-error" role="alert">{instanceActionError}</p>}
            <footer className="btnrow editdialogfooter">
              <button className="mini" type="button" onClick={() => setImportArchivePath(null)} disabled={instanceImportBusy}>Cancel</button>
              <button className="btn purple addbtn" type="submit" disabled={instanceImportBusy || !importName.trim() || !importMc.trim()}>
                {instanceImportBusy ? "Importing..." : "Import instance"}
              </button>
            </footer>
          </form>
        </Modal>
      )}

      {editId && createPortal(
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
                  onChange={(e) => setEditDesc(Array.from(e.target.value).slice(0, 1200).join(""))}
                  placeholder="What's this instance for?"
                />
                <span className="description-counter">{Array.from(editDesc).length}/1200</span>
              </div>

              <div className="editfield">
                <label>Background <span className="editoptional">Image or GIF</span></label>
                <div className="editassetrow editbackgroundrow">
                  {editBg
                    ? <BgPreview className="bgpreview editbgpreview" src={editBg} />
                    : <div className="bgpreview ph editbgpreview"><span>No background selected</span></div>}
                  <div className="editassetactions">
                    <button className="mini" type="button" onClick={() => {
                      setBackgroundPickerTarget("edit");
                      setBackgroundPickerError("");
                      setShowLauncherBackgrounds(false);
                      setBackgroundPickerOpen(true);
                    }}>Choose background...</button>
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
        </div>,
        getPortalRoot(),
      )}

      <DownloadsFloat />
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