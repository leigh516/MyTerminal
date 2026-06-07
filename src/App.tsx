import React, { useState, useEffect } from "react";
import { Layout, Model, TabNode, IJsonModel, Action, Actions } from "flexlayout-react";
import "flexlayout-react/style/dark.css";
import { TerminalPane } from "./components/TerminalPane";
import { EditorPane } from "./components/EditorPane";
import { FileTree } from "./components/FileTree";
import { AIChat } from "./components/AIChat";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { 
  Terminal, ShieldAlert, Cpu, ZoomIn, ZoomOut, Wifi, 
  X, Plus, Layout as LayoutIcon, Save, FolderOpen, Trash2, Palette
} from "lucide-react";

// 개별 활성 세션의 속성을 나타내는 인터페이스 정의
interface SessionItem {
  id: string;
  title: string;
  type: "local" | "ssh" | "editor";
  fontSize: number;
  shellPath?: string;
  cwd?: string;
  connectionInfo?: {
    host: string;
    port: number;
    username: string;
    password?: string;
    keyPath?: string;
  };
  editorFilePath?: string;
  editorFileName?: string;
  editorFileContent?: string;
}

// 레이아웃 전체 설정을 저장하기 위한 프로필 인터페이스 정의
interface LayoutProfile {
  name: string;
  sessions: SessionItem[];
  activeSessionIds: string[];
  splitDirection?: "horizontal" | "vertical";
}

interface SshProfile {
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  keyPath?: string;
  cwd?: string;
}


const DEFAULT_LAYOUT: IJsonModel = {
  global: {
    tabEnableClose: true,
    tabSetEnableMaximize: true,
    tabClassName: "terminal-tab",
  },
  borders: [],
  layout: {
    type: "row",
    weight: 100,
    children: [
      {
        type: "tabset",
        weight: 70,
        children: [
          { type: "tab", id: "local-1", name: "로컬 터미널 1", component: "local" }
        ]
      },
      {
        type: "tabset",
        weight: 30,
        children: [
          { type: "tab", id: "ai-panel", name: "AI", component: "ai" }
        ]
      }
    ]
  }
};

