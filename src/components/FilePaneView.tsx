import React, { useState, useEffect } from "react";
import {
  Folder,
  File,
  HardDrive,
  Globe,
  ArrowUp,
  FolderPlus,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
}

export interface FilePaneProps {
  paneId: string;
  sessionId: string; // "local" or "ssh-xxxx"
  sessions: any[]; // Array of SessionItem
  onSessionChange: (newSessionId: string) => void;
  onFileSelect: (filePath: string, fileName: string, isRemote: boolean) => void;

  // Shared drag state
  dragStartDetected: React.MutableRefObject<boolean>;
  selectedNodes: Set<string>;
  setSelectedNodes: (nodes: Set<string>) => void;
  lastSelectedNode: { file: FileNode; sourceId: string } | null;
  setLastSelectedNode: (
    node: { file: FileNode; sourceId: string } | null,
  ) => void;
  focusedNode: { path: string; sourceId: string } | null;
  setFocusedNode: (node: { path: string; sourceId: string } | null) => void;

  // Drag handlers passed from parent
  onDragStart: (e: React.DragEvent, file: FileNode, sourceId: string, availableFiles?: FileNode[]) => void;
  onDrag: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDropItem: (
    e: React.DragEvent,
    targetSessionId: string,
    targetPath: string,
    isDir: boolean,
  ) => void;
  onDragEnter: (e: React.DragEvent) => void;
  onDragOver: (
    e: React.DragEvent,
    path: string,
    isDir: boolean,
    sessionId: string,
  ) => void;

  // Context Menu
  onContextMenu: (e: React.MouseEvent, file: FileNode, sourceId: string) => void;
  onBackgroundContextMenu: (e: React.MouseEvent, sourceId: string, currentPath: string) => void;
  transferProgress?: number | null;
}

