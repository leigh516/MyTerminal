import React, { useState, useEffect, useCallback } from "react";
import {
  Palette, X, RotateCcw, ChevronRight,
  Paintbrush, ImageIcon, Smile, Check, Upload
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

// ─── Types ────────────────────────────────────────────────────────────────────
export interface CustomTheme {
  colors: Record<string, string>;   // CSS var name → "r g b" string
  icons: Record<string, string>;    // icon key → emoji string
  background: {
    type: "solid" | "gradient" | "image";
    color: string;
    opacity: number;
    gradient: { from: string; to: string; direction: string };
    image: { path: string; dataUrl: string; blur: number; size: "cover" | "contain" | "tile"; opacity: number };
  };
}

interface ThemeEditorProps {
  isOpen: boolean;
  onClose: () => void;
  currentBaseTheme: string;
}

// ─── Preset base-theme palettes (mirrors index.css) ───────────────────────────
const BASE_PRESETS: Record<string, Record<string, string>> = {
  dark:    { bgBase:"11 15 25",bgSurface:"17 24 39",bgPanel:"31 41 55",border:"255 255 255",textMain:"243 244 246",textMuted:"156 163 175",primary:"99 102 241",primaryLight:"129 140 248",accent:"16 185 129",error:"239 68 68" },
  light:   { bgBase:"248 250 252",bgSurface:"255 255 255",bgPanel:"241 245 249",border:"0 0 0",textMain:"15 23 42",textMuted:"100 116 139",primary:"79 70 229",primaryLight:"99 102 241",accent:"13 148 136",error:"225 29 72" },
  dracula: { bgBase:"30 31 41",bgSurface:"40 42 54",bgPanel:"68 71 90",border:"255 255 255",textMain:"248 248 242",textMuted:"98 114 164",primary:"189 147 249",primaryLight:"255 121 198",accent:"80 250 123",error:"255 85 85" },
  monokai: { bgBase:"39 40 34",bgSurface:"30 31 28",bgPanel:"62 61 50",border:"255 255 255",textMain:"248 248 242",textMuted:"117 113 94",primary:"249 38 114",primaryLight:"102 217 239",accent:"166 226 70",error:"249 38 114" },
  gruvbox: { bgBase:"29 32 33",bgSurface:"40 40 40",bgPanel:"60 56 54",border:"255 255 255",textMain:"251 241 199",textMuted:"168 153 132",primary:"254 128 25",primaryLight:"250 189 47",accent:"184 187 38",error:"251 73 52" },
  hacker:  { bgBase:"13 17 23",bgSurface:"22 27 34",bgPanel:"33 38 45",border:"255 255 255",textMain:"201 209 217",textMuted:"139 148 158",primary:"88 166 255",primaryLight:"31 111 235",accent:"63 185 80",error:"248 81 73" },
  oceanic: { bgBase:"46 52 64",bgSurface:"59 66 82",bgPanel:"67 76 94",border:"255 255 255",textMain:"236 239 244",textMuted:"216 222 233",primary:"136 192 208",primaryLight:"143 188 187",accent:"163 190 140",error:"191 97 106" },
};

// ─── Color variable definitions ───────────────────────────────────────────────
const COLOR_VARS = [
  { key: "bgBase",         label: "기본 배경",          cssVar: "--color-bg-base",        group: "배경" },
  { key: "bgSurface",      label: "패널 배경",          cssVar: "--color-bg-surface",     group: "배경" },
  { key: "bgPanel",        label: "입력창/드롭다운",    cssVar: "--color-bg-panel",       group: "배경" },
  { key: "textMain",       label: "기본 텍스트",         cssVar: "--color-text-main",      group: "텍스트" },
  { key: "textMuted",      label: "보조 텍스트",         cssVar: "--color-text-muted",     group: "텍스트" },
  { key: "primary",        label: "강조색(Primary)",    cssVar: "--color-primary",        group: "강조색" },
  { key: "primaryLight",   label: "강조색(Hover)",      cssVar: "--color-primary-light",  group: "강조색" },
  { key: "accent",         label: "액센트(SSH/Success)","cssVar": "--color-accent",       group: "강조색" },
  { key: "error",          label: "에러색",              cssVar: "--color-error",          group: "강조색" },
  { key: "border",         label: "구분선(기준)",        cssVar: "--color-border",         group: "기타" },
  { key: "explorerFolder", label: "탐색기 폴더색",       cssVar: "--color-explorer-folder",group: "탐색기" },
  { key: "explorerSSH",    label: "탐색기 SSH폴더색",   cssVar: "--color-explorer-ssh",   group: "탐색기" },
  { key: "explorerSelect", label: "탐색기 선택 바",      cssVar: "--color-explorer-select",group: "탐색기" },
  { key: "explorerFile",   label: "탐색기 파일색",       cssVar: "--color-explorer-file",  group: "탐색기" },
  { key: "tabActive",      label: "탭 활성 배경",        cssVar: "--color-tab-active",     group: "탭" },
  { key: "tabText",        label: "탭 텍스트",           cssVar: "--color-tab-text",       group: "탭" },
];

// ─── Icon definitions ─────────────────────────────────────────────────────────
const ICON_DEFS = [
  { key: "localFolder",  label: "로컬 폴더",        default: "📁" },
  { key: "localFile",    label: "로컬 파일",        default: "📄" },
  { key: "sshFolder",    label: "SSH 폴더",         default: "🌐" },
  { key: "sshFile",      label: "SSH 파일",         default: "📝" },
  { key: "aiPanel",      label: "AI 패널 아이콘",   default: "✨" },
  { key: "terminalTab",  label: "터미널 탭",        default: "💻" },
  { key: "sshTab",       label: "SSH 탭",           default: "🔗" },
  { key: "editorTab",    label: "에디터 탭",        default: "📝" },
  { key: "localExplorer",label: "로컬 탐색기",      default: "💻" },
  { key: "sshExplorer",  label: "SSH 탐색기",       default: "🌐" },
];

const GRADIENT_DIRECTIONS = [
  { value: "to bottom",       label: "↓ 아래" },
  { value: "to right",        label: "→ 오른쪽" },
  { value: "135deg",          label: "↘ 대각선" },
  { value: "to top",          label: "↑ 위" },
  { value: "to top right",    label: "↗ 우상단" },
  { value: "to bottom right", label: "↘ 우하단" },
];

// ─── Default custom theme ─────────────────────────────────────────────────────
const DEFAULT_CUSTOM: CustomTheme = {
  colors: {
    explorerFolder: "129 140 248",
    explorerSSH:    "16 185 129",
    explorerSelect: "99 102 241",
    explorerFile:   "156 163 175",
    tabActive:      "99 102 241",
    tabText:        "243 244 246",
  },
  icons: Object.fromEntries(ICON_DEFS.map(d => [d.key, d.default])),
  background: {
    type: "solid",
    color: "#0b0f19",
    opacity: 100,
    gradient: { from: "#0b0f19", to: "#1a1f35", direction: "135deg" },
    image: { path: "", dataUrl: "", blur: 0, size: "cover", opacity: 30 },
  },
};

const STORAGE_KEY = "terminal_avy_custom_theme";

// ─── Helper: rgb string "r g b" ↔ hex "#rrggbb" ──────────────────────────────
function rgbToHex(rgb: string): string {
  const parts = rgb.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return "#888888";
  return "#" + parts.map(v => v.toString(16).padStart(2, "0")).join("");
}

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r} ${g} ${b}`;
}

// ─── Apply CSS variables globally ────────────────────────────────────────────
function applyCssVars(colors: Record<string, string>, baseTheme: string) {
  const el = document.documentElement;
  const base = BASE_PRESETS[baseTheme] || BASE_PRESETS.dark;

  // Apply base preset first (from index.css data-theme attribute handles these,
  // but we also apply them here so custom overrides layer on top)
  COLOR_VARS.forEach(({ key, cssVar }) => {
    const val = colors[key] ?? base[key];
    if (val) el.style.setProperty(cssVar, val);
  });
}

// ─── Apply background ─────────────────────────────────────────────────────────
function applyBackground(bg: CustomTheme["background"]) {
  const root = document.documentElement;
  if (bg.type === "solid") {
    root.style.setProperty("--custom-bg", `rgba(${hexToRgb(bg.color)},${bg.opacity / 100})`);
    root.style.setProperty("--custom-bg-image", "none");
    root.style.setProperty("--custom-bg-blur", "0px");
  } else if (bg.type === "gradient") {
    root.style.setProperty("--custom-bg", `linear-gradient(${bg.gradient.direction},${bg.gradient.from},${bg.gradient.to})`);
    root.style.setProperty("--custom-bg-image", "none");
    root.style.setProperty("--custom-bg-blur", "0px");
  } else if (bg.type === "image" && bg.image.dataUrl) {
    root.style.setProperty("--custom-bg", `rgba(0,0,0,${(100 - bg.image.opacity) / 100})`);
    root.style.setProperty("--custom-bg-image", `url("${bg.image.dataUrl}")`);
    root.style.setProperty("--custom-bg-size", bg.image.size === "tile" ? "auto" : bg.image.size);
    root.style.setProperty("--custom-bg-repeat", bg.image.size === "tile" ? "repeat" : "no-repeat");
    root.style.setProperty("--custom-bg-blur", `${bg.image.blur}px`);
  } else {
    root.style.setProperty("--custom-bg", "");
    root.style.setProperty("--custom-bg-image", "none");
    root.style.setProperty("--custom-bg-blur", "0px");
  }
}

// ─── Expose icon context globally so other components can read it ─────────────
export function getCustomIcon(key: string): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed: CustomTheme = JSON.parse(saved);
      return parsed.icons?.[key] ?? DEFAULT_CUSTOM.icons[key] ?? "";
    }
  } catch {}
  return DEFAULT_CUSTOM.icons[key] ?? "";
}

// ─── Main Component ───────────────────────────────────────────────────────────
export const ThemeEditor: React.FC<ThemeEditorProps> = ({ isOpen, onClose, currentBaseTheme }) => {
  const [tab, setTab] = useState<"colors" | "icons" | "background">("colors");
  const [theme, setThemeState] = useState<CustomTheme>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return { ...DEFAULT_CUSTOM, ...JSON.parse(saved) };
    } catch {}
    return { ...DEFAULT_CUSTOM };
  });
  const [saved, setSaved] = useState(false);
  const [colorGroup, setColorGroup] = useState<string>("배경");

  // Persist & apply whenever theme changes
  const persist = useCallback((t: CustomTheme) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
    applyCssVars(t.colors, currentBaseTheme);
    applyBackground(t.background);
    // Dispatch event so other components can react
    window.dispatchEvent(new CustomEvent("custom_theme_changed", { detail: t }));
  }, [currentBaseTheme]);

  // Apply on mount
  useEffect(() => {
    persist(theme);
  }, [currentBaseTheme]);

  const update = (newTheme: CustomTheme) => {
    setThemeState(newTheme);
    persist(newTheme);
  };

  const handleSave = () => {
    persist(theme);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const handleReset = () => {
    if (!window.confirm("모든 커스텀 설정을 초기화하시겠습니까?")) return;
    const reset = { ...DEFAULT_CUSTOM };
    update(reset);
  };

  const setColor = (key: string, hex: string) => {
    update({ ...theme, colors: { ...theme.colors, [key]: hexToRgb(hex) } });
  };

  const setIcon = (key: string, val: string) => {
    update({ ...theme, icons: { ...theme.icons, [key]: val } });
  };

  const setBg = (patch: Partial<CustomTheme["background"]>) => {
    update({ ...theme, background: { ...theme.background, ...patch } });
  };

  const handleSelectBgImage = async () => {
    try {
      const filePath = await open({
        multiple: false,
        filters: [{ name: "이미지", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"] }]
      });
      if (!filePath || Array.isArray(filePath)) return;
      // Read file as base64 via Tauri
      const base64: string = await invoke("read_file_base64", { path: filePath });
      const ext = (filePath as string).split(".").pop()?.toLowerCase() || "png";
      const mime = ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`;
      const dataUrl = `data:${mime};base64,${base64}`;
      update({
        ...theme,
        background: {
          ...theme.background,
          type: "image",
          image: { ...theme.background.image, path: filePath as string, dataUrl }
        }
      });
    } catch (e) {
      console.error("이미지 선택 실패:", e);
    }
  };

  const colorGroups = [...new Set(COLOR_VARS.map(v => v.group))];
  const filteredVars = COLOR_VARS.filter(v => v.group === colorGroup);
  const base = BASE_PRESETS[currentBaseTheme] || BASE_PRESETS.dark;

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className="fixed right-0 top-0 h-full z-50 flex flex-col shadow-2xl"
        style={{
          width: 360,
          background: "rgb(var(--color-bg-surface, 17 24 39))",
          borderLeft: "1px solid rgba(var(--color-border, 255 255 255),0.08)",
          fontFamily: "inherit",
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 16px 12px",
          borderBottom: "1px solid rgba(var(--color-border,255 255 255),0.08)",
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Palette size={16} style={{ color: "rgb(var(--color-primary,99 102 241))" }} />
            <span style={{ fontWeight: 700, fontSize: 14, color: "rgb(var(--color-text-main,243 244 246))" }}>
              테마 편집기
            </span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={handleReset}
              title="초기화"
              style={{
                padding: "4px 8px", borderRadius: 6, background: "rgba(239,68,68,0.12)",
                border: "1px solid rgba(239,68,68,0.25)", color: "#f87171",
                fontSize: 11, fontWeight: 600, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 4,
              }}
            >
              <RotateCcw size={11} /> 초기화
            </button>
            <button
              onClick={handleSave}
              style={{
                padding: "4px 10px", borderRadius: 6,
                background: saved ? "rgba(34,197,94,0.2)" : "rgba(var(--color-primary,99 102 241),0.8)",
                border: `1px solid ${saved ? "rgba(34,197,94,0.4)" : "rgba(var(--color-primary,99 102 241),0.5)"}`,
                color: saved ? "#4ade80" : "#fff",
                fontSize: 11, fontWeight: 600, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 4,
                transition: "all 0.2s",
              }}
            >
              {saved ? <><Check size={11} /> 저장됨</> : <>저장</>}
            </button>
            <button onClick={onClose} style={{ padding: 4, color: "rgb(var(--color-text-muted,156 163 175))", cursor: "pointer", background: "transparent", border: "none" }}>
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{
          display: "flex", gap: 0, padding: "8px 12px 0",
          borderBottom: "1px solid rgba(var(--color-border,255 255 255),0.06)",
          flexShrink: 0,
        }}>
          {([
            { id: "colors",     label: "색상",   Icon: Paintbrush },
            { id: "icons",      label: "아이콘", Icon: Smile },
            { id: "background", label: "배경",   Icon: ImageIcon },
          ] as const).map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "6px 14px", fontSize: 12, fontWeight: 600,
                borderBottom: tab === id
                  ? "2px solid rgb(var(--color-primary,99 102 241))"
                  : "2px solid transparent",
                color: tab === id
                  ? "rgb(var(--color-primary,99 102 241))"
                  : "rgb(var(--color-text-muted,156 163 175))",
                background: "transparent", border: "none",
                cursor: "pointer", transition: "color 0.15s",
              }}
            >
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px 20px" }} className="custom-scrollbar">

          {/* ── 색상 탭 ─────────────────────────────────────────── */}
          {tab === "colors" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {/* Group selector */}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {colorGroups.map(g => (
                  <button
                    key={g}
                    onClick={() => setColorGroup(g)}
                    style={{
                      padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600,
                      cursor: "pointer", transition: "all 0.15s",
                      background: colorGroup === g
                        ? "rgba(var(--color-primary,99 102 241),0.25)"
                        : "rgba(var(--color-border,255 255 255),0.05)",
                      border: colorGroup === g
                        ? "1px solid rgba(var(--color-primary,99 102 241),0.5)"
                        : "1px solid rgba(var(--color-border,255 255 255),0.1)",
                      color: colorGroup === g
                        ? "rgb(var(--color-primary,99 102 241))"
                        : "rgb(var(--color-text-muted,156 163 175))",
                    }}
                  >
                    {g}
                  </button>
                ))}
              </div>

              {/* Color pickers */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {filteredVars.map(({ key, label, cssVar }) => {
                  const currentRgb = theme.colors[key] ?? base[key] ?? "128 128 128";
                  const hex = rgbToHex(currentRgb);
                  const isCustom = !!theme.colors[key];
                  return (
                    <div key={key} style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "8px 10px", borderRadius: 8,
                      background: "rgba(var(--color-border,255 255 255),0.04)",
                      border: "1px solid rgba(var(--color-border,255 255 255),0.07)",
                    }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "rgb(var(--color-text-main,243 244 246))", marginBottom: 2 }}>
                          {label}
                        </div>
                        <div style={{ fontSize: 10, color: "rgb(var(--color-text-muted,156 163 175))", fontFamily: "monospace" }}>
                          {cssVar}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {isCustom && (
                          <button
                            onClick={() => {
                              const next = { ...theme.colors };
                              delete next[key];
                              update({ ...theme, colors: next });
                            }}
                            title="기본값으로"
                            style={{ background: "transparent", border: "none", cursor: "pointer", color: "rgb(var(--color-text-muted,156 163 175))", padding: 2 }}
                          >
                            <RotateCcw size={10} />
                          </button>
                        )}
                        {/* Color preview + input */}
                        <label style={{ cursor: "pointer", position: "relative", display: "flex", alignItems: "center" }}>
                          <div style={{
                            width: 32, height: 22, borderRadius: 5,
                            background: hex,
                            border: "2px solid rgba(var(--color-border,255 255 255),0.2)",
                            boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
                          }} />
                          <input
                            type="color"
                            value={hex}
                            onChange={e => setColor(key, e.target.value)}
                            style={{ position: "absolute", width: 0, height: 0, opacity: 0, pointerEvents: "none" }}
                          />
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Base preset quick-apply */}
              <div style={{ marginTop: 8, borderTop: "1px solid rgba(var(--color-border,255 255 255),0.07)", paddingTop: 12 }}>
                <div style={{ fontSize: 11, color: "rgb(var(--color-text-muted,156 163 175))", marginBottom: 8 }}>
                  프리셋에서 색상 복사
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {Object.keys(BASE_PRESETS).map(preset => (
                    <button
                      key={preset}
                      onClick={() => {
                        const p = BASE_PRESETS[preset];
                        // Copy all base colors into custom colors
                        const next = { ...theme.colors };
                        Object.keys(p).forEach(k => { next[k] = p[k]; });
                        update({ ...theme, colors: next });
                      }}
                      style={{
                        padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600,
                        cursor: "pointer",
                        background: "rgba(var(--color-border,255 255 255),0.06)",
                        border: "1px solid rgba(var(--color-border,255 255 255),0.12)",
                        color: "rgb(var(--color-text-main,243 244 246))",
                      }}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── 아이콘 탭 ─────────────────────────────────────────── */}
          {tab === "icons" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 11, color: "rgb(var(--color-text-muted,156 163 175))", marginBottom: 4 }}>
                이모지를 직접 입력하거나 클릭하여 변경하세요.
              </div>
              {ICON_DEFS.map(({ key, label, default: def }) => (
                <div key={key} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "8px 10px", borderRadius: 8,
                  background: "rgba(var(--color-border,255 255 255),0.04)",
                  border: "1px solid rgba(var(--color-border,255 255 255),0.07)",
                }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "rgb(var(--color-text-main,243 244 246))" }}>{label}</div>
                    <div style={{ fontSize: 10, color: "rgb(var(--color-text-muted,156 163 175))", fontFamily: "monospace" }}>기본값: {def}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {theme.icons[key] !== def && (
                      <button
                        onClick={() => setIcon(key, def)}
                        title="기본값으로"
                        style={{ background: "transparent", border: "none", cursor: "pointer", color: "rgb(var(--color-text-muted,156 163 175))", padding: 2 }}
                      >
                        <RotateCcw size={10} />
                      </button>
                    )}
                    <input
                      type="text"
                      value={theme.icons[key] ?? def}
                      onChange={e => setIcon(key, e.target.value)}
                      style={{
                        width: 52, height: 34, textAlign: "center", fontSize: 20,
                        background: "rgba(var(--color-border,255 255 255),0.08)",
                        border: "1px solid rgba(var(--color-border,255 255 255),0.15)",
                        borderRadius: 8, color: "rgb(var(--color-text-main,243 244 246))",
                        outline: "none", cursor: "text",
                      }}
                      maxLength={4}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── 배경 탭 ─────────────────────────────────────────── */}
          {tab === "background" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Type selector */}
              <div>
                <div style={{ fontSize: 11, color: "rgb(var(--color-text-muted,156 163 175))", marginBottom: 8 }}>배경 유형</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {(["solid", "gradient", "image"] as const).map(t => (
                    <button
                      key={t}
                      onClick={() => setBg({ type: t })}
                      style={{
                        flex: 1, padding: "6px 0", borderRadius: 8, fontSize: 12, fontWeight: 600,
                        cursor: "pointer", transition: "all 0.15s",
                        background: theme.background.type === t
                          ? "rgba(var(--color-primary,99 102 241),0.25)"
                          : "rgba(var(--color-border,255 255 255),0.05)",
                        border: theme.background.type === t
                          ? "1px solid rgba(var(--color-primary,99 102 241),0.5)"
                          : "1px solid rgba(var(--color-border,255 255 255),0.1)",
                        color: theme.background.type === t
                          ? "rgb(var(--color-primary,99 102 241))"
                          : "rgb(var(--color-text-muted,156 163 175))",
                      }}
                    >
                      {t === "solid" ? "단색" : t === "gradient" ? "그라디언트" : "이미지"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Solid */}
              {theme.background.type === "solid" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12, color: "rgb(var(--color-text-main,243 244 246))" }}>배경 색상</span>
                    <label style={{ cursor: "pointer" }}>
                      <div style={{ width: 40, height: 26, borderRadius: 6, background: theme.background.color, border: "2px solid rgba(var(--color-border,255 255 255),0.2)" }} />
                      <input type="color" value={theme.background.color} onChange={e => setBg({ color: e.target.value })} style={{ position: "absolute", opacity: 0, width: 0, height: 0 }} />
                    </label>
                  </div>
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: "rgb(var(--color-text-main,243 244 246))" }}>불투명도</span>
                      <span style={{ fontSize: 11, color: "rgb(var(--color-text-muted,156 163 175))" }}>{theme.background.opacity}%</span>
                    </div>
                    <input type="range" min={0} max={100} value={theme.background.opacity}
                      onChange={e => setBg({ opacity: Number(e.target.value) })}
                      style={{ width: "100%", accentColor: "rgb(var(--color-primary,99 102 241))" }} />
                  </div>
                </div>
              )}

              {/* Gradient */}
              {theme.background.type === "gradient" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 11, color: "rgb(var(--color-text-muted,156 163 175))", marginBottom: 5 }}>시작 색상</div>
                      <label style={{ cursor: "pointer", display: "block" }}>
                        <div style={{ height: 28, borderRadius: 6, background: theme.background.gradient.from, border: "2px solid rgba(var(--color-border,255 255 255),0.2)" }} />
                        <input type="color" value={theme.background.gradient.from}
                          onChange={e => setBg({ gradient: { ...theme.background.gradient, from: e.target.value } })}
                          style={{ position: "absolute", opacity: 0, width: 0, height: 0 }} />
                      </label>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 11, color: "rgb(var(--color-text-muted,156 163 175))", marginBottom: 5 }}>끝 색상</div>
                      <label style={{ cursor: "pointer", display: "block" }}>
                        <div style={{ height: 28, borderRadius: 6, background: theme.background.gradient.to, border: "2px solid rgba(var(--color-border,255 255 255),0.2)" }} />
                        <input type="color" value={theme.background.gradient.to}
                          onChange={e => setBg({ gradient: { ...theme.background.gradient, to: e.target.value } })}
                          style={{ position: "absolute", opacity: 0, width: 0, height: 0 }} />
                      </label>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: "rgb(var(--color-text-muted,156 163 175))", marginBottom: 5 }}>방향</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                      {GRADIENT_DIRECTIONS.map(({ value, label }) => (
                        <button key={value} onClick={() => setBg({ gradient: { ...theme.background.gradient, direction: value } })}
                          style={{
                            padding: "3px 8px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                            cursor: "pointer",
                            background: theme.background.gradient.direction === value
                              ? "rgba(var(--color-primary,99 102 241),0.25)"
                              : "rgba(var(--color-border,255 255 255),0.06)",
                            border: theme.background.gradient.direction === value
                              ? "1px solid rgba(var(--color-primary,99 102 241),0.5)"
                              : "1px solid rgba(var(--color-border,255 255 255),0.1)",
                            color: theme.background.gradient.direction === value
                              ? "rgb(var(--color-primary,99 102 241))"
                              : "rgb(var(--color-text-main,243 244 246))",
                          }}
                        >{label}</button>
                      ))}
                    </div>
                  </div>
                  {/* Preview */}
                  <div style={{
                    height: 50, borderRadius: 8,
                    background: `linear-gradient(${theme.background.gradient.direction},${theme.background.gradient.from},${theme.background.gradient.to})`,
                    border: "1px solid rgba(var(--color-border,255 255 255),0.1)",
                  }} />
                </div>
              )}

              {/* Image */}
              {theme.background.type === "image" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <button
                    onClick={handleSelectBgImage}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                      padding: "10px 0", borderRadius: 8, fontSize: 12, fontWeight: 600,
                      cursor: "pointer",
                      background: "rgba(var(--color-primary,99 102 241),0.15)",
                      border: "1px dashed rgba(var(--color-primary,99 102 241),0.4)",
                      color: "rgb(var(--color-primary,99 102 241))",
                    }}
                  >
                    <Upload size={14} /> 배경 이미지 선택
                  </button>

                  {theme.background.image.dataUrl && (
                    <>
                      {/* Preview */}
                      <div style={{
                        height: 80, borderRadius: 8, overflow: "hidden",
                        border: "1px solid rgba(var(--color-border,255 255 255),0.1)",
                        position: "relative",
                      }}>
                        <img
                          src={theme.background.image.dataUrl}
                          alt="preview"
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                      </div>
                      <div style={{ fontSize: 10, color: "rgb(var(--color-text-muted,156 163 175))", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {theme.background.image.path}
                      </div>

                      {/* Size */}
                      <div>
                        <div style={{ fontSize: 11, color: "rgb(var(--color-text-muted,156 163 175))", marginBottom: 5 }}>크기</div>
                        <div style={{ display: "flex", gap: 5 }}>
                          {(["cover", "contain", "tile"] as const).map(s => (
                            <button key={s} onClick={() => setBg({ image: { ...theme.background.image, size: s } })}
                              style={{
                                flex: 1, padding: "4px 0", borderRadius: 6, fontSize: 11, fontWeight: 600,
                                cursor: "pointer",
                                background: theme.background.image.size === s ? "rgba(var(--color-primary,99 102 241),0.25)" : "rgba(var(--color-border,255 255 255),0.06)",
                                border: theme.background.image.size === s ? "1px solid rgba(var(--color-primary,99 102 241),0.5)" : "1px solid rgba(var(--color-border,255 255 255),0.1)",
                                color: theme.background.image.size === s ? "rgb(var(--color-primary,99 102 241))" : "rgb(var(--color-text-main,243 244 246))",
                              }}
                            >{s === "cover" ? "채우기" : s === "contain" ? "맞추기" : "타일"}</button>
                          ))}
                        </div>
                      </div>

                      {/* Blur */}
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <span style={{ fontSize: 12, color: "rgb(var(--color-text-main,243 244 246))" }}>블러</span>
                          <span style={{ fontSize: 11, color: "rgb(var(--color-text-muted,156 163 175))" }}>{theme.background.image.blur}px</span>
                        </div>
                        <input type="range" min={0} max={30} value={theme.background.image.blur}
                          onChange={e => setBg({ image: { ...theme.background.image, blur: Number(e.target.value) } })}
                          style={{ width: "100%", accentColor: "rgb(var(--color-primary,99 102 241))" }} />
                      </div>

                      {/* Opacity */}
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <span style={{ fontSize: 12, color: "rgb(var(--color-text-main,243 244 246))" }}>이미지 불투명도</span>
                          <span style={{ fontSize: 11, color: "rgb(var(--color-text-muted,156 163 175))" }}>{theme.background.image.opacity}%</span>
                        </div>
                        <input type="range" min={0} max={100} value={theme.background.image.opacity}
                          onChange={e => setBg({ image: { ...theme.background.image, opacity: Number(e.target.value) } })}
                          style={{ width: "100%", accentColor: "rgb(var(--color-primary,99 102 241))" }} />
                      </div>

                      {/* Remove image */}
                      <button
                        onClick={() => setBg({ type: "solid", image: { ...theme.background.image, path: "", dataUrl: "" } })}
                        style={{
                          padding: "6px 0", borderRadius: 8, fontSize: 11, fontWeight: 600,
                          cursor: "pointer", background: "rgba(239,68,68,0.1)",
                          border: "1px solid rgba(239,68,68,0.25)", color: "#f87171",
                        }}
                      >
                        이미지 제거
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* Background preview */}
              <div style={{ marginTop: 8, borderTop: "1px solid rgba(var(--color-border,255 255 255),0.06)", paddingTop: 12 }}>
                <div style={{ fontSize: 11, color: "rgb(var(--color-text-muted,156 163 175))", marginBottom: 6 }}>미리보기</div>
                <div style={{
                  height: 60, borderRadius: 8,
                  border: "1px solid rgba(var(--color-border,255 255 255),0.1)",
                  overflow: "hidden", position: "relative",
                  background: theme.background.type === "solid"
                    ? theme.background.color
                    : theme.background.type === "gradient"
                    ? `linear-gradient(${theme.background.gradient.direction},${theme.background.gradient.from},${theme.background.gradient.to})`
                    : "#000",
                }}>
                  {theme.background.type === "image" && theme.background.image.dataUrl && (
                    <img src={theme.background.image.dataUrl} alt="" style={{
                      position: "absolute", inset: 0, width: "100%", height: "100%",
                      objectFit: theme.background.image.size === "tile" ? "none" : theme.background.image.size as any,
                      opacity: theme.background.image.opacity / 100,
                      filter: `blur(${theme.background.image.blur * 0.3}px)`,
                    }} />
                  )}
                  <div style={{
                    position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, color: "#fff", textShadow: "0 1px 3px rgba(0,0,0,0.8)",
                  }}>
                    배경 미리보기
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer tip */}
        <div style={{
          padding: "8px 14px",
          borderTop: "1px solid rgba(var(--color-border,255 255 255),0.06)",
          fontSize: 10, color: "rgb(var(--color-text-muted,156 163 175))",
          flexShrink: 0,
        }}>
          <ChevronRight size={10} style={{ display: "inline", marginRight: 3 }} />
          변경사항은 자동으로 미리보기되며, 저장 버튼으로 영구 저장됩니다.
        </div>
      </div>
    </>
  );
};
