import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const getTerminalTheme = (themeName: string) => {
  const defaultColors = {
    background: "transparent",
    foreground: "#f3f4f6",
    cursor: "#6366f1",
    cursorAccent: "#0f172a",
    selectionBackground: "rgba(99, 102, 241, 0.3)",
    black: "#1e293b",
    red: "#ef4444",
    green: "#10b981",
    yellow: "#f59e0b",
    blue: "#3b82f6",
    magenta: "#8b5cf6",
    cyan: "#06b6d4",
    white: "#e5e7eb",
    brightBlack: "#475569",
    brightRed: "#f87171",
    brightGreen: "#34d399",
    brightYellow: "#fbbf24",
    brightBlue: "#60a5fa",
    brightMagenta: "#a78bfa",
    brightCyan: "#22d3ee",
    brightWhite: "#f9fafb",
  };

  switch (themeName) {
    case "light":
      return {
        background: "transparent",
        foreground: "#0f172a",
        cursor: "#4f46e5",
        cursorAccent: "#ffffff",
        selectionBackground: "rgba(79, 70, 229, 0.2)",
        black: "#0f172a",
        red: "#dc2626",
        green: "#059669",
        yellow: "#d97706",
        blue: "#2563eb",
        magenta: "#7c3aed",
        cyan: "#0891b2",
        white: "#cbd5e1",
        brightBlack: "#64748b",
        brightRed: "#ef4444",
        brightGreen: "#10b981",
        brightYellow: "#f59e0b",
        brightBlue: "#3b82f6",
        brightMagenta: "#8b5cf6",
        brightCyan: "#06b6d4",
        brightWhite: "#0f172a",
      };
    case "hacker":
      return {
        background: "transparent",
        foreground: "#c9d1d9",
        cursor: "#58a6ff",
        cursorAccent: "#0d1117",
        selectionBackground: "rgba(88, 166, 255, 0.3)",
        black: "#21262d",
        red: "#f85149",
        green: "#3fb550",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#b1bac4",
        brightBlack: "#484f58",
        brightRed: "#ff7b72",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56e4e9",
        brightWhite: "#ffffff",
      };
    case "oceanic":
      return {
        background: "transparent",
        foreground: "#eceff4",
        cursor: "#88c0d0",
        cursorAccent: "#2e3440",
        selectionBackground: "rgba(136, 192, 208, 0.3)",
        black: "#3b4252",
        red: "#bf616a",
        green: "#a3be8c",
        yellow: "#ebcb8b",
        blue: "#81a1c1",
        magenta: "#b48ead",
        cyan: "#88c0d0",
        white: "#e5e9f0",
        brightBlack: "#4c566a",
        brightRed: "#bf616a",
        brightGreen: "#a3be8c",
        brightYellow: "#ebcb8b",
        brightBlue: "#81a1c1",
        brightMagenta: "#b48ead",
        brightCyan: "#8fbcbb",
        brightWhite: "#eceff4",
      };
    case "dracula":
      return {
        background: "transparent",
        foreground: "#f8f8f2",
        cursor: "#bd93f9",
        cursorAccent: "#282a36",
        selectionBackground: "rgba(189, 147, 249, 0.3)",
        black: "#21222c",
        red: "#ff5555",
        green: "#50fa7b",
        yellow: "#f1fa8c",
        blue: "#bd93f9",
        magenta: "#ff79c6",
        cyan: "#8be9fd",
        white: "#f8f8f2",
        brightBlack: "#6272a4",
        brightRed: "#ff6e6e",
        brightGreen: "#69ff94",
        brightYellow: "#ffffa5",
        brightBlue: "#d6acff",
        brightMagenta: "#ff92df",
        brightCyan: "#a4ffff",
        brightWhite: "#ffffff",
      };
    case "monokai":
      return {
        background: "transparent",
        foreground: "#f8f8f2",
        cursor: "#f92672",
        cursorAccent: "#272822",
        selectionBackground: "rgba(249, 38, 114, 0.3)",
        black: "#272822",
        red: "#f92672",
        green: "#a6e22e",
        yellow: "#e6db74",
        blue: "#66d9ef",
        magenta: "#ae81ff",
        cyan: "#66d9ef",
        white: "#f8f8f2",
        brightBlack: "#75715e",
        brightRed: "#f92672",
        brightGreen: "#a6e22e",
        brightYellow: "#e6db74",
        brightBlue: "#66d9ef",
        brightMagenta: "#ae81ff",
        brightCyan: "#66d9ef",
        brightWhite: "#f8f8f2",
      };
    case "gruvbox":
      return {
        background: "transparent",
        foreground: "#fbf1c7",
        cursor: "#fe8019",
        cursorAccent: "#282828",
        selectionBackground: "rgba(254, 128, 25, 0.3)",
        black: "#282828",
        red: "#cc241d",
        green: "#98971a",
        yellow: "#d79921",
        blue: "#458588",
        magenta: "#b16286",
        cyan: "#689d6a",
        white: "#a89984",
        brightBlack: "#928374",
        brightRed: "#fb4934",
        brightGreen: "#b8bb26",
        brightYellow: "#fabd2f",
        brightBlue: "#83a598",
        brightMagenta: "#d3869b",
        brightCyan: "#8ec07c",
        brightWhite: "#ebdbb2",
      };
    default:
      return defaultColors;
  }
};