export const FilePaneView: React.FC<FilePaneProps> = ({
  paneId,
  sessionId,
  sessions,
  onSessionChange,
  onFileSelect,
  dragStartDetected,
  selectedNodes,
  setSelectedNodes,
  lastSelectedNode,
  setLastSelectedNode,
  focusedNode,
  setFocusedNode,
  onDragStart,
  onDropItem,
  onDragEnter,
  onDragOver,
  onContextMenu,
  onBackgroundContextMenu,
}) => {
  const isLocal = sessionId === "local";
  const [path, setPath] = useState<string>("");
  const [files, setFiles] = useState<FileNode[]>([]);
  const [isConnected, setIsConnected] = useState<boolean>(true); // Local is always connected
  const [localDrives, setLocalDrives] = useState<string[]>([]);

  // Fetch local drives when in local mode
  useEffect(() => {
    if (isLocal) {
      invoke<string[]>("get_local_drives")
        .then(setLocalDrives)
        .catch(e => console.error("드라이브 목록 조회 실패:", e));
    }
  }, [isLocal]);

  // Load initial path from localStorage based on paneId and sessionId
  useEffect(() => {
    const savedPath = localStorage.getItem(
      `terminal_avy_${paneId}_${sessionId}_path`,
    );
    if (savedPath) {
      setPath(savedPath);
    } else {
      const currentSession = sessions.find((s) => s.id === sessionId);
      setPath(isLocal ? "C:/" : currentSession?.cwd || "/home/ubuntu");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, sessionId, isLocal]);

  // Save path changes
  useEffect(() => {
    if (path) {
      localStorage.setItem(`terminal_avy_${paneId}_${sessionId}_path`, path);
      loadDirectory(path);
    }
  }, [path, sessionId]);

  useEffect(() => {
    const handleRefresh = () => {
      if (path) loadDirectory(path);
    };
    window.addEventListener('refresh_file_tree', handleRefresh);
    return () => window.removeEventListener('refresh_file_tree', handleRefresh);
  }, [path, isLocal, sessionId]);

  const loadDirectory = async (targetPath: string) => {
    try {
      if (isLocal) {
        const result: FileNode[] = await invoke("read_local_dir", {
          path: targetPath,
        });
        result.sort((a, b) => {
          if (a.isDir && !b.isDir) return -1;
          if (!a.isDir && b.isDir) return 1;
          return a.name.localeCompare(b.name);
        });
        setFiles(result);
        setPath(targetPath);
      } else {
        const result: FileNode[] = await invoke("sftp_read_dir", {
          sessionId,
          remotePath: targetPath,
        });
        result.sort((a, b) => {
          if (a.isDir && !b.isDir) return -1;
          if (!a.isDir && b.isDir) return 1;
          return a.name.localeCompare(b.name);
        });
        setFiles(result);
        setPath(targetPath);
        setIsConnected(true);
      }
    } catch (e: any) {
      console.error(`디렉토리 읽기 실패 (${sessionId}):`, e);
      if (!isLocal) {
        const errStr = e.toString().toLowerCase();
        if (
          errStr.includes("not connected") ||
          errStr.includes("no active session")
        ) {
          setIsConnected(false);
        } else {
          setIsConnected(true);
        }
      }
      setFiles([]);
    }
  };

  const handleGoUp = () => {
    if (isLocal) {
      const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
      if (parts.length > 1) {
        parts.pop();
        setPath(parts.join("/") + "/");
      }
    } else {
      if (path === "/") return;
      const parts = path.split("/").filter(Boolean);
      parts.pop();
      setPath(parts.length === 0 ? "/" : "/" + parts.join("/"));
    }
  };

  const handleCreateFolder = async () => {
    const folderName = prompt("새 폴더 이름을 입력하세요:");
    if (!folderName) return;

    try {
      const sep = isLocal ? (path.includes("\\") ? "\\" : "/") : "/";
      const fullPath = path.replace(/[\\/]+$/, "") + sep + folderName;

      if (isLocal) {
        await invoke("create_local_dir", { path: fullPath });
      } else {
        await invoke("sftp_create_dir", {
          session_id: sessionId,
          path: fullPath,
        });
      }
      loadDirectory(path);
    } catch (e) {
      alert(`폴더 생성 실패: ${e}`);
    }
  };

  const handleItemClick = (
    e: React.MouseEvent | React.KeyboardEvent,
    file: FileNode,
  ) => {
    if (dragStartDetected.current) return;
    if ("button" in e && e.button !== 0) return;

    const itemKey = `${sessionId}:${file.path}`;

    if (e.ctrlKey || e.metaKey) {
      const newSet = new Set(selectedNodes);
      if (newSet.has(itemKey)) newSet.delete(itemKey);
      else newSet.add(itemKey);
      setSelectedNodes(newSet);
      setLastSelectedNode({ file, sourceId: sessionId });
      return;
    }

    if (
      e.shiftKey &&
      lastSelectedNode &&
      lastSelectedNode.sourceId === sessionId
    ) {
      const startIdx = files.findIndex(
        (f) => f.path === lastSelectedNode.file.path,
      );
      const endIdx = files.findIndex((f) => f.path === file.path);
      if (startIdx !== -1 && endIdx !== -1) {
        const min = Math.min(startIdx, endIdx);
        const max = Math.max(startIdx, endIdx);
        const newSet = new Set(selectedNodes);
        for (let i = min; i <= max; i++) {
          newSet.add(`${sessionId}:${files[i].path}`);
        }
        setSelectedNodes(newSet);
        return;
      }
    }

    setSelectedNodes(new Set([itemKey]));
    setLastSelectedNode({ file, sourceId: sessionId });
  };

  const handleItemDoubleClick = (_e: React.MouseEvent, file: FileNode) => {
    if (file.isDir) {
      loadDirectory(file.path);
    } else {
      onFileSelect(file.path, file.name, !isLocal);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const pathLen = isLocal
      ? path.replace(/\\/g, "/").replace(/\/$/, "").length
      : path.length;
    const canGoUp = isLocal ? pathLen > 3 : isConnected && path !== "/";

    const list = canGoUp
      ? [
          { name: "..", path: "up-dir-marker", isDir: true } as FileNode,
          ...files,
        ]
      : files;

    if (!list.length) return;

    const currentIndex =
      focusedNode?.sourceId === sessionId
        ? list.findIndex(
            (f) =>
              f.path === focusedNode.path ||
              (f.path === "up-dir-marker" &&
                focusedNode.path === "up-dir-marker"),
          )
        : -1;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const nextIndex = currentIndex < list.length - 1 ? currentIndex + 1 : 0;
      setFocusedNode({
        path: list[nextIndex].path,
        sourceId: sessionId,
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : list.length - 1;
      setFocusedNode({
        path: list[prevIndex].path,
        sourceId: sessionId,
      });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (currentIndex !== -1) {
        const selected = list[currentIndex];
        if (selected.path === "up-dir-marker") {
          handleGoUp();
        } else if (selected.isDir) {
          loadDirectory(selected.path);
        } else {
          onFileSelect(selected.path, selected.name, !isLocal);
        }
      }
    }
  };

  return (
    <div
      className="flex-1 flex flex-col min-h-0 relative border-b border-theme-border/5"
      onDragEnter={onDragEnter}
      onDragOver={(e) => onDragOver(e, path, true, sessionId)}
      onDrop={(e) => {
        e.preventDefault();
        const target = e.target as HTMLElement;
        const fileNode = target.closest("[data-file-path]");
        const isDir = fileNode
          ? fileNode.getAttribute("data-is-dir") === "true"
          : true;
        const targetPath = fileNode
          ? fileNode.getAttribute("data-file-path") || path
          : path;

        onDropItem(e, sessionId, targetPath, isDir);
      }}
    >
      <div className="px-4 py-2 bg-theme-base/40 flex flex-col gap-1 border-b border-theme-border/5">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2 font-semibold text-theme-text">
          {isLocal ? (
            <HardDrive size={16} className="text-theme-primary-light" />
          ) : (
            <Globe size={16} className="text-theme-accent" />
          )}
          <select
            value={sessionId}
            onChange={(e) => onSessionChange(e.target.value)}
            className="bg-transparent border-none text-theme-text font-semibold outline-none cursor-pointer hover:bg-theme-surface rounded px-1"
          >
            {sessions.map((s) => (
              <option
                key={s.id}
                value={s.id}
                className="bg-theme-surface text-theme-text"
              >
                {s.title}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            onClick={handleCreateFolder}
            disabled={!isLocal && !isConnected}
            className="hover:text-theme-text transition disabled:opacity-30 text-theme-muted"
            title="새 폴더 만들기"
          >
            <FolderPlus size={14} />
          </button>
          <button
            onClick={handleGoUp}
            disabled={
              (!isLocal && (!isConnected || path === "/")) ||
              (isLocal &&
                path.replace(/\\/g, "/").replace(/\/$/, "").length <= 3)
            }
            className="hover:text-theme-text transition disabled:opacity-30 text-theme-muted"
            title="상위 폴더 이동"
          >
            <ArrowUp size={14} />
          </button>
        </div>
        </div>
        <div className="flex items-center gap-1.5 w-full">
          {isLocal && localDrives.length > 0 && (
            <select
              value={path.match(/^[a-zA-Z]:/)?.[0].toUpperCase() + "\\"}
              onChange={(e) => loadDirectory(e.target.value)}
              className="bg-theme-surface text-theme-text text-[10px] font-mono border border-theme-border/20 rounded outline-none px-1 py-0.5 cursor-pointer shrink-0"
              title="디스크 변경"
            >
              {localDrives.map(drive => (
                <option key={drive} value={drive}>{drive}</option>
              ))}
            </select>
          )}
          <div className="text-[10px] flex-1 text-theme-muted font-mono truncate select-all px-1 py-0.5 bg-black/10 rounded" title={path}>{path}</div>
        </div>
      </div>

      {/* File List */}
      <div
        className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 select-none outline-none pb-4"
        onContextMenu={(e) => onBackgroundContextMenu(e, sessionId, path)}
        onDragOver={(e) => onDragOver(e, path, true, sessionId)}
        onDrop={(e) => onDropItem(e, sessionId, path, true)}
        onDragEnter={onDragEnter}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            setSelectedNodes(new Set());
            setLastSelectedNode(null);
          }
        }}
      >
        {files.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-theme-muted/50 select-none">
            이 폴더는 비어 있습니다
          </div>
        ) : (
          <>
            {(!isLocal ? (isConnected && path !== "/") : (path.replace(/\\/g, "/").replace(/\/$/, "").length > 3)) && (
              <div
                className={`flex items-center gap-2 px-3 py-1 cursor-pointer transition-colors ${focusedNode?.path === "up-dir-marker" ? "bg-theme-primary/10 border border-theme-primary-light/30 ring-1 ring-inset ring-theme-primary-light/50" : "hover:bg-theme-panel hover:bg-white/5"}`}
                onDoubleClick={handleGoUp}
              >
                <div className="w-4 flex justify-center shrink-0">
                  <Folder size={15} className="text-theme-muted" />
                </div>
                <div className="flex-1 text-xs">..</div>
              </div>
            )}
            {files.map((file, i) => (
              <div
                key={`${file.path}-${i}`}
                className={`flex items-center gap-2 px-3 py-1 cursor-pointer transition-colors ${
                  selectedNodes.has(`${sessionId}:${file.path}`)
                    ? "bg-theme-primary/30"
                    : "hover:bg-theme-panel hover:bg-white/5"
                } ${focusedNode?.path === file.path ? "ring-1 ring-inset ring-theme-primary-light/50" : ""}`}
                onClick={(e) => handleItemClick(e, file)}
                onDoubleClick={(e) => handleItemDoubleClick(e, file)}
              
              onContextMenu={(e) => { e.stopPropagation(); onContextMenu(e, file, sessionId); }}
              draggable
              onDragStart={(e) => onDragStart(e, file, sessionId, files)}
              onDragOver={(e) =>
                file.isDir && onDragOver(e, file.path, true, sessionId)
              }
              onDrop={(e) =>
                file.isDir && onDropItem(e, sessionId, file.path, true)
              }
              onDragEnter={onDragEnter}
            >
              <div className="w-4 flex justify-center shrink-0">
                {file.isDir ? (
                  <Folder
                    size={15}
                    className={`pointer-events-none ${isLocal ? "text-theme-primary-light fill-indigo-400/20" : "text-theme-accent fill-emerald-400/20"}`}
                  />
                ) : (
                  <File
                    size={15}
                    className="text-theme-muted pointer-events-none"
                  />
                )}
              </div>
              <div className="flex-1 truncate text-xs">{file.name}</div>
            </div>
          ))}
          </>
        )}
      </div>
    </div>
  );
};