function App() {
  // 1. ?�성 ?�션 ?�태 �??�면 ID 목록 관�?(로컬?�토리�? ?�동 복원 ?�동)
  const [sessions, setSessions] = useState<SessionItem[]>(() => {
    const saved = localStorage.getItem("terminal_avy_active_sessions");
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as SessionItem[];
        // 기존 로컬?�토리�???powershell.exe???��?경로�??�?�되???�던 ?�정??최신 pwsh.exe�??�괄 보정
        return parsed.map(s => {
          if (s.type === "local" && (s.shellPath?.includes("powershell.exe") || !s.shellPath)) {
            return { ...s, shellPath: "pwsh.exe" };
          }
          return s;
        });
      } catch (e) {

        console.error("로컬 세션 파싱 오류:", e);
      }
    }
    return [
      { id: "local-1", title: "로컬 터미널 1", type: "local", fontSize: 13, shellPath: "pwsh.exe" }
    ];
  });

  const [model, setModel] = useState<Model>(() => {
    const saved = localStorage.getItem("terminal_avy_flex_model");

    if (saved) {
      try {
        const json = JSON.parse(saved);
        return Model.fromJson(json);
      } catch (e) {
        console.error("FlexLayout ?�싱 ?�류:", e);
      }
    }
    return Model.fromJson(DEFAULT_LAYOUT);
  });
  
  const layoutRef = React.useRef<any>(null);

  // activeSessionIds?????�상 직접 관리하지 ?�으??기존 로직 ?�환?�을 ?�해 sessions 배열?�서 ID 추출
  const activeSessionIds = sessions.map(s => s.id);

  // 2. SSH ?�버 ?�결 관???�업 모달 ?�태
  const [showSshModal, setShowSshModal] = useState<boolean>(false);
  const [sshHost, setSshHost] = useState<string>("");
  const [sshPort, setSshPort] = useState<number>(22);
  const [sshUser, setSshUser] = useState<string>("");
  const [sshPass, setSshPass] = useState<string>("");
  const [sshKeyPath, setSshKeyPath] = useState<string>("");
  const [sshCwd, setSshCwd] = useState<string>("/home/ubuntu");
  const [sshError, setSshError] = useState<string>("");

  const [sshProfiles, setSshProfiles] = useState<SshProfile[]>(() => {
    const saved = localStorage.getItem("terminal_avy_ssh_profiles");
    return saved ? JSON.parse(saved) : [];
  });
  const [selectedSshProfileName, setSelectedSshProfileName] = useState<string>("");
  const [newSshProfileName, setNewSshProfileName] = useState<string>("");

  useEffect(() => {
    localStorage.setItem("terminal_avy_ssh_profiles", JSON.stringify(sshProfiles));
  }, [sshProfiles]);

  // 3. ?�로???�??�?복원 관??모달 ?�태
  const [profiles, setProfiles] = useState<LayoutProfile[]>(() => {
    const saved = localStorage.getItem("terminal_avy_profiles");
    return saved ? JSON.parse(saved) : [];
  });
  const [showProfileModal, setShowProfileModal] = useState<boolean>(false);
  const [newProfileName, setNewProfileName] = useState<string>("");
  const [selectedProfileName, setSelectedProfileName] = useState<string>("");

  // 터미널 에러 자동 진단용 상태
  const [lastTerminalError, setLastTerminalError] = useState<string>("");

  // AI 어시스턴트 폰트 크기 상태 선언 및 localStorage 연동
  const [aiFontSize, setAiFontSize] = useState<number>(() => {
    const saved = localStorage.getItem("terminal_avy_ai_fontsize");
    return saved ? parseInt(saved, 10) : 13;
  });

  // 액티브 포커스드 세션 및 AI 접힘 관련 상태 (구조 주석)
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const [isFileTreeCollapsed, setIsFileTreeCollapsed] = useState<boolean>(false);
  const terminalBuffersRef = React.useRef<Record<string, () => string>>({});

  const [theme, setTheme] = useState<string>(() => {
    return localStorage.getItem("terminal_avy_theme") || "dark";
  });

  useEffect(() => {
    localStorage.setItem("terminal_avy_theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // 4. ?�태 변�???로컬?�토리�? ?�동 ?�??Auto-Save)
  useEffect(() => {
    localStorage.setItem("terminal_avy_active_sessions", JSON.stringify(sessions));
  }, [sessions]);

  // Model??변경될 ?�마???�동 ?�??  
  const handleModelChange = (newModel: Model) => {
    setModel(newModel);
    localStorage.setItem("terminal_avy_flex_model", JSON.stringify(newModel.toJson()));
  };

  useEffect(() => {
    localStorage.setItem("terminal_avy_profiles", JSON.stringify(profiles));
  }, [profiles]);

  useEffect(() => {
    const unlistenPromise = listen("pty-output", (event: any) => {
      const payload = event.payload as { sessionId: string; data: string };
      if (
        payload.data.includes("Error:") ||
        payload.data.includes("EADDRINUSE") ||
        payload.data.includes("failed") ||
        payload.data.includes("오류")
      ) {
        const firstLine = payload.data.split("\n").find(line => 
          line.includes("Error") || line.includes("EADDRINUSE") || line.includes("failed") || line.includes("오류")
        );
        if (firstLine) {
          setLastTerminalError(firstLine.replace(/\r/g, "").trim());
        }
      }
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);



  // 백엔?�로부??PTY/SSH ?�션 종료 ?�호(pty-closed)�?받으�??�당 ?�션 창을 ?�동?�로 ?�거 (?��? 주석)
  useEffect(() => {
    const unlistenClosedPromise = listen("pty-closed", (event: any) => {
      const closedSessionId = event.payload as string;
      handleCloseSession(closedSessionId);
    });
    return () => {
      unlistenClosedPromise.then((unlisten) => unlisten());
    };
  }, []);

  const addTabToLayout = (tabNode: any) => {
    if (!layoutRef.current) return;
    const activeTabset = model.getActiveTabset();
    if (activeTabset) {
      layoutRef.current.addTabToActiveTabSet(tabNode);
    } else {
      let firstTabsetId: string | null = null;
      model.visitNodes((node) => {
        if (node.getType() === "tabset" && !firstTabsetId) {
          firstTabsetId = node.getId();
        }
      });
      if (firstTabsetId) {
        layoutRef.current.addTabToTabSet(firstTabsetId, tabNode);
      }
    }
  };

  // 6. 로컬 터미널 추가 핸들러  
  const handleAddLocalSession = () => {
    const newId = `local-${Date.now()}`;
    const newSess: SessionItem = {
      id: newId,
      title: `로컬 터미널 ${sessions.filter(s => s.type === "local").length + 1}`,
      type: "local",
      fontSize: 13,
      // ???�션 ?�성 ?�에??최신 PowerShell Core(pwsh.exe)�?기본값으�?지??      shellPath: "pwsh.exe"
    };
    setSessions(prev => [...prev, newSess]);
    addTabToLayout({
      type: "tab",
      component: "local",
      name: newSess.title,
      id: newId
    });
    setFocusedSessionId(newId);
  };

  // 7. SSH ?????션 추? ?들??  
  const handleConnectSsh = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sshHost || !sshUser) {
      setSshError("호스트와 사용자명을 입력해주세요.");
      return;
    }

    const sessionId = `ssh-${Date.now()}`;
    const sshCount = sessions.filter(s => s.type === "ssh").length + 1;
    const profileNamePart = selectedSshProfileName || `${sshUser}@${sshHost}`;

    const newSess: SessionItem = {
      id: sessionId,
      title: `SSH ${sshCount}: ${profileNamePart}`,
      type: "ssh",
      fontSize: 13,
      cwd: sshCwd || undefined,
      connectionInfo: {
        host: sshHost,
        port: sshPort,
        username: sshUser,
        password: sshPass || undefined,
        keyPath: sshKeyPath || undefined,
      }
    };

    setSessions(prev => [...prev, newSess]);
    addTabToLayout({
      type: "tab",
      component: "ssh",
      name: newSess.title,
      id: sessionId
    });
    setFocusedSessionId(sessionId);
    setShowSshModal(false); // ?�속 ??모달 ?�기
    
    // 모달 ?�태 초기??    setSshHost("");
    setSshPort(22);
    setSshUser("");
    setSshPass("");
    setSshKeyPath("");
    setSshCwd("/home/ubuntu");
    setSelectedSshProfileName("");
    setSshError("");
  };

  const handleSaveSshProfile = () => {
    if (!newSshProfileName.trim()) {
      alert("프로필 이름을 입력해주세요.");
      return;
    }
    const profile: SshProfile = {
      name: newSshProfileName.trim(),
      host: sshHost,
      port: sshPort,
      username: sshUser,
      password: sshPass || undefined,
      keyPath: sshKeyPath || undefined,
      cwd: sshCwd || undefined,
    };
    setSshProfiles(prev => {
      const existingIdx = prev.findIndex(p => p.name === profile.name);
      if (existingIdx !== -1) {
        const updated = [...prev];
        updated[existingIdx] = profile;
        return updated;
      }
      return [...prev, profile];
    });
    setNewSshProfileName("");
    setSelectedSshProfileName(profile.name);
    alert(`SSH 프로필 [${profile.name}]이 저장되었습니다.`);
  };

  const handleLoadSshProfile = (name: string) => {
    const prof = sshProfiles.find(p => p.name === name);
    if (!prof) return;
    setSshHost(prof.host);
    setSshPort(prof.port);
    setSshUser(prof.username);
    setSshPass(prof.password || "");
    setSshKeyPath(prof.keyPath || "");
    setSshCwd(prof.cwd || "/home/ubuntu");
    setSelectedSshProfileName(name);
  };

  const handleDeleteSshProfile = () => {
    if (!selectedSshProfileName) return;
    const confirmDelete = window.confirm(`프로필 [${selectedSshProfileName}]을 삭제하시겠습니까?`);
    if (!confirmDelete) return;
    setSshProfiles(prev => prev.filter(p => p.name !== selectedSshProfileName));
    setSelectedSshProfileName("");
  };

  // 8. ?�일 ?�리?�서 ?�일 ?�택 ???�적?�로 ?�디???�션 분할 ?�성 (VS Code처럼 ?�일 ?�디??�??��?)
  const handleFileSelect = async (filePath: string, fileName: string, isRemote: boolean) => {
    try {
      const editorSessId = "editor-main"; // 고정???�일 ?�디??ID ?�용
      let content = "";
      
      if (isRemote) {
        content = "// [?�격 ?�일] ?�기�?준�?중입?�다...";
      } else {
        content = await invoke("read_local_file", { path: filePath });
      }

      // ?��? ?�디???�션??존재?�는지 ?�인
      const existingEditorIdx = sessions.findIndex(s => s.id === editorSessId);

      if (existingEditorIdx !== -1) {
        // ?��? 존재?�다�??�당 ?�션 ?�보�??�데?�트
        setSessions(prev => 
          prev.map(s => 
            s.id === editorSessId 
              ? {
                  ...s,
                  title: `코드 에디터 ${fileName}`,
                  editorFilePath: filePath,
                  editorFileName: fileName,
                  editorFileContent: content
                }
              : s
          )
        );
        // 만약 FlexLayout 모델에 에디터가 빠져있다면 다시 넣어줌
        if (!model.getNodeById(editorSessId)) {
          addTabToLayout({
            type: "tab",
            component: "editor",
            name: `코드 에디터 ${fileName}`,
            id: editorSessId
          });
        }
      } else {
        // 존재하지 않는다면 신규 세션 추가
        const newSess: SessionItem = {
          id: editorSessId,
          title: `코드 에디터 ${fileName}`,
          type: "editor",
          fontSize: 13,
          editorFilePath: filePath,
          editorFileName: fileName,
          editorFileContent: content
        };
        setSessions(prev => [...prev, newSess]);
        // 에디터도 추가
        if (!model.getNodeById(editorSessId)) {
          addTabToLayout({
            type: "tab",
            component: "editor",
            name: newSess.title,
            id: editorSessId
          });
        }
      }
      setFocusedSessionId(editorSessId);
    } catch (e) {
      console.error("파일 읽기 실패:", e);
    }
  };

  // 9. 파일 관리자에서 터미널 열기 핸들러  
  const handleOpenTerminalFromTree = (path: string, isRemote: boolean, sourceSessionId: string) => {
    if (isRemote) {
      const sourceSession = sessions.find(s => s.id === sourceSessionId);
      if (!sourceSession || sourceSession.type !== "ssh" || !sourceSession.connectionInfo) return;
      
      const newId = `ssh-${Date.now()}`;
      const newSess: SessionItem = {
        id: newId,
        title: `원격 SSH: ${sourceSession.connectionInfo.username}@${sourceSession.connectionInfo.host}`,
        type: "ssh",
        fontSize: 13,
        cwd: path,
        connectionInfo: sourceSession.connectionInfo
      };
      setSessions(prev => [...prev, newSess]);
      addTabToLayout({
        type: "tab",
        component: "ssh",
        name: newSess.title,
        id: newId
      });
      setFocusedSessionId(newId);
    } else {
      const newId = `local-${Date.now()}`;
      const newSess: SessionItem = {
        id: newId,
        title: `로컬 터미널 ${sessions.filter(s => s.type === "local").length + 1}`,
        type: "local",
        fontSize: 13,
        cwd: path,
        shellPath: "pwsh.exe"
      };
      setSessions(prev => [...prev, newSess]);
      addTabToLayout({
        type: "tab",
        component: "local",
        name: newSess.title,
        id: newId
      });
      setFocusedSessionId(newId);
    }
  };



  // ?�디???�일 ?�용 변�??�파 ?�들??  
  const handleEditorContentChange = (id: string, value: string | undefined) => {
    setSessions(prev => 
      prev.map(s => s.id === id ? { ...s, editorFileContent: value || "" } : s)
    );
  };

  // ?�디??개별 ?�일 ?�???�들??  
  // ?디??개별 ?일 ????들??  
  const handleSaveEditorFile = async (id: string) => {
    const sess = sessions.find(s => s.id === id);
    if (!sess || !sess.editorFilePath) return;

    try {
      if (sess.title.includes("[원격]")) {
        alert("원격 파일 직접 수정은 SFTP 전송을 권장합니다.");
      } else {
        await invoke("write_local_file", {
          path: sess.editorFilePath,
          content: sess.editorFileContent || "",
        });
        alert(`저장 성공: ${sess.editorFileName}`);
      }
    } catch (e) {
      alert(`저장 실패: ${e}`);
    }
  };

  // 9. 세션 독립 폰트 줌 기능
  const handleZoom = (id: string, direction: "in" | "out") => {
    if (id === "ai-panel") {
      setAiFontSize(prev => {
        const newSize = direction === "in" ? Math.min(prev + 1, 24) : Math.max(prev - 1, 9);
        localStorage.setItem("terminal_avy_ai_fontsize", newSize.toString());
        return newSize;
      });
      return;
    }
    setSessions(prev => 
      prev.map(s => {
        if (s.id === id) {
          const newSize = direction === "in" 
            ? Math.min(s.fontSize + 1, 24) 
            : Math.max(s.fontSize - 1, 9);
          return { ...s, fontSize: newSize };
        }
        return s;
      })
    );
  };

  // 10. 세션 개별 닫기 및 뷰포트제거 핸들러(세션 주석)
  const handleCloseSession = (id: string) => {
    // setActiveSessionIds 제거 (model.onAction에서 자동 처리)
    // 자동으로 FlexLayout 안닫혀야 하는 경우
    if (model.getNodeById(id)) {
      model.doAction(Actions.deleteTab(id));
    }
    setSessions(prev => prev.filter(s => s.id !== id));
    setFocusedSessionId(prev => prev === id ? null : prev);
    if (terminalBuffersRef.current[id]) {
      delete terminalBuffersRef.current[id];
    }
  };

  // 11. 자동 프로필저장 기능
  const handleSaveProfile = () => {
    if (!newProfileName.trim()) return;
    const newProfile: LayoutProfile = {
      name: newProfileName.trim(),
      sessions,
      activeSessionIds
    };
    setProfiles(prev => [...prev, newProfile]);
    setNewProfileName("");
    setShowProfileModal(false);
    alert(`프로필[${newProfile.name}] 저장완료!`);
  };

  // 12. 자동 프로필불러오기 및 레이아웃 복원
  const handleLoadProfile = (name: string) => {
    const prof = profiles.find(p => p.name === name);
    if (!prof) return;
    setSessions(prof.sessions);
    if (prof.activeSessionIds && prof.activeSessionIds.length > 0) {
      // ?�거???�로???�환?�을 ?�해 ??Model???�성
      const newModelJson = {
        ...DEFAULT_LAYOUT,
        layout: {
          ...DEFAULT_LAYOUT.layout,
          children: [
            {
              type: "tabset",
              weight: 70,
              children: prof.activeSessionIds.map(id => {
                const s = prof.sessions.find(x => x.id === id);
                return { type: "tab", id, name: s ? s.title : id, component: s ? s.type : "local" };
              })
            },
            {
              type: "tabset",
              weight: 30,
              children: [
                { type: "tab", id: "ai-panel", name: "AI Assistant", component: "ai" }
              ]
            }
          ]
        }
      };
      setModel(Model.fromJson(newModelJson));
    }
    setSelectedProfileName(name);
    alert(`프로필 [${name}] 레이아웃이 복원되었습니다.`);
  };

  const handleDeleteProfile = () => {
    if (!selectedProfileName) return;
    if (confirm(`정말 화면구성 [${selectedProfileName}]을 삭제하시겠습니까?`)) {
      setProfiles(prev => prev.filter(p => p.name !== selectedProfileName));
      setSelectedProfileName("");
    }
  };

  // 13. AI ??창???안??명령 주입 ?행 ?들??  
  const handleInjectCommand = async (command: string) => {
    // ?재 ?커?된 ?션???선?고, ?으??성?된 ?션 ??번째 ?????택
    let targetSessId = focusedSessionId;
    if (!targetSessId || (!targetSessId.startsWith("local-") && !targetSessId.startsWith("ssh-"))) {
      targetSessId = activeSessionIds.find(id => id.startsWith("local-") || id.startsWith("ssh-")) || null;
    }

    if (!targetSessId) {
      alert("명령???행???성?된 ?????션??존재?? ?습?다.");
      return;
    }

    try {
      await invoke("write_to_pty", {
        sessionId: targetSessId,
        data: `${command}\r`,
      });
    } catch (e) {
      console.error("명령 주입 ?패:", e);
    }
  };

  // 14. ?재 ?티??커???????????는 ?디??버퍼???용??문자?로 가?오???들??(?? 주석)
  const getActiveTerminalContent = (specificSessionId?: string) => {
    let targetSessId = specificSessionId || focusedSessionId;
    if (!targetSessId) {
      // ?커?된 ?션???을 경우, ?성 ?션 ??????디???서??번째 ????색
      targetSessId = activeSessionIds.find(id => id.startsWith("local-") || id.startsWith("ssh-") || id.startsWith("editor-")) || null;
    }
    if (!targetSessId) return "";

    const sess = sessions.find(s => s.id === targetSessId);
    if (!sess) return "";

    let infoHeader = `[?션 ?보: ID=${sess.id}, ???=${sess.title}, ?형=${sess.type}]\n`;
    if (sess.type === "ssh" && sess.connectionInfo) {
      infoHeader += `[SSH ?속 ??? ${sess.connectionInfo.username}@${sess.connectionInfo.host}]\n`;
    }

    if (sess.type === "editor") {
      return `${infoHeader}[?�디???�일 ?�용 (${sess.editorFileName})]\n${sess.editorFileContent || ""}`;
    } else if (terminalBuffersRef.current[targetSessId]) {
      return `${infoHeader}[?��???버퍼 최근 100�??�용]\n${terminalBuffersRef.current[targetSessId]()}`;
    }
    return infoHeader;
  };

  // 15. FlexLayout ?�벤??�??�더�??�들??  
  const onAction = (action: Action) => {
    if (action.type === Actions.DELETE_TAB) {
      const id = action.data.node;
      handleCloseSession(id);
    }
    return action;
  };

  const onRenderTab = (node: TabNode, renderState: any) => {
    const id = node.getId();
    const isSpecial = id.startsWith("local-") || id.startsWith("ssh-") || id.startsWith("editor-") || id === "ai-panel";
    if (isSpecial) {
      // 단축 제목 생성
      let shortName = node.getName();
      if (id.startsWith("local-")) {
        // local-1, local-2 ... 순서 구하기
        const localSessions = sessions.filter(s => s.type === "local");
        const idx = localSessions.findIndex(s => s.id === id);
        shortName = `Loca${idx + 1}`;
      } else if (id.startsWith("ssh-")) {
        const sshSessions = sessions.filter(s => s.type === "ssh");
        const idx = sshSessions.findIndex(s => s.id === id);
        shortName = `SSH${idx + 1}`;
      } else if (id.startsWith("editor-")) {
        const sess = sessions.find(s => s.id === id);
        const fname = sess?.editorFileName || "Edit";
        // 파일명이 짧으면 그대로, 길면 확장자 제외한 8자만
        shortName = fname.length > 10 ? fname.replace(/\.[^/.]+$/, "").slice(0, 8) : fname;
      } else if (id === "ai-panel") {
        shortName = "AI";
      }
      renderState.content = (
        <span style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.02em" }}>{shortName}</span>
      );
      renderState.buttons.push(
        <div key="zoom" className="flex items-center gap-0.5 mx-1" onMouseDown={e => e.stopPropagation()}>
          <button onClick={() => handleZoom(id, "in")} className="p-0.5 text-theme-muted hover:text-theme-text rounded transition" title="글꼴 확대"><ZoomIn size={11}/></button>
          <button onClick={() => handleZoom(id, "out")} className="p-0.5 text-theme-muted hover:text-theme-text rounded transition" title="글꼴 축소"><ZoomOut size={11}/></button>
        </div>
      );
    }
  };

  const factory = (node: TabNode) => {
    const component = node.getComponent();
    const id = node.getId();

    if (component === "ai") {
      return (
        <div className="w-full h-full p-2 bg-theme-base/20">
          <AIChat
            onInjectCommand={handleInjectCommand}
            lastTerminalError={lastTerminalError}
            getActiveTerminalContent={getActiveTerminalContent}
            isCollapsed={false}
            onToggleCollapse={() => {}}
            activeTerminals={sessions.map(s => ({ id: s.id, title: s.title }))}
            focusedSessionId={focusedSessionId}
            fontSize={aiFontSize}
          />
        </div>
      );
    }

    const sess = sessions.find(s => s.id === id);
    if (!sess) return null;

    const isFocused = focusedSessionId === sess.id;

    return (
      <div 
        onMouseDownCapture={() => setFocusedSessionId(id)}
        className={`w-full h-full flex flex-col bg-theme-base/20 relative transition-all duration-200 ${
          isFocused ? "ring-1 ring-inset ring-theme-primary/50" : ""
        }`}
      >
        <div className="flex-1 overflow-hidden p-1">
          {sess.type === "local" && (
            <TerminalPane
              sessionId={sess.id}
              type="local"
              fontSize={sess.fontSize}
              shellPath={sess.shellPath}
              cwd={sess.cwd}
              theme={theme}
              onFocus={() => setFocusedSessionId(sess.id)}
              registerBufferAccessor={(accessor) => {
                terminalBuffersRef.current[sess.id] = accessor;
              }}
            />
          )}
          {sess.type === "ssh" && (
            <TerminalPane
              sessionId={sess.id}
              type="ssh"
              fontSize={sess.fontSize}
              connectionInfo={sess.connectionInfo}
              cwd={sess.cwd}
              theme={theme}
              onFocus={() => setFocusedSessionId(sess.id)}
              registerBufferAccessor={(accessor) => {
                terminalBuffersRef.current[sess.id] = accessor;
              }}
            />
          )}
          {sess.type === "editor" && (
            <EditorPane
              sessionId={sess.id}
              fontSize={sess.fontSize}
              fileName={sess.editorFileName || "No Name"}
              content={sess.editorFileContent || ""}
              onChange={(val) => handleEditorContentChange(sess.id, val)}
              onSave={() => handleSaveEditorFile(sess.id)}
            />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="w-screen h-screen flex bg-theme-base text-theme-text overflow-hidden font-ui">
      {/* ?�이?�바: ?�일 ?�색�?(고정 ?�비 ?�랜지???�라?�드) */}
      <div 
        className={`flex flex-col bg-theme-surface border-r border-theme-border/5 z-20 transition-all duration-300 ease-in-out shrink-0 overflow-hidden ${
          isFileTreeCollapsed ? 'w-0 border-r-0 opacity-0' : 'w-72 opacity-100'
        }`}
      >
        <div className="w-72 h-full">
          <FileTree
            activeSessionId={activeSessionIds.find(id => id.startsWith("ssh-")) || ""}
            sshSessions={sessions.filter(s => s.type === "ssh")}
            onFileSelect={handleFileSelect}
            onOpenTerminal={handleOpenTerminalFromTree}
          />
        </div>
      </div>
      <div className="flex flex-col min-w-0 flex-1 relative bg-theme-base">

      {/* 최상???�어 ?�보 �?*/}
      {/* 최상???어 ?보 ?*/}
      <header className="h-12 bg-theme-surface/90 border-b border-theme-border/10 flex items-center justify-between px-6 shrink-0 z-10 select-none">
        <div className="flex items-center gap-3">
          <button 
            onClick={() => setIsFileTreeCollapsed(!isFileTreeCollapsed)} 
            className="p-1.5 hover:bg-theme-border/10 rounded text-theme-muted transition hover:text-theme-text" 
            title="사이드바 토글"
          >
            <LayoutIcon size={16} />
          </button>
          <div className="w-3.5 h-3.5 bg-theme-primary rounded-full animate-pulse shadow-lg shadow-theme-primary/50" />
          <h1 className="font-extrabold text-sm tracking-wider text-theme-text uppercase">
            WORKSPACE
          </h1>
        </div>
        
        {/* 사이드바 상태 알림 및 테마 설정 */}
        <div className="flex items-center gap-6 text-xs text-theme-muted">
          <div className="flex items-center gap-2" title="테마 변경">
            <Palette size={14} className="text-theme-muted" />
            <select
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              className="bg-theme-panel text-theme-text text-xs rounded border border-theme-border/20 px-2 py-1 outline-none"
            >

              <option value="dark">Dark (기본)</option>
              <option value="light">Light</option>
              <option value="dracula">Dracula</option>
              <option value="monokai">Monokai</option>
              <option value="gruvbox">Gruvbox 다크</option>
              <option value="hacker">Hacker (GitHub)</option>
              <option value="oceanic">Oceanic (Nord)</option>
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <Cpu size={14} className="text-theme-primary" />
            <span>Tauri v2 Core</span>
          </div>
          {sessions.some(s => s.type === "ssh" && activeSessionIds.includes(s.id)) && (
            <div className="flex items-center gap-1.5 text-theme-accent">
              <Wifi size={14} />
              <span>SSH Active</span>
            </div>
          )}
        </div>
      </header>

      {/* ?�션 ?�성 �??�면 분할 ?�어 메뉴 �?*/}
      <div className="h-11 bg-theme-base border-b border-theme-border/10 flex items-center justify-between px-4 shrink-0 z-10 gap-2">
        <div className="flex items-center gap-2">
          {/* ?�션 ?�성 ?�리�?*/}
          {/* ?션 ?성 ?리?*/}
          <button
            onClick={handleAddLocalSession}
            className="flex items-center gap-1.5 bg-theme-primary/20 hover:bg-theme-primary/40 border border-theme-primary/30 hover:border-theme-primary text-theme-text text-xs px-3 py-1.5 rounded transition font-semibold"
          >
            <Plus size={13} />
            <span>로컬 터미널 추가</span>
          </button>
          
          <button
            onClick={() => setShowSshModal(true)}
            className="flex items-center gap-1.5 bg-theme-accent/20 hover:bg-theme-accent/40 border border-theme-accent/30 hover:border-theme-accent text-theme-text text-xs px-3 py-1.5 rounded transition font-semibold"
          >
            <Plus size={13} />
            <span>SSH 터미널 추가</span>
          </button>
          
          <div className="w-px h-5 bg-theme-border/10 mx-1" />
        </div>

        {/* 구성 프로필 저장 및 복원 목록 */}
        <div className="flex items-center gap-2 text-xs">
          <button
            onClick={() => setShowProfileModal(true)}
            className="flex items-center gap-1.5 bg-theme-panel/40 hover:bg-theme-panel/80 border border-theme-border/10 text-theme-text px-3 py-1.5 rounded transition font-semibold"
          >
            <Save size={13} />
            <span>화면구성 저장</span>
          </button>

          {profiles.length > 0 && (
            <div className="flex items-center gap-1.5">
              <FolderOpen size={13} className="text-theme-muted" />
              <select
                value={selectedProfileName}
                onChange={(e) => handleLoadProfile(e.target.value)}
                className="bg-theme-surface border border-theme-border/10 rounded px-2 py-1 text-theme-text text-xs outline-none focus:border-indigo-500 font-mono"
              >
                <option value="" disabled>화면구성 선택...</option>
                {profiles.map(p => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
              {selectedProfileName && (
                <button
                  onClick={handleDeleteProfile}
                  className="hover:bg-rose-500/20 p-1 rounded text-theme-muted hover:text-rose-400 transition"
                  title="선택한 화면구성 삭제"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 메인 리사이저 패널 분할 영역 도입 */}
      <div className="flex-1 flex overflow-hidden min-h-0 relative">
        <Layout 
          ref={layoutRef}
          model={model} 
          factory={factory} 
          onAction={onAction}
          onRenderTab={onRenderTab}
          onModelChange={handleModelChange}
        />


        {activeSessionIds.filter(id => id.startsWith("local-") || id.startsWith("ssh-")).length === 0 && (
          <div className="absolute inset-0 z-10 pointer-events-none flex items-center justify-center">
            <div className="bg-theme-surface/80 backdrop-blur border border-theme-border/10 p-6 rounded-2xl shadow-2xl flex flex-col items-center gap-4 pointer-events-auto">
              <div className="flex flex-col items-center gap-2 mb-2">
                <Terminal size={32} className="text-theme-muted mb-1" />
                <h2 className="text-lg font-bold text-theme-text">활성화된 세션 없음</h2>
                <p className="text-xs text-theme-muted">새로운 로컬/SSH 세션을 생성하여 작업을 시작하세요.</p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={handleAddLocalSession}
                  className="flex items-center gap-2 bg-indigo-600/80 hover:bg-indigo-500 border border-indigo-500/50 text-white px-4 py-2.5 rounded-lg transition font-semibold shadow-lg shadow-indigo-500/20"
                >
                  <Plus size={16} />
                  <span>로컬 터미널 추가</span>
                </button>
                
                <button
                  onClick={() => setShowSshModal(true)}
                  className="flex items-center gap-2 bg-emerald-600/80 hover:bg-emerald-500 border border-emerald-500/50 text-white px-4 py-2.5 rounded-lg transition font-semibold shadow-lg shadow-emerald-500/20"
                >
                  <Plus size={16} />
                  <span>SSH 터미널 추가</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      </div>

      {/* ?�업 모달 1: SSH ?�규 ?�속 ?�력 ??모달 */}
      {showSshModal && (
        <div className="fixed inset-0 bg-theme-base/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4">
          <div className="bg-theme-surface border border-theme-border/10 rounded-xl w-full max-w-sm p-6 shadow-2xl flex flex-col gap-4 text-xs max-h-[90vh] overflow-y-auto">
            
            <div className="flex justify-between items-center border-b border-theme-border/5 pb-2">
              <h3 className="text-sm font-bold text-theme-text flex items-center gap-2">
                <Wifi size={16} className="text-emerald-400" />
                SSH Remote Connection
              </h3>
              <button 
                onClick={() => {
                  setShowSshModal(false);
                  setSshError("");
                }} 
                className="text-theme-muted hover:text-white transition"
              >
                <X size={16} />
              </button>
            </div>

            {sshProfiles.length > 0 && (
              <div className="flex items-center gap-2 mb-1">
                <select
                  value={selectedSshProfileName}
                  onChange={(e) => handleLoadSshProfile(e.target.value)}
                  className="flex-1 bg-theme-base border border-theme-border/10 rounded px-2 py-1.5 text-theme-text text-xs outline-none focus:border-indigo-500 font-mono"
                >
                  <option value="" disabled>저장된 연결 프로필 선택...</option>
                  {sshProfiles.map(p => (
                    <option key={p.name} value={p.name}>{p.name}</option>
                  ))}
                </select>
                {selectedSshProfileName && (
                  <button
                    onClick={handleDeleteSshProfile}
                    className="hover:bg-rose-500/20 p-1.5 rounded text-theme-muted hover:text-rose-400 transition border border-theme-border/5"
                    title="선택한 프로필 삭제"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            )}

            <form onSubmit={handleConnectSsh} className="flex flex-col gap-3.5">
              <div className="flex gap-2">
                <div className="flex-1 flex flex-col gap-1">
                  <label className="text-theme-muted">Host</label>
                  <input
                    type="text"
                    required
                    placeholder="127.0.0.1"
                    value={sshHost}
                    onChange={(e) => setSshHost(e.target.value)}
                    className="bg-theme-base border border-theme-border/10 rounded p-1.5 text-theme-text outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
                <div className="w-20 flex flex-col gap-1">
                  <label className="text-theme-muted">포트</label>
                  <input
                    type="number"
                    required
                    min="1"
                    max="65535"
                    value={sshPort}
                    onChange={(e) => setSshPort(parseInt(e.target.value))}
                    className="bg-theme-base border border-theme-border/10 rounded p-1.5 text-theme-text outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <div className="flex-1 flex flex-col gap-1">
                  <label className="text-theme-muted">계정명(User)</label>
                  <input
                    type="text"
                    required
                    placeholder="root"
                    value={sshUser}
                    onChange={(e) => setSshUser(e.target.value)}
                    className="bg-theme-base border border-theme-border/10 rounded p-1.5 text-theme-text outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
                <div className="flex-1 flex flex-col gap-1">
                  <label className="text-theme-muted">비밀번호</label>
                  <input
                    type="password"
                    placeholder="비밀번호 (선택)"
                    value={sshPass}
                    onChange={(e) => setSshPass(e.target.value)}
                    className="bg-theme-base border border-theme-border/10 rounded p-1.5 text-theme-text outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-theme-muted">개인키 경로 (Private Key) <span className="text-[10px] text-theme-muted">- 선택</span></label>
                <input
                  type="text"
                  placeholder="C:\Users\name\.ssh\id_rsa"
                  value={sshKeyPath}
                  onChange={(e) => setSshKeyPath(e.target.value)}
                  className="bg-theme-base border border-theme-border/10 rounded p-1.5 text-theme-text outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-theme-muted">시작 폴더 (Start Path)</label>
                <input
                  type="text"
                  placeholder="/home/ubuntu"
                  value={sshCwd}
                  onChange={(e) => setSshCwd(e.target.value)}
                  className="bg-theme-base border border-theme-border/10 rounded p-1.5 text-theme-text outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div className="flex gap-2 items-end">
                <div className="flex-1 flex flex-col gap-1">
                  <label className="text-theme-muted">프로필 저장명</label>
                  <input
                    type="text"
                    placeholder="프로필 이름 입력..."
                    value={newSshProfileName}
                    onChange={(e) => setNewSshProfileName(e.target.value)}
                    className="bg-theme-base border border-theme-border/10 rounded p-1.5 text-theme-text outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleSaveSshProfile}
                  className="bg-theme-panel hover:bg-slate-700 text-theme-text font-semibold py-1.5 px-3 rounded transition"
                >
                  <Save size={14} className="inline mr-1" />
                  저장
                </button>
              </div>

              {sshError && (
                <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 p-2 rounded flex items-center gap-1.5 mt-2">
                  <ShieldAlert size={14} className="shrink-0" />
                  <span className="truncate">접속 실패: {sshError}</span>
                </div>
              )}

              <div className="flex gap-2 border-t border-theme-border/5 pt-3 mt-1">
                <button
                  type="button"
                  onClick={() => {
                    setShowSshModal(false);
                    setSshError("");
                  }}
                  className="flex-1 bg-theme-panel hover:bg-slate-700 text-theme-text font-semibold py-2 rounded transition"
                >
                  취소
                </button>
                <button
                  type="submit"
                  className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-2 rounded transition"
                >
                  원격 서버 접속
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showProfileModal && (
        <div className="fixed inset-0 bg-theme-base/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4">

          <div className="bg-theme-surface border border-theme-border/10 rounded-xl w-full max-w-xs p-5 shadow-2xl flex flex-col gap-3 text-xs">
            <h4 className="font-bold text-theme-text text-sm">화면구성 저장</h4>
            
            <div className="flex flex-col gap-1">
              <label className="text-theme-muted">프로필 이름</label>
              <input
                type="text"
                required
                placeholder="예: 백엔드 개발 구성"
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                className="bg-theme-base border border-theme-border/10 rounded p-1.5 text-theme-text outline-none focus:border-indigo-500"
              />
            </div>

            <div className="flex gap-2 border-t border-theme-border/5 pt-3">
              <button
                type="button"
                onClick={() => {
                  setShowProfileModal(false);
                  setNewProfileName("");
                }}
                className="flex-1 bg-theme-panel hover:bg-slate-700 text-theme-text py-1.5 rounded transition"
              >
                취소
              </button>
              <button
                type="button"
                onClick={handleSaveProfile}
                className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white py-1.5 rounded transition"
              >
                저장
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;