// TerminalPane 컴포넌트 프롭스 정의
interface TerminalPaneProps {
  sessionId: string;
  type: "local" | "ssh";
  shellPath?: string;
  cwd?: string;
  fontSize: number;
  connectionInfo?: {
    host: string;
    port: number;
    username: string;
    password?: string;
    keyPath?: string;
  };
  onFocus?: () => void; // 세션 포커스 이벤트 핸들러
  registerBufferAccessor?: (accessor: () => string) => void; // 부모에게 쉘 버퍼 추출 함수 등록
  theme?: string; // 테마 프롭스 추가
}

export const TerminalPane: React.FC<TerminalPaneProps> = ({
  sessionId,
  type,
  // 기본 실행 쉘을 최신 PowerShell Core(pwsh.exe)로 지정
  shellPath = "pwsh.exe",
  cwd,
  fontSize,
  connectionInfo,
  onFocus,
  registerBufferAccessor,
  theme,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const isInitialized = useRef<boolean>(false);

  useEffect(() => {
    if (!containerRef.current || isInitialized.current) return;
    isInitialized.current = true;
    let isMounted = true;

    // 1. xterm.js 터미널 인스턴스 생성 (한글 지원 및 스타일 최적화)
    const term = new Terminal({
      cursorBlink: true,
      fontSize: fontSize,
      fontFamily: "'JetBrainsMono Nerd Font', 'MesloLGS NF', 'CaskaydiaCove Nerd Font', 'Cascadia Code NF', 'D2CodingLigature Nerd Font', D2Coding, 'Fira Code', Consolas, monospace",
      letterSpacing: 0,
      theme: getTerminalTheme(theme || "dark"),
    });

    terminalRef.current = term;

    // 2. 터미널 핏(Fit) 애드온 및 유니코드 애드온 마운트
    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);

    // 한글 등 멀티바이트 문자(CJK) 렌더링 최적화 및 커서 위치 정렬
    // const unicode11Addon = new Unicode11Addon();
    // term.loadAddon(unicode11Addon);
    // term.unicode.activeVersion = '11';

    // 이전 마운트에서 생성된 더미 터미널 DOM 노드를 제거하여 이벤트/포커스 먹통 차단
    if (containerRef.current) {
      containerRef.current.innerHTML = "";
    }
    term.open(containerRef.current);
    try {
      fitAddon.fit();
    } catch (e) {
      // FlexLayout에서 비활성화된 탭은 display:none 상태이므로 fit() 계산 중 에러가 발생할 수 있습니다.
      // 이 경우 무시하고 나중에 ResizeObserver가 처리하도록 넘깁니다.
    }

    // 3. 백엔드 PTY/SSH 세션 시작 트리거
    const initSession = async () => {
      try {
        if (type === "local") {
          // 로컬 PTY 생성 호출 (구형 powershell 구동 시 백엔드에서 chcp 65001을 자동 주입함)
          await invoke("start_pty_session", {
            sessionId,
            shellPath,
            cwd: cwd || null,
          });
          
          if (cwd) {
            // 로컬 PTY 시작 시 cwd 인자 전달 외에도, 확실하게 폴더 변경 명령어를 한 번 더 전송
            setTimeout(() => {
              invoke("write_to_pty", { sessionId, data: `cd "${cwd}"\r\n` }).catch(console.error);
            }, 600);
          }
        } else if (type === "ssh" && connectionInfo) {
          term.writeln("\r\n\x1b[33m[SSH] 원격 서버에 접속하는 중입니다...\x1b[0m");
          await invoke("connect_ssh", {
            sessionId,
            host: connectionInfo.host,
            port: connectionInfo.port,
            username: connectionInfo.username,
            password: connectionInfo.password || null,
            privateKeyPath: connectionInfo.keyPath || null,
          });

          term.writeln("\x1b[32m[SSH] 접속 성공! 원격 쉘 세션이 시작되었습니다.\x1b[0m\r\n");
          window.dispatchEvent(new CustomEvent('refresh_file_tree'));
          
          // 확실한 명령어 전달을 위해 접속 후 무조건 cd 명령어 전송 (줄바꿈 기호 강화)
          if (cwd) {
            setTimeout(() => {
              console.log(`[SSH Debug] 자동 폴더 이동 명령어 확실 전송: cd "${cwd}" (Session: ${sessionId})`);
              invoke("write_to_pty", { sessionId, data: `cd "${cwd}"\r\n` }).catch(console.error);
            }, 1000);
          }
        }
      } catch (err) {
        term.writeln(`\r\n\x1b[31m[에러] 터미널 세션 연결에 실패했습니다: ${err}\x1b[0m`);
      }
    };

    // 4. 키보드 입력 핸들러: 사용자가 xterm에 입력하면 백엔드 PTY로 전송
    const dataListener = term.onData(async (data) => {
      try {
        await invoke("write_to_pty", { sessionId, data });
      } catch (err) {
        console.error("PTY 쓰기 오류:", err);
      }
    });



    // 부모 컴포넌트가 요청할 때 최근 100줄의 터미널 버퍼 내용을 텍스트로 추출하는 통로 제공
    if (registerBufferAccessor) {
      registerBufferAccessor(() => {
        const activeBuffer = term.buffer.active;
        let fullText = "";
        const startLine = Math.max(0, activeBuffer.length - 100);
        for (let i = startLine; i < activeBuffer.length; i++) {
          const line = activeBuffer.getLine(i);
          if (line) {
            fullText += line.translateToString(true) + "\n";
          }
        }
        return fullText.trim();
      });
    }

    // 프롬프트 감지용 정규식 (PowerShell 및 Linux/Mac 쉘 프롬프트 패턴 매칭)
    const PROMPT_REGEX = /(PS\s+[A-Z]:\\[^>]*>|[\w.-]+@[\w.-]+:?[~\w\/]*[\$#]\s*)$/;
    let lastPromptLine: number | null = null;
    let parseTimeout: any = null;

    // 특정 라인 범위의 텍스트를 읽어오는 헬퍼 함수
    const getBlockText = (start: number, end: number): string => {
      let text = "";
      for (let i = start; i <= end; i++) {
        const line = term.buffer.active.getLine(i);
        if (line) {
          text += line.translateToString(true) + "\n";
        }
      }
      return text.trim();
    };

    // 프롬프트 문자열을 제거하여 순수 명령어만 추출하는 헬퍼 함수
    const extractCommand = (firstLineText: string): string => {
      const match = firstLineText.match(PROMPT_REGEX);
      if (match) {
        return firstLineText.replace(match[0], "").trim();
      }
      return firstLineText.trim();
    };

    // 명령어 블록 단위의 시각적 데코레이션 및 복사/재실행 툴바 생성 함수
    const createBlockDecoration = (startLine: number, endLine: number) => {
      try {
        if (startLine >= endLine) return;
        
        // xterm.js의 registerMarker는 절대 버퍼 행 번호가 아닌 현재 커서 행 기준의 상대 오프셋(음수)을 필요로 합니다.
        const activeBuffer = term.buffer.active;
        const currentLine = activeBuffer.cursorY + activeBuffer.baseY;
        const offset = startLine - currentLine;

        const marker = term.registerMarker(offset);
        if (!marker) return;

        const height = endLine - startLine;
        const decoration = term.registerDecoration({
          marker,
          x: 0,
          width: term.cols,
          height: height,
          layer: "bottom", // 텍스트 뒤쪽 배경으로 렌더링하여 마우스 텍스트 선택 방해 안 함
        });

        decoration?.onRender((element) => {
          // 중복 툴바 노드 삽입으로 인한 성능 저하 및 무한 루프 뻗음 현상 방지
          if (element.querySelector(".terminal-block-toolbar")) {
            return;
          }

          // 블록 하이라이트 효과를 위한 기본 투명 테두리 및 트랜지션 설정
          element.style.borderLeft = "3px solid transparent";
          element.style.transition = "all 0.15s ease-in-out";
          element.style.pointerEvents = "none"; // 일반 클릭 통과 유도
          element.style.display = "flex";
          element.style.position = "relative";

          // 마우스 오버 시 가이드 테두리와 연한 퍼플빛 배경색 활성화
          element.onmouseenter = () => {
            element.style.borderLeft = "3px solid #6366f1";
            element.style.backgroundColor = "rgba(99, 102, 241, 0.04)";
            toolbar.style.opacity = "1";
          };
          element.onmouseleave = () => {
            element.style.borderLeft = "3px solid transparent";
            element.style.backgroundColor = "transparent";
            toolbar.style.opacity = "0";
          };

          // 툴바 컨테이너 배치 (우측 상단 퀵 액션)
          const toolbar = document.createElement("div");
          toolbar.className = "terminal-block-toolbar"; // 중복 생성 체크를 위한 고유 클래스 지정
          toolbar.style.position = "absolute";
          toolbar.style.top = "6px";
          toolbar.style.right = "12px";
          toolbar.style.display = "flex";
          toolbar.style.gap = "6px";
          toolbar.style.opacity = "0";
          toolbar.style.transition = "opacity 0.15s ease-in-out";
          toolbar.style.pointerEvents = "auto"; // 버튼 클릭 활성화

          // 1. 명령어 복사 버튼
          const copyBtn = document.createElement("button");
          copyBtn.innerText = "📋 복사";
          copyBtn.style.fontSize = "10px";
          copyBtn.style.backgroundColor = "#1e293b";
          copyBtn.style.color = "#cbd5e1";
          copyBtn.style.border = "1px solid #475569";
          copyBtn.style.padding = "2px 6px";
          copyBtn.style.borderRadius = "4px";
          copyBtn.style.cursor = "pointer";
          copyBtn.style.fontWeight = "bold";
          copyBtn.onmouseenter = () => { copyBtn.style.borderColor = "#6366f1"; };
          copyBtn.onmouseleave = () => { copyBtn.style.borderColor = "#475569"; };
          copyBtn.onclick = () => {
            const commandLineText = getBlockText(startLine, startLine);
            const cmd = extractCommand(commandLineText);
            navigator.clipboard.writeText(cmd);
            copyBtn.innerText = "✓ 복사됨";
            setTimeout(() => { copyBtn.innerText = "📋 복사"; }, 1200);
          };

          // 2. 명령어 재실행 버튼
          const rerunBtn = document.createElement("button");
          rerunBtn.innerText = "🔁 실행";
          rerunBtn.style.fontSize = "10px";
          rerunBtn.style.backgroundColor = "#1e293b";
          rerunBtn.style.color = "#cbd5e1";
          rerunBtn.style.border = "1px solid #475569";
          rerunBtn.style.padding = "2px 6px";
          rerunBtn.style.borderRadius = "4px";
          rerunBtn.style.cursor = "pointer";
          rerunBtn.style.fontWeight = "bold";
          rerunBtn.onmouseenter = () => { rerunBtn.style.borderColor = "#6366f1"; };
          rerunBtn.onmouseleave = () => { rerunBtn.style.borderColor = "#475569"; };
          rerunBtn.onclick = () => {
            const commandLineText = getBlockText(startLine, startLine);
            const cmd = extractCommand(commandLineText);
            invoke("write_to_pty", { sessionId, data: `${cmd}\r` }).catch(console.error);
          };

          toolbar.appendChild(copyBtn);
          toolbar.appendChild(rerunBtn);
          element.appendChild(toolbar);
        });
      } catch (err) {
        console.error("블록 데코레이션 생성 실패:", err);
      }
    };

    // 출력 버퍼 분석을 통해 프롬프트를 찾고 블록을 트리거하는 함수
    const checkForPromptAndCreateBlock = () => {
      try {
        const activeBuffer = term.buffer.active;
        const currentLineIndex = activeBuffer.cursorY + activeBuffer.baseY;

        let promptLineIndex = -1;
        // 최근 커서 인근 라인을 역으로 스캔하여 프롬프트 패턴이 들어온 최종 행 식별
        for (let i = Math.max(0, currentLineIndex - 2); i <= currentLineIndex; i++) {
          const line = activeBuffer.getLine(i);
          if (line) {
            const text = line.translateToString(true);
            if (PROMPT_REGEX.test(text)) {
              promptLineIndex = i;
              break;
            }
          }
        }

        if (promptLineIndex !== -1) {
          if (lastPromptLine !== null && promptLineIndex > lastPromptLine) {
            // 이전 프롬프트 행부터 현재 프롬프트 행 바로 전까지의 구간을 블록화
            createBlockDecoration(lastPromptLine, promptLineIndex);
          }
          // 최근 프롬프트 행 위치 최신화
          lastPromptLine = promptLineIndex;
        }
      } catch (err) {
        console.error("프롬프트 블록 체크 실패:", err);
      }
    };

    // 5. 백엔드 출력 수신 리스너: Rust PTY에서 발생한 출력을 xterm에 출력 및 블록 분석 디바이스
    const outputListenerPromise = listen("pty-output", (event: any) => {
      const payload = event.payload as { sessionId: string; data: string };
      if (payload.sessionId === sessionId) {
        term.write(payload.data);

        // 출력이 발생하면 분석 타이머를 초기화하고 백그라운드 분석 (콜백 실행 실패 중단 방지)
        if (parseTimeout) clearTimeout(parseTimeout);
        parseTimeout = setTimeout(() => {
          checkForPromptAndCreateBlock();
        }, 100);
      }
    });

    // 리스너가 성공적으로 등록된 후 세션을 구동해 데이터 유실 차단
    outputListenerPromise.then(() => {
      if (!isMounted) return;
      initSession();
      // 초기 입력 편의를 위해 마운트 성공 시 자동 포커스 부여
      term.focus();
    });

    // 6. 창 크기 변화 감지 (ResizeObserver) 및 백엔드 PTY 크기 동기화
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || entry.contentRect.width === 0 || entry.contentRect.height === 0) {
        return; // flexlayout이 display: none으로 숨겼을 때는 무시하여 화면 초기화(버그) 방지
      }
      if (fitAddonRef.current && terminalRef.current) {
        try {
          fitAddonRef.current.fit();
          const cols = terminalRef.current.cols;
          const rows = Math.max(1, terminalRef.current.rows);
          // 백엔드 PTY 창 크기 조절 API 호출
          invoke("resize_pty", { sessionId, cols, rows }).catch(console.error);
        } catch (e) {
          console.error("터미널 크기 조정 에러:", e);
        }
      }
    });
    resizeObserver.observe(containerRef.current);

    // 언마운트 시 리스너 해제 및 메모리 정리
    return () => {
      isMounted = false;
      dataListener.dispose();
      resizeObserver.disconnect();
      term.dispose();
      outputListenerPromise.then((unlisten) => unlisten());

      // 백엔드 PTY 세션 명시적 종료 호출 (유령 powershell 프로세스 리소스 정리)
      invoke("close_pty_session", { sessionId }).catch((err) => {
        console.warn(`[TerminalPane] 백엔드 PTY 세션 해제 에러 (ID: ${sessionId}):`, err);
      });

      isInitialized.current = false; // React Strict Mode 및 의존성 변경으로 인한 이펙트 재실행 시 터미널 재초기화가 가능하도록 플래그 리셋
    };
  }, [sessionId, type, shellPath]);

  // 폰트 크기 변경 감지 및 반영
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.fontSize = fontSize;
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
        const cols = terminalRef.current.cols;
        const rows = terminalRef.current.rows;
        invoke("resize_pty", { sessionId, cols, rows }).catch(console.error);
      }
    }
  }, [fontSize]);

  // 테마 변경 감지 및 반영
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = getTerminalTheme(theme || "dark");
    }
  }, [theme]);

  return (
    <div 
      className="w-full h-full relative overflow-hidden bg-theme-base/40 rounded-lg border border-theme-border/5 cursor-text"
      onClick={() => terminalRef.current?.focus()}
      onFocusCapture={() => onFocus?.()}
    >
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
};
