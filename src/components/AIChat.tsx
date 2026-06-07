import React, { useState, useEffect, useRef } from "react";
import { 
  Send, TerminalSquare, 
  Bot, Sparkles, Play, Check, ChevronUp, ChevronDown,
  Settings, Paperclip, X, StopCircle, RefreshCw, AlertCircle, Download, Upload, Trash2
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";

interface AIChatProps {
  onInjectCommand: (command: string) => void;
  lastTerminalError: string;
  getActiveTerminalContent: (sessionId?: string) => string;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  activeTerminals?: { id: string; title: string }[];
  focusedSessionId?: string | null;
  fontSize?: number;
}

interface AttachedFile {
  name: string;
  size: number;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  isCommand?: boolean;
  attachedFiles?: AttachedFile[];
  terminalContext?: string;
}

export const AIChat: React.FC<AIChatProps> = ({
  onInjectCommand,
  lastTerminalError,
  getActiveTerminalContent,
  isCollapsed,
  onToggleCollapse,
  activeTerminals = [],
  focusedSessionId = null,
  fontSize = 13
}) => {
  const [messages, setMessages] = useState<Message[]>(() => {
    const saved = localStorage.getItem("terminal_avy_ai_messages");
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error("AI messages load error:", e);
      }
    }
    return [
      {
        id: "init",
        role: "assistant",
        content: "안녕하세요. 저는 작업을 돕는 AI 어시스턴트입니다.\n현재 터미널 상태를 분석하거나 명령어를 제안할 수 있습니다."
      }
    ];
  });
  const [input, setInput] = useState("");
  const [isInjecting, setIsInjecting] = useState<string | null>(null);
  const [includeContext, setIncludeContext] = useState(true);
  const [selectedTerminalId, setSelectedTerminalId] = useState<string>("");
  
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const abortTimeoutRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [aiModel, setAiModel] = useState(() => {
    return localStorage.getItem("terminal_avy_ai_model") || "claude-3-5";
  });
  const [apiKey, setApiKey] = useState(() => {
    return localStorage.getItem("terminal_avy_ai_apikey") || "";
  });
  const [baseUrl, setBaseUrl] = useState(() => {
    return localStorage.getItem("terminal_avy_ai_baseurl") || "https://api.openai.com/v1";
  });
  const [systemPrompt, setSystemPrompt] = useState(() => {
    return localStorage.getItem("terminal_avy_ai_system_prompt") || "";
  });
  
  const [availableModels, setAvailableModels] = useState<string[]>(() => {
    const saved = localStorage.getItem("terminal_avy_ai_model");
    const defaults = ["claude-3-5", "gpt-4o"];
    if (saved && !defaults.includes(saved)) return [...defaults, saved];
    return defaults;
  });
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [modelFetchError, setModelFetchError] = useState<string | null>(null);
  const [modelFetchSuccess, setModelFetchSuccess] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    localStorage.setItem("terminal_avy_ai_messages", JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    localStorage.setItem("terminal_avy_ai_model", aiModel);
  }, [aiModel]);

  useEffect(() => {
    localStorage.setItem("terminal_avy_ai_apikey", apiKey);
  }, [apiKey]);

  useEffect(() => {
    localStorage.setItem("terminal_avy_ai_baseurl", baseUrl);
  }, [baseUrl]);

  useEffect(() => {
    localStorage.setItem("terminal_avy_ai_system_prompt", systemPrompt);
  }, [systemPrompt]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isCollapsed]);

  // 포커스된 세션 ID가 변경되거나 터미널 목록이 변경될 때 선택값을 동기화
  useEffect(() => {
    if (focusedSessionId && activeTerminals.some(t => t.id === focusedSessionId)) {
      setSelectedTerminalId(focusedSessionId);
    } else if (activeTerminals.length > 0 && (!selectedTerminalId || !activeTerminals.some(t => t.id === selectedTerminalId))) {
      setSelectedTerminalId(activeTerminals[0].id);
    }
  }, [focusedSessionId, activeTerminals]);

  // 에러 발생 시 자동 팝업 및 컨텍스트 제안 (축소 상태일 때만)
  useEffect(() => {
    if (lastTerminalError && lastTerminalError.trim() !== "") {
      if (isCollapsed) {
        onToggleCollapse();
      }
      setMessages(prev => [
        ...prev,
        {
          id: Date.now().toString(),
          role: "assistant",
          content: `터미널에서 에러가 감지되었습니다:\n\`\`\`\n${lastTerminalError}\n\`\`\`\n\n이 문제를 해결하기 위한 명령어를 제안해 드릴까요?`
        }
      ]);
    }
  }, [lastTerminalError]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isGenerating) {
        if (abortTimeoutRef.current) {
          clearTimeout(abortTimeoutRef.current);
          abortTimeoutRef.current = null;
        }
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
        }
        setIsGenerating(false);
        setMessages(prev => [
          ...prev,
          {
            id: Date.now().toString(),
            role: "assistant",
            content: "[응답이 사용자에 의해 중단되었습니다.]"
          }
        ]);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isGenerating]);

  const fetchModels = async (isTest: boolean = false) => {
    if (!baseUrl) return;
    setIsFetchingModels(true);
    setModelFetchError(null);
    setModelFetchSuccess(null);
    try {
      const headers: Record<string, string> = {};
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
        method: "GET",
        headers
      });
      
      if (!response.ok) {
        throw new Error(`HTTP Error ${response.status}`);
      }
      
      const data = await response.json();
      if (data && Array.isArray(data.data)) {
        const models = data.data.map((m: any) => m.id);
        // 기본 모델과 병합 (중복 제거), 현재 선택된 모델도 보존
        const uniqueModels = Array.from(new Set(["claude-3-5", "gpt-4o", ...models]));
        setAvailableModels(prev => {
          const combined = Array.from(new Set([...uniqueModels, ...prev]));
          return combined;
        });
        setIsConnected(true);
        if (isTest) {
          setModelFetchSuccess(`연결 성공! ${models.length}개의 모델을 불러왔습니다.`);
        }
      } else {
        throw new Error("Invalid response format");
      }
    } catch (err: any) {
      console.error("Failed to fetch models:", err);
      setModelFetchError(err.message || "Failed to fetch models");
      setIsConnected(false);
    } finally {
      setIsFetchingModels(false);
    }
  };

  const handleSaveSettings = async () => {
    try {
      const filePath = await save({
        filters: [{ name: 'JSON', extensions: ['json'] }],
        defaultPath: 'ai_settings.json'
      });
      if (!filePath) return;

      const config = { baseUrl, apiKey, aiModel, systemPrompt };
      await invoke('write_local_file', { 
        path: filePath, 
        content: JSON.stringify(config, null, 2) 
      });
      setModelFetchSuccess("설정이 저장되었습니다.");
    } catch (err) {
      console.error("Save settings error:", err);
      setModelFetchError("설정 저장에 실패했습니다.");
    }
  };

  const handleLoadSettings = async () => {
    try {
      const filePath = await open({
        multiple: false,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (!filePath || Array.isArray(filePath)) return;

      const content = await invoke<string>('read_local_file', { path: filePath });
      const config = JSON.parse(content);
      
      if (config.baseUrl !== undefined) setBaseUrl(config.baseUrl);
      if (config.apiKey !== undefined) setApiKey(config.apiKey);
      if (config.aiModel !== undefined) {
        setAiModel(config.aiModel);
        // 불러온 모델이 리스트에 없으면 즉시 추가 (fetch 전에도 선택 가능하게)
        setAvailableModels(prev => {
          if (!prev.includes(config.aiModel)) {
            return [...prev, config.aiModel];
          }
          return prev;
        });
      }
      if (config.systemPrompt !== undefined) setSystemPrompt(config.systemPrompt);

      setModelFetchSuccess("설정을 불러왔습니다.");
      // URL이나 API Key가 로드되었다면 모델 목록도 갱신 시도
      if (config.baseUrl) {
        setTimeout(() => fetchModels(false), 100);
      }
    } catch (err) {
      console.error("Load settings error:", err);
      setModelFetchError("설정 불러오기에 실패했습니다.");
    }
  };

  const handleSend = async () => {
    if (!input.trim() && attachedFiles.length === 0) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input,
      attachedFiles: attachedFiles.length > 0 ? [...attachedFiles] : undefined,
      terminalContext: includeContext && selectedTerminalId ? getActiveTerminalContent(selectedTerminalId) : undefined
    };

    setMessages(prev => [...prev, userMessage]);
    setInput("");
    setAttachedFiles([]);
    setIsGenerating(true);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const aiMessageId = (Date.now() + 1).toString();
    setMessages(prev => [...prev, { id: aiMessageId, role: "assistant", content: "" }]);

    try {
      const apiMessages = [];
      if (systemPrompt) {
        apiMessages.push({ role: "system", content: systemPrompt });
      }

      // Convert local messages to API format
      messages.forEach(msg => {
        if (msg.id !== "init") {
          let content = msg.content;
          if (msg.role === "user" && msg.terminalContext) {
            content += `\n\n[Terminal Context]\n${msg.terminalContext}`;
          }
          apiMessages.push({ role: msg.role, content });
        }
      });

      // Append the new user message
      let finalUserContent = userMessage.content;
      if (userMessage.terminalContext) {
        finalUserContent += `\n\n[Terminal Context]\n${userMessage.terminalContext}`;
      }
      apiMessages.push({ role: "user", content: finalUserContent });

      const headers: Record<string, string> = {
        "Content-Type": "application/json"
      };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: aiModel,
          messages: apiMessages,
          stream: true
        }),
        signal: abortController.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP Error ${response.status}: ${await response.text()}`);
      }

      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let done = false;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || "";
          
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
              try {
                const data = JSON.parse(trimmed.slice(6));
                const deltaContent = data.choices?.[0]?.delta?.content || "";
                if (deltaContent) {
                  setMessages(prev => prev.map(m => 
                    m.id === aiMessageId ? { ...m, content: m.content + deltaContent } : m
                  ));
                }
              } catch (e) {
                // ignore JSON parse errors for incomplete chunks
              }
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // 이미 ESC나 중단 버튼에서 메시지 처리를 했음
      } else {
        console.error("AI API Error:", err);
        setMessages(prev => prev.map(m => 
          m.id === aiMessageId ? { ...m, content: m.content + `\n\n[에러 발생: ${err.message}]` } : m
        ));
      }
    } finally {
      setIsGenerating(false);
      abortControllerRef.current = null;
    }
  };

  const handleInject = (command: string, msgId: string) => {
    setIsInjecting(msgId);
    onInjectCommand(command);
    setTimeout(() => {
      setIsInjecting(null);
    }, 1500);
  };

  const renderMessageContent = (msg: Message) => {
    // 마크다운 코드 블록 파싱 (```언어 ... ```)
    const parts = msg.content.split(/(```[\w]*\n[\s\S]*?```)/g);

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "6px", width: "100%" }}>
        {parts.map((part, idx) => {
          if (part.startsWith('```') && part.endsWith('```')) {
            const lines = part.split('\n');
            const lang = (lines.shift() || '').replace('```', '').trim();
            lines.pop();
            const cmd = lines.join('\n').trim();
            if (!cmd) return null;
            return (
              <div key={idx} style={{
                position: "relative",
                background: "rgba(13,17,23,0.85)",
                border: "1px solid rgba(255,255,255,0.10)",
                borderRadius: "6px",
                overflow: "hidden",
                margin: "4px 0"
              }} className="group">
                {/* Lang header */}
                {lang && (
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "4px 10px",
                    background: "rgba(255,255,255,0.04)",
                    borderBottom: "1px solid rgba(255,255,255,0.07)"
                  }}>
                    <span style={{ fontSize: "10px", color: "#8b949e", fontFamily: "inherit", letterSpacing: "0.05em" }}>{lang}</span>
                  </div>
                )}
                <div style={{
                  padding: "10px 12px",
                  fontFamily: "inherit",
                  fontSize: "0.9em",
                  color: "#e6edf3",
                  overflowX: "auto",
                  whiteSpace: "pre",
                  lineHeight: 1.6
                }}>
                  {cmd}
                </div>
                <button
                  onClick={() => handleInject(cmd, msg.id + idx)}
                  style={{
                    position: "absolute",
                    right: "8px",
                    top: lang ? "30px" : "8px",
                    display: "flex",
                    alignItems: "center",
                    gap: "5px",
                    padding: "3px 10px",
                    borderRadius: "4px",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                    border: "none",
                    transition: "all 0.15s",
                    ...(isInjecting === msg.id + idx
                      ? { background: "rgba(34,197,94,0.20)", color: "#4ade80" }
                      : { background: "rgba(99,102,241,0.85)", color: "#fff" })
                  }}
                  className="opacity-0 group-hover:opacity-100"
                >
                  {isInjecting === msg.id + idx ? (
                    <><Check size={12} /> <span>실행됨</span></>
                  ) : (
                    <><Play size={12} /> <span>실행</span></>
                  )}
                </button>
              </div>
            );
          } else if (part.trim() !== '') {
            const formatted = part.split(/(`[^`]+`)/g).map((subPart, i) => {
              if (subPart.startsWith('`') && subPart.endsWith('`')) {
                return (
                  <code key={i} style={{
                    padding: "1px 6px",
                    margin: "0 2px",
                    background: "rgba(110,118,129,0.18)",
                    border: "1px solid rgba(110,118,129,0.3)",
                    borderRadius: "4px",
                    fontSize: "0.88em",
                    color: "#79c0ff",
                    fontFamily: "inherit"
                  }}>
                    {subPart.slice(1, -1)}
                  </code>
                );
              }
              return <span key={i}>{subPart}</span>;
            });

            return (
              <div key={idx} style={{
                lineHeight: 1.7,
                color: msg.role === "user" ? "#e6edf3" : "#c9d1d9",
                whiteSpace: "pre-wrap",
                fontSize: "inherit"
              }}>
                {formatted}
              </div>
            );
          }
          return null;
        })}
        {msg.terminalContext && (
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: "5px",
            fontSize: "10px",
            color: "#8b949e",
            background: "rgba(255,255,255,0.04)",
            padding: "3px 8px",
            borderRadius: "4px",
            width: "fit-content",
            marginTop: "4px"
          }}>
            <TerminalSquare size={10} />
            <span>터미널 컨텍스트 포함됨</span>
          </div>
        )}
      </div>
    );
  };

  if (isCollapsed) {
    return (
      <div 
        onClick={onToggleCollapse}
        className="w-full h-full flex items-center justify-between px-4 bg-theme-surface border-t border-theme-border/10 cursor-pointer hover:bg-theme-panel/80 transition-all group select-none"
      >
        <div className="flex items-center gap-3 text-theme-muted group-hover:text-theme-text transition-colors">
          <Sparkles size={16} className="text-theme-primary" />
          <span className="font-semibold text-sm">AI 어시스턴트에게 질문하기...</span>
        </div>
        <ChevronUp size={16} className="text-theme-muted group-hover:text-theme-text transition-colors" />
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full h-full bg-theme-base shadow-2xl rounded-t-xl border border-theme-border/10 overflow-hidden font-ui" style={{ fontSize: `${fontSize}px` }}>
      {/* AI 헤더 */}
      <div className="h-12 border-b border-theme-border/5 bg-theme-surface flex items-center justify-between px-4 shrink-0 select-none relative z-10">
        <div className="flex items-center gap-2">
          <div className={`w-6 h-6 rounded-md flex items-center justify-center border ${
            isConnected
              ? "bg-emerald-500/20 border-emerald-500/40"
              : "bg-blue-500/20 border-blue-500/40"
          }`}>
            <Sparkles size={13} className={isConnected ? "text-emerald-400" : "text-blue-400"} />
          </div>
          <span className="font-bold text-sm text-theme-text">AI Assistant</span>
        </div>
        
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              if (window.confirm("대화 내역을 모두 초기화하시겠습니까?")) {
                setMessages([
                  {
                    id: "init",
                    role: "assistant",
                    content: "안녕하세요. 저는 작업을 돕는 AI 어시스턴트입니다.\n현재 터미널 상태를 분석하거나 명령어를 제안할 수 있습니다."
                  }
                ]);
              }
            }}
            className="p-1.5 hover:bg-theme-border/10 rounded-md text-theme-muted hover:text-rose-400 transition"
            title="대화 초기화"
          >
            <Trash2 size={15} />
          </button>
          <button 
            onClick={() => setIsSettingsOpen(!isSettingsOpen)}
            className={`p-1.5 rounded-md transition ${isSettingsOpen ? "bg-theme-primary/20 text-theme-primary" : "hover:bg-theme-border/10 text-theme-muted"}`}
            title="AI 설정"
          >
            <Settings size={15} />
          </button>
          <button 
            onClick={onToggleCollapse}
            className="p-1.5 hover:bg-theme-border/10 rounded-md text-theme-muted transition"
            title="접기"
          >
            <ChevronDown size={16} />
          </button>
        </div>

        {/* 설정 패널 */}
        {isSettingsOpen && (
          <div className="absolute top-full right-4 mt-2 w-64 bg-theme-surface border border-theme-border/20 shadow-xl rounded-lg p-3 flex flex-col gap-3 z-50">
            <div className="flex justify-between items-center pb-2 border-b border-theme-border/10">
              <span className="text-sm font-semibold text-theme-text">AI 설정</span>
              <button onClick={() => setIsSettingsOpen(false)} className="text-theme-muted hover:text-theme-text">
                <X size={14} />
              </button>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-theme-muted">Base URL</label>
              <div className="flex gap-1">
                <input 
                  type="text" 
                  value={baseUrl} 
                  onChange={e => setBaseUrl(e.target.value)}
                  placeholder="http://localhost:1234/v1"
                  className="flex-1 bg-theme-base border border-theme-border/10 rounded text-xs text-theme-text p-1.5 outline-none min-w-0"
                />
                <button
                  onClick={() => fetchModels(false)}
                  disabled={isFetchingModels}
                  className="shrink-0 p-1.5 bg-theme-panel hover:bg-theme-panel/80 rounded disabled:opacity-50 transition"
                  title="모델 새로고침"
                >
                  <RefreshCw size={14} className={`text-theme-text ${isFetchingModels ? "animate-spin" : ""}`} />
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-theme-muted">API Key</label>
              <input 
                type="password" 
                value={apiKey} 
                onChange={e => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="bg-theme-base border border-theme-border/10 rounded text-xs text-theme-text p-1.5 outline-none"
              />
              <button
                onClick={() => fetchModels(true)}
                disabled={isFetchingModels}
                className="mt-1 w-full bg-theme-panel hover:bg-theme-panel/80 disabled:opacity-50 text-theme-text text-xs font-semibold py-1.5 rounded transition border border-theme-border/10"
              >
                {isFetchingModels ? "테스트 중..." : "연결 테스트"}
              </button>
            </div>
            {modelFetchError && (
              <div className="flex items-center gap-1.5 text-[10px] text-red-400 bg-red-500/10 p-1.5 rounded border border-red-500/20">
                <AlertCircle size={12} className="shrink-0" />
                <span className="truncate">{modelFetchError}</span>
              </div>
            )}
            {modelFetchSuccess && (
              <div className="flex items-center gap-1.5 text-[10px] text-emerald-400 bg-emerald-500/10 p-1.5 rounded border border-emerald-500/20">
                <Check size={12} className="shrink-0" />
                <span className="truncate">{modelFetchSuccess}</span>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-theme-muted">모델</label>
              <select 
                value={aiModel} 
                onChange={e => setAiModel(e.target.value)}
                className="bg-theme-base border border-theme-border/10 rounded text-xs text-theme-text p-1.5 outline-none w-full"
              >
                {availableModels.map(model => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-theme-muted">시스템 프롬프트</label>
              <textarea 
                value={systemPrompt} 
                onChange={e => setSystemPrompt(e.target.value)}
                placeholder="You are a helpful coding assistant..."
                className="bg-theme-base border border-theme-border/10 rounded text-xs text-theme-text p-1.5 outline-none resize-none h-16"
              />
            </div>
            <div className="flex gap-2 mt-1 pt-3 border-t border-theme-border/10">
              <button 
                onClick={handleLoadSettings}
                className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-theme-panel hover:bg-theme-panel/80 rounded text-xs font-semibold text-theme-text transition border border-theme-border/10"
              >
                <Upload size={14} /> <span>불러오기</span>
              </button>
              <button 
                onClick={handleSaveSettings}
                className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-theme-panel hover:bg-theme-panel/80 rounded text-xs font-semibold text-theme-text transition border border-theme-border/10"
              >
                <Download size={14} /> <span>저장하기</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 대화 영역 - Claude Code 스타일 */}
      <div
        className="flex-1 overflow-y-auto custom-scrollbar"
        style={{
          fontSize: `${fontSize}px`,
          fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
          background: "var(--theme-base, #0d1117)",
          padding: "0"
        }}
      >
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              borderBottom: "1px solid rgba(255,255,255,0.15)",
              padding: "14px 16px 12px"
            }}
          >
            {/* Role header line */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                marginBottom: "6px"
              }}
            >
              {msg.role === "assistant" ? (
                <>
                  <Bot size={13} style={{ color: "#7c8cf8", flexShrink: 0 }} />
                  <span style={{
                    fontSize: "11px",
                    fontWeight: 700,
                    color: "#7c8cf8",
                    letterSpacing: "0.04em",
                    textTransform: "uppercase"
                  }}>
                    {aiModel}
                  </span>
                </>
              ) : (
                <>
                  <span style={{
                    fontSize: "11px",
                    fontWeight: 700,
                    color: "#e6edf3",
                    letterSpacing: "0.04em",
                    opacity: 0.7
                  }}>❯</span>
                  <span style={{
                    fontSize: "11px",
                    fontWeight: 700,
                    color: "#e6edf3",
                    letterSpacing: "0.04em"
                  }}>You</span>
                </>
              )}
            </div>

            {/* Attached files */}
            {msg.attachedFiles && msg.attachedFiles.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "6px" }}>
                {msg.attachedFiles.map((file, idx) => (
                  <div key={idx} style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "5px",
                    background: "rgba(124,140,248,0.10)",
                    border: "1px solid rgba(124,140,248,0.25)",
                    borderRadius: "4px",
                    padding: "2px 8px",
                    fontSize: "11px",
                    color: "#a5b4fc"
                  }}>
                    <Paperclip size={11} />
                    <span style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={file.name}>{file.name}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Message content */}
            <div style={{ paddingLeft: "21px" }}>
              {renderMessageContent(msg)}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* 프롬프트 입력 영역 */}
      <div className="shrink-0 p-3 bg-theme-surface border-t border-theme-border/10 flex flex-col gap-2">
        
        {/* 컨텍스트 토글 및 도구 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            overflowX: "auto",
            gap: "8px",
            padding: "0 4px",
            flexWrap: "nowrap",
            minWidth: 0
          }}
          className="custom-scrollbar"
        >
          <button 
            onClick={() => setIncludeContext(!includeContext)}
            style={{ flexShrink: 0 }}
            className={`flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1 rounded transition
              ${includeContext 
                ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30" 
                : "bg-theme-panel text-theme-muted border border-theme-border/10 hover:text-theme-text"}`}
          >
            <TerminalSquare size={12} />
            {includeContext ? "컨텍스트 포함" : "컨텍스트 제외"}
          </button>
          {includeContext && activeTerminals.length > 0 && (
            <select
              value={selectedTerminalId}
              onChange={(e) => setSelectedTerminalId(e.target.value)}
              style={{ flexShrink: 0 }}
              className="bg-theme-panel border border-theme-border/10 rounded text-[11px] text-theme-text p-1 outline-none h-[26px] max-w-[150px] truncate"
            >
              {activeTerminals.map(t => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </select>
          )}
          <span style={{ flexShrink: 0, marginLeft: "auto" }} className="text-[10px] text-theme-muted/70 font-mono whitespace-nowrap">
            Enter↵ / Shift+Enter↩
          </span>
        </div>

        {/* 첨부된 파일 목록 표시 */}
        {attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 px-1 mb-1">
            {attachedFiles.map((file, idx) => (
              <div key={idx} className="flex items-center gap-1.5 bg-indigo-500/20 border border-indigo-500/30 rounded-full pl-2.5 pr-1 py-0.5 text-[11px] text-indigo-200">
                <Paperclip size={10} className="text-indigo-400" />
                <span className="truncate max-w-[100px]">{file.name}</span>
                <button 
                  onClick={() => setAttachedFiles(prev => prev.filter((_, i) => i !== idx))}
                  className="hover:bg-indigo-500/30 p-0.5 rounded-full text-indigo-400 transition"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 입력 폼 */}
        <div className="relative group">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="메시지를 입력하세요... (Enter: 전송, Shift+Enter: 줄바꿈)"
            className="w-full bg-theme-panel border border-theme-border/20 focus:border-theme-primary/50 rounded-lg pl-9 pr-10 py-3 text-sm text-theme-text outline-none resize-none min-h-[50px] max-h-[150px] transition-all custom-scrollbar placeholder:text-theme-muted/50 shadow-inner"
            style={{
              fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
              height: "auto",
              minHeight: "52px",
              fontSize: `${fontSize}px`
            }}
            rows={1}
          />
          
          <input 
            type="file" 
            multiple 
            className="hidden" 
            id="file-upload" 
            onChange={(e) => {
              if (e.target.files) {
                const newFiles = Array.from(e.target.files).map(f => ({ name: f.name, size: f.size }));
                setAttachedFiles(prev => [...prev, ...newFiles]);
                e.target.value = '';
              }
            }}
          />
          <label 
            htmlFor="file-upload"
            className="absolute left-2 top-2.5 p-1.5 text-theme-muted hover:text-theme-text hover:bg-theme-border/10 rounded-md cursor-pointer transition"
            title="파일 첨부"
          >
            <Paperclip size={15} />
          </label>

          {isGenerating ? (
            <button
              onClick={() => {
                if (abortTimeoutRef.current) {
                  clearTimeout(abortTimeoutRef.current);
                  abortTimeoutRef.current = null;
                }
                if (abortControllerRef.current) {
                  abortControllerRef.current.abort();
                  abortControllerRef.current = null;
                }
                setIsGenerating(false);
                setMessages(prev => [
                  ...prev,
                  {
                    id: Date.now().toString(),
                    role: "assistant",
                    content: "[응답이 사용자에 의해 중단되었습니다.]"
                  }
                ]);
              }}
              className="absolute right-2 bottom-2.5 p-1.5 bg-red-500/20 hover:bg-red-500/40 text-red-400 border border-red-500/30 rounded-md transition"
              title="생성 중단 (ESC)"
            >
              <StopCircle size={15} />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={(!input.trim() && attachedFiles.length === 0)}
              className="absolute right-2 bottom-2.5 p-1.5 bg-theme-primary hover:bg-theme-primary-light disabled:bg-theme-panel disabled:text-theme-muted/40 text-white rounded-md transition shadow-lg"
            >
              <Send size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};