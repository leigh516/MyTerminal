import React, { useState, useEffect, useRef } from "react";
import { Copy, Scissors, ClipboardPaste, Trash, Download, Terminal } from "lucide-react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { tempDir } from "@tauri-apps/api/path";
import { FilePaneView, FileNode } from "./FilePaneView";

interface FileTreeProps {
  activeSessionId: string;
  sshSessions?: any[];
  onFileSelect: (filePath: string, fileName: string, isRemote: boolean) => void;
  onOpenTerminal?: (path: string, isRemote: boolean, sourceSessionId: string) => void;
}

export const FileTree: React.FC<FileTreeProps> = ({
  activeSessionId: defaultSshId,
  sshSessions = [],
  onFileSelect,
  onOpenTerminal,
}) => {
  const [viewMode, setViewMode] = useState<"local" | "split">("split");
  const [pane1Session, setPane1Session] = useState<string>("local");
  const [pane2Session, setPane2Session] = useState<string>(defaultSshId || "local");

  useEffect(() => {
    if (defaultSshId && pane2Session === "local") {
      setPane2Session(defaultSshId);
    }
  }, [defaultSshId]);

  const [transferProgress, setTransferProgress] = useState<number | null>(null);

  const dragStartDetected = useRef<boolean>(false);
  const [selectedNodes, setSelectedNodes] = useState<Set<string>>(new Set());
  const [lastSelectedNode, setLastSelectedNode] = useState<{ file: FileNode; sourceId: string } | null>(null);
  const [focusedNode, setFocusedNode] = useState<{ path: string; sourceId: string } | null>(null);




  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: FileNode; sourceId: string; currentPath: string; isBackground?: boolean } | null>(null);
  const [clipboardFiles, setClipboardFiles] = useState<{ files: FileNode[]; sourceId: string; action: "copy" | "cut" } | null>(null);

  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null);
    window.addEventListener("click", handleClickOutside);
    return () => window.removeEventListener("click", handleClickOutside);
  }, []);

  const handleDragStart = (e: React.DragEvent, file: FileNode, sourceId: string, availableFiles?: FileNode[]) => {
    dragStartDetected.current = true;
    const itemKey = `${sourceId}:${file.path}`;
    
    let isMulti = false;
    let dragTargets = [file];
    
    if (selectedNodes.has(itemKey)) {
      const selectedArr = Array.from(selectedNodes)
        .filter(k => k.startsWith(`${sourceId}:`))
        .map(k => k.substring(sourceId.length + 1));
      if (selectedArr.length > 1) {
        isMulti = true;
        dragTargets = selectedArr.map(p => {
          const found = availableFiles?.find(f => f.path === p);
          return { name: p.split(/[\\/]/).pop() || "", path: p, isDir: found ? found.isDir : false };
        });
      }
    } else {
      setSelectedNodes(new Set([itemKey]));
      setLastSelectedNode({ file, sourceId });
    }

    const dragData = { sourceId, isMulti, files: dragTargets };
    e.dataTransfer.setData("text/plain", JSON.stringify(dragData));
    e.dataTransfer.effectAllowed = "copyMove";
  };

  const handleDrag = (_e: React.DragEvent) => {
    // Unused
  };

  const handleDragEnd = () => {
    dragStartDetected.current = false;
  };

  const performSftpTransfer = async (
    sessionId: string,
    direction: "upload" | "download",
    localPath: string,
    remotePath: string
  ) => {
    setTransferProgress(0);
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen(`sftp-progress-${sessionId}`, (event: any) => {
      setTransferProgress(event.payload as number);
    });
    try {
      await invoke("sftp_transfer_file", {
        sessionId,
        direction,
        localPath,
        remotePath,
      });
    } finally {
      unlisten();
      setTransferProgress(null);
    }
  };

  const transferRecursive = async (sourceFile: FileNode, sourceSession: string, targetSession: string, destPath: string) => {
    const sourceIsLocal = sourceSession === "local";
    const targetIsLocal = targetSession === "local";
    
    if (sourceFile.isDir) {
      if (targetIsLocal) {
        await invoke("create_local_dir", { path: destPath });
      } else {
        await invoke("sftp_create_dir", { sessionId: targetSession, path: destPath });
      }
      
      const children: FileNode[] = sourceIsLocal
        ? await invoke("read_local_dir", { path: sourceFile.path })
        : await invoke("sftp_read_dir", { sessionId: sourceSession, remotePath: sourceFile.path });
        
      for (const child of children) {
        const separator = targetIsLocal ? "\\" : "/";
        const childDestPath = destPath + separator + child.name;
        const cleanChildDestPath = targetIsLocal ? childDestPath.replace(/\/+/g, "\\") : childDestPath.replace(/\/+/g, "/");
        await transferRecursive(child, sourceSession, targetSession, cleanChildDestPath);
      }
    } else {
      if (sourceIsLocal && targetIsLocal) {
         await invoke("copy_local_item", { src: sourceFile.path, dest: destPath });
      } else if (sourceIsLocal && !targetIsLocal) {
        await performSftpTransfer(targetSession, "upload", sourceFile.path, destPath.replace(/\\/g, "/"));
      } else if (!sourceIsLocal && targetIsLocal) {
        await performSftpTransfer(sourceSession, "download", destPath.replace(/\//g, "\\"), sourceFile.path.replace(/\\/g, "/"));
      } else if (!sourceIsLocal && !targetIsLocal && sourceSession !== targetSession) {
        // SSH to SSH
        const msg = "로컬 임시 폴더를 경유하여 서버간 복사/이동합니다. 네트워크 상황에 따라 속도가 원활하지 않을 수 있습니다. 계속하시겠습니까?";
        if (!window.confirm(msg)) return;
        const tmp = await tempDir();
        const tmpFile = `${tmp}\\${sourceFile.name}`;
        await performSftpTransfer(sourceSession, "download", tmpFile, sourceFile.path.replace(/\\/g, "/"));
        await performSftpTransfer(targetSession, "upload", tmpFile, destPath.replace(/\\/g, "/"));
        await invoke("remove_local_item", { path: tmpFile });
      } else if (!sourceIsLocal && !targetIsLocal && sourceSession === targetSession) {
        // Same SSH session copy
        await invoke("ssh_exec_command", { sessionId: sourceSession, command: `cp -r "${sourceFile.path}" "${destPath}"` });
      }
    }
  };

  const handleDropItem = async (e: React.DragEvent, targetSessionId: string, targetPath: string, _isDir: boolean) => {
    try {
      dragStartDetected.current = false;
      const dataStr = e.dataTransfer.getData("text/plain");
      if (!dataStr) {
        // External drop handling
        const files = e.dataTransfer.files;
        if (!files || files.length === 0) return;
        
        let actualTargetPath = targetPath;
        if (!_isDir) {
           const sep = targetSessionId === "local" ? "\\" : "/";
           const parts = targetPath.split(/[\\/]/);
           parts.pop();
           actualTargetPath = parts.join(sep);
        }

        const newSelections = new Set<string>();
        for (let i = 0; i < files.length; i++) {
          const file = files[i] as any;
          if (file.path) {
            const destPath = targetSessionId === "local" 
              ? `${actualTargetPath}\\${file.name}`.replace(/\\\\+/g, "\\")
              : `${actualTargetPath}/${file.name}`.replace(/\/+/g, "/");
            if (targetSessionId === "local") {
              await invoke("copy_local_item", { src: file.path, dest: destPath });
            } else {
              await performSftpTransfer(targetSessionId, "upload", file.path, destPath);
            }
            newSelections.add(`${targetSessionId}:${destPath}`);
          }
        }
        setSelectedNodes(newSelections);
        window.dispatchEvent(new CustomEvent('refresh_file_tree'));
        return;
      }
      
      const dragData = JSON.parse(dataStr);
      if (!dragData.sourceId) return;

      const sourceSession = dragData.sourceId;
      const items = dragData.isMulti ? dragData.files : [dragData.files[0]];
      
      let actualTargetPath = targetPath;
      if (!_isDir) {
         const sep = targetSessionId === "local" ? "\\" : "/";
         const parts = targetPath.split(/[\\/]/);
         parts.pop();
         actualTargetPath = parts.join(sep);
      }

      const newSelections = new Set<string>();
      for (const item of items) {
        const destPath = targetSessionId === "local"
          ? `${actualTargetPath}\\${item.name}`.replace(/\\\\+/g, "\\")
          : `${actualTargetPath}/${item.name}`.replace(/\/+/g, "/");
        
        if (item.path === destPath && sourceSession === targetSessionId) continue;
        await transferRecursive(item as FileNode, sourceSession, targetSessionId, destPath);
        newSelections.add(`${targetSessionId}:${destPath}`);
      }
      
      setSelectedNodes(newSelections);
      
      // 모든 작업 완료 후 트리의 폴더들 새로고침
      window.dispatchEvent(new CustomEvent('refresh_file_tree'));
    } catch (err: any) {
      console.error("드롭 실패:", err);
      alert(`파일 드롭 실패: ${err.message || err.toString()}`);
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDragOver = (e: React.DragEvent, _path: string, _isDir: boolean, _sessionId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleContextMenu = (e: React.MouseEvent, file: FileNode, sourceId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const itemKey = `${sourceId}:${file.path}`;
    if (!selectedNodes.has(itemKey)) {
      setSelectedNodes(new Set([itemKey]));
      setLastSelectedNode({ file, sourceId });
    }
    setFocusedNode({ path: file.path, sourceId });
    setContextMenu({ x: e.clientX, y: e.clientY, file, sourceId, currentPath: file.path });
  };

  const handleBackgroundContextMenu = (e: React.MouseEvent, sourceId: string, currentPath: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      file: { name: "", path: currentPath, isDir: true },
      sourceId,
      currentPath,
      isBackground: true
    });
  };

  const getSelectedFiles = (sourceId: string) => {
    const arr = Array.from(selectedNodes)
      .filter(k => k.startsWith(`${sourceId}:`))
      .map(k => k.substring(sourceId.length + 1));
    return arr.map(p => ({ name: p.split(/[\\/]/).pop() || "", path: p, isDir: false }));
  };

  const handleCopy = () => {
    if (contextMenu) {
      let targets = getSelectedFiles(contextMenu.sourceId);
      if (targets.length === 0) targets = [contextMenu.file];
      setClipboardFiles({ files: targets, sourceId: contextMenu.sourceId, action: "copy" });
    }
    setContextMenu(null);
  };

  const handleCut = () => {
    if (contextMenu) {
      let targets = getSelectedFiles(contextMenu.sourceId);
      if (targets.length === 0) targets = [contextMenu.file];
      setClipboardFiles({ files: targets, sourceId: contextMenu.sourceId, action: "cut" });
    }
    setContextMenu(null);
  };

  const handleDelete = async () => {
    if (!contextMenu) return;
    const { sourceId } = contextMenu;
    const session = sourceId;
    let targets = getSelectedFiles(sourceId);
    if (targets.length === 0) targets = [contextMenu.file];

    const confirmDelete = window.confirm(`정말로 선택된 ${targets.length}개의 항목을 삭제하시겠습니까?`);
    if (!confirmDelete) {
        setContextMenu(null);
        return;
    }
    try {
      if (session === "local") {
        for (const file of targets) {
          await invoke("remove_local_item", { path: file.path });
        }
      } else {
        for (const file of targets) {
          await invoke("sftp_remove_item", { sessionId: session, remotePath: file.path });
        }
      }
      window.dispatchEvent(new CustomEvent('refresh_file_tree'));
    } catch (e) {
      alert("삭제 실패: " + e);
    }
    setContextMenu(null);
  };

  const handlePaste = async () => {
    if (!clipboardFiles || !contextMenu) return;
    const targetSession = contextMenu.sourceId;
    const sourceSession = clipboardFiles.sourceId;
    
    let targetPath = contextMenu.currentPath;
    if (!contextMenu.isBackground && !contextMenu.file.isDir) {
      const sep = targetSession === "local" ? "\\" : "/";
      const parts = targetPath.split(/[\\/]/);
      parts.pop();
      targetPath = parts.join(sep);
    }

    try {
      const newSelections = new Set<string>();
      for (const file of clipboardFiles.files) {
        const destPath = targetSession === "local"
          ? `${targetPath}\\${file.name}`.replace(/\\\\+/g, "\\")
          : `${targetPath}/${file.name}`.replace(/\/+/g, "/");
        
        await transferRecursive(file, sourceSession, targetSession, destPath);
        newSelections.add(`${targetSession}:${destPath}`);
        
        if (clipboardFiles.action === "cut") {
          if (sourceSession === "local") {
            await invoke("remove_local_item", { path: file.path });
          } else {
            await invoke("sftp_remove_item", { sessionId: sourceSession, remotePath: file.path });
          }
        }
      }
      setSelectedNodes(newSelections);
      if (clipboardFiles.action === "cut") setClipboardFiles(null);
      window.dispatchEvent(new CustomEvent('refresh_file_tree'));
    } catch (e) {
      console.error("붙여넣기 실패:", e);
      alert("붙여넣기 실패: " + e);
    }
    setContextMenu(null);
  };

  const handleDownload = async () => {
    if (!contextMenu) return;
    const session = contextMenu.sourceId;
    let targets = getSelectedFiles(contextMenu.sourceId);
    if (targets.length === 0) targets = [contextMenu.file];

    try {
      if (targets.length === 1 && !targets[0].isDir) {
        const savePath = await save({ defaultPath: targets[0].name });
        if (savePath) {
          if (session !== "local") {
            await performSftpTransfer(session, "download", savePath, targets[0].path);
          } else {
            await invoke("copy_local_item", { src: targets[0].path, dest: savePath });
          }
        }
      } else {
        const saveDir = await open({ directory: true, multiple: false });
        if (saveDir && typeof saveDir === 'string') {
          for (const file of targets) {
            const destPath = saveDir + "\\" + file.name;
            await transferRecursive(file, session, "local", destPath);
          }
        }
      }
    } catch (e) {
      alert("다운로드/저장 실패: " + e);
    }
    setContextMenu(null);
  };

  const handleOpenTerminal = () => {
    if (contextMenu && onOpenTerminal) {
      let targetPath = contextMenu.currentPath;
      if (!contextMenu.isBackground && !contextMenu.file.isDir) {
        const sep = contextMenu.sourceId.startsWith("local") ? "\\" : "/";
        const parts = targetPath.split(/[\\/]/);
        parts.pop();
        targetPath = parts.join(sep);
      }
      const sourceSession = contextMenu.sourceId || "local";
      const isRemote = sourceSession !== "local";
      onOpenTerminal(targetPath, isRemote, sourceSession);
      setContextMenu(null);
    }
  };

  return (
    <div className="w-full h-full flex flex-col bg-theme-surface/60 text-theme-text text-sm overflow-hidden select-none font-ui relative">
      <div className="px-4 py-2 bg-theme-base border-b border-theme-border/10 flex gap-4 items-center shrink-0">
        <div className="flex bg-theme-surface rounded p-0.5 border border-theme-border/10">
          <button 
            onClick={() => setViewMode("local")} 
            title="로컬만 보기"
            className={`px-3 py-1 rounded-sm text-xs font-semibold transition ${viewMode === "local" ? "bg-theme-primary text-white" : "text-theme-muted hover:text-theme-text"}`}>
            💻
          </button>
          <button 
            onClick={() => setViewMode("split")} 
            title="상하 분할 보기"
            className={`px-3 py-1 rounded-sm text-xs font-semibold transition ${viewMode === "split" ? "bg-theme-primary text-white" : "text-theme-muted hover:text-theme-text"}`}>
            💻<span className="opacity-50 mx-1">↔</span>🌐
          </button>
        </div>
      </div>

      <FilePaneView
        paneId="pane1"
        sessionId={pane1Session}
        onSessionChange={setPane1Session}
        sessions={[{ id: "local", title: "💻 로컬 탐색기", type: "local" }, ...sshSessions.map(s => ({ id: s.id, title: s.title, type: "ssh", cwd: s.cwd }))]}
        onFileSelect={onFileSelect}
        dragStartDetected={dragStartDetected}
        selectedNodes={selectedNodes}
        setSelectedNodes={setSelectedNodes}
        lastSelectedNode={lastSelectedNode}
        setLastSelectedNode={setLastSelectedNode}
        focusedNode={focusedNode}
        setFocusedNode={setFocusedNode}
        onDragStart={handleDragStart}
        onDrag={handleDrag}
        onDragEnd={handleDragEnd}
        onDropItem={handleDropItem}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onContextMenu={handleContextMenu}
        onBackgroundContextMenu={handleBackgroundContextMenu}
        transferProgress={transferProgress}
      />

      {viewMode === "split" && (
        <FilePaneView
          paneId="pane2"
          sessionId={pane2Session}
          onSessionChange={setPane2Session}
          sessions={[{ id: "local", title: "💻 로컬 탐색기", type: "local" }, ...sshSessions.map(s => ({ id: s.id, title: s.title, type: "ssh", cwd: s.cwd }))]}
          onFileSelect={onFileSelect}
          dragStartDetected={dragStartDetected}
          selectedNodes={selectedNodes}
          setSelectedNodes={setSelectedNodes}
          lastSelectedNode={lastSelectedNode}
          setLastSelectedNode={setLastSelectedNode}
          focusedNode={focusedNode}
          setFocusedNode={setFocusedNode}
          onDragStart={handleDragStart}
          onDrag={handleDrag}
          onDragEnd={handleDragEnd}
          onDropItem={handleDropItem}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onContextMenu={handleContextMenu}
          onBackgroundContextMenu={handleBackgroundContextMenu}
          transferProgress={transferProgress}
        />
      )}

      {contextMenu && (
        <div
          className="fixed bg-theme-surface border border-theme-border/20 shadow-2xl rounded-lg py-1.5 z-50 min-w-[180px] font-ui"
          style={{ 
            left: contextMenu.x, 
            top: contextMenu.y,
            backdropFilter: 'blur(8px)'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {!contextMenu.isBackground && (
            <div className="px-3 py-1.5 text-xs text-theme-muted font-semibold border-b border-theme-border/10 mb-1 truncate max-w-[200px]">
              {contextMenu.file.name || '항목'}
            </div>
          )}
          {!contextMenu.isBackground && (
            <>
              <button
                className="w-full text-left px-4 py-2 hover:bg-theme-primary/20 flex items-center gap-2 transition-colors text-theme-text"
                onClick={handleCopy}
              >
                <Copy size={14} className="text-theme-muted" /> 복사 (Copy)
              </button>
              <button
                className="w-full text-left px-4 py-2 hover:bg-theme-primary/20 flex items-center gap-2 transition-colors text-theme-text"
                onClick={handleCut}
              >
                <Scissors size={14} className="text-theme-muted" /> 잘라내기 (Cut)
              </button>
              <button
                className="w-full text-left px-4 py-2 hover:bg-theme-primary/20 flex items-center gap-2 transition-colors text-theme-text"
                onClick={handleDownload}
              >
                <Download size={14} className="text-theme-muted" /> 로컬로 다운로드
              </button>
            </>
          )}
          {clipboardFiles && (
            <button
              className="w-full text-left px-4 py-2 hover:bg-theme-primary/20 flex items-center gap-2 transition-colors text-theme-text border-t border-theme-border/10 mt-1 pt-2"
              onClick={handlePaste}
            >
              <ClipboardPaste size={14} className="text-theme-muted" />
              붙여넣기 ({clipboardFiles.files.length})
            </button>
          )}
          <button
            className="w-full text-left px-4 py-2 hover:bg-theme-primary/20 flex items-center gap-2 transition-colors text-theme-text border-t border-theme-border/10 mt-1 pt-2"
            onClick={handleOpenTerminal}
          >
            <Terminal size={14} className="text-theme-muted" /> 현재 위치에서 터미널 열기
          </button>
          {!contextMenu.isBackground && (
            <button
              className="w-full text-left px-4 py-2 hover:bg-red-500/20 text-red-400 flex items-center gap-2 transition-colors border-t border-theme-border/10 mt-1 pt-2"
              onClick={handleDelete}
            >
              <Trash size={14} className="opacity-80" /> 삭제 (Delete)
            </button>
          )}
        </div>
      )}
    </div>
  );
};
