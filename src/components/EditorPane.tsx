import React, { useEffect, useRef } from "react";
import Editor, { OnMount } from "@monaco-editor/react";
import { Save, CopyPlus } from "lucide-react";

// EditorPane 컴포넌트 프롭스 정의
interface EditorPaneProps {
  sessionId?: string;
  fontSize?: number;
  fileName: string;
  content: string;
  onChange: (value: string | undefined) => void;
  onSave?: () => void;
  onSaveAs?: () => void;
  onFocus?: () => void;
}

export const EditorPane: React.FC<EditorPaneProps> = ({
  
  fontSize = 13,
  fileName,
  content,
  onChange,
  onSave,
  onSaveAs,
  onFocus,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<any>(null);
  const isReadyRef = useRef<boolean>(false);

  // Monaco 에디터 마운트 시 핸들러
  const handleEditorDidMount: OnMount = (editor) => {
    editorRef.current = editor;
    if (content) {
      editor.setValue(content);
    }
    // 마운트 완료 즉시 레이아웃 강제 정렬
    editor.layout();
    
    // 마운트 완료 후 초기화 과정 중의 불필요한 synthetic 빈 값 이벤트를 차단하고 크기 정렬을 보장하기 위해 100ms 대기
    setTimeout(() => {
      if (editorRef.current) {
        editorRef.current.layout();
      }
      isReadyRef.current = true;
    }, 100);
  };

  // 사용자가 실제로 변경한 이벤트만 부모 상태로 전송
  const handleEditorChange = (value: string | undefined) => {
    if (isReadyRef.current) {
      onChange(value);
    }
  };

  // content prop이 외부에서 변경되었을 때 에디터 내용 동기화 (예: 파일 트리 클릭 시 갱신 유도)
  useEffect(() => {
    if (editorRef.current && content !== editorRef.current.getValue()) {
      editorRef.current.setValue(content);
    }
  }, [content]);

  // 에디터 폰트 크기 동적 업데이트
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.updateOptions({ fontSize });
    }
  }, [fontSize]);

  // 에디터 분할 창 리사이징 시 Monaco 캔버스 레이아웃 강제 갱신 (ResizeObserver 활용)
  useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      if (editorRef.current) {
        // Monaco Editor 레이아웃 재배치 (Flexbox 분할선 드래그 대응)
        editorRef.current.layout();
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  // Ctrl + S 저장 단축키 바인딩
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "s") {
        e.preventDefault();
        if (onSave) {
          onSave();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onSave]);

  // 파일 확장자에 따른 Monaco 구문 강조 매핑 함수
  const getLanguage = (name: string): string => {
    const ext = name.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "js":
      case "jsx":
        return "javascript";
      case "ts":
      case "tsx":
        return "typescript";
      case "css":
        return "css";
      case "html":
        return "html";
      case "json":
        return "json";
      case "rs":
        return "rust";
      case "py":
        return "python";
      case "md":
        return "markdown";
      default:
        return "plaintext";
    }
  };

  return (
    <div
      ref={containerRef}
      onClickCapture={onFocus}
      className="w-full h-full flex flex-col bg-theme-base/60 border border-theme-border/5 rounded-lg overflow-hidden"
    >
      {/* 에디터 헤더 툴바 */}
      <div className="bg-theme-surface/80 px-4 py-2 border-b border-theme-border/5 flex justify-between items-center text-xs">
        <span className="text-theme-text font-mono">📝 {fileName}</span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onSave}
            className="p-1.5 rounded bg-theme-primary/10 hover:bg-theme-primary/30 text-theme-primary-light hover:text-white transition-colors flex items-center justify-center border border-transparent hover:border-theme-primary-light/50"
            title="저장 (Ctrl + S)"
          >
            <Save size={16} />
          </button>
          <button
            onClick={onSaveAs}
            className="p-1.5 rounded bg-theme-accent/10 hover:bg-theme-accent/30 text-theme-accent hover:text-white transition-colors flex items-center justify-center border border-transparent hover:border-theme-accent/50"
            title="다른 이름으로 저장"
          >
            <CopyPlus size={16} />
          </button>
        </div>
      </div>

      {/* Monaco Editor 영역 */}
      <div className="flex-1 overflow-hidden relative">
        <Editor
          height="100%"
          language={getLanguage(fileName)}
          value={content}
          theme="vs-dark"
          onChange={handleEditorChange}
          onMount={handleEditorDidMount}
          options={{
            automaticLayout: true, // 크기 변경 감지 자동 활성화로 안정성 확보
            fontFamily: "D2Coding, 'Fira Code', Consolas, monospace",
            fontSize: fontSize,
            minimap: { enabled: false },
            scrollbar: {
              vertical: "visible",
              horizontal: "visible",
              verticalScrollbarSize: 6,
              horizontalScrollbarSize: 6,
            },
          }}
        />
      </div>
    </div>
  );
};
