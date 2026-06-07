// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize, SlavePty};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

use std::sync::atomic::{AtomicU64, Ordering};

// 터미널 PTY 및 SSH 세션의 연결 상태를 보관하는 열거형
enum SessionConnection {
    Connecting {
        attempt_id: u64,
    },
    Cancelled {
        attempt_id: u64,
    },
    Local {
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn std::io::Write + Send>,
        slave: Box<dyn SlavePty + Send>, // Slave 객체를 소유하여 ConPTY 입출력 통로가 조기 소멸하는 것 방지
    },
    Ssh {
        session: ssh2::Session,
        channel: Arc<Mutex<ssh2::Channel>>,
        _tcp: TcpStream,
    },
}

// 터미널 세션의 고유 식별자와 연결 정보를 포함하는 구조체
struct TerminalSession {
    id: String,
    connection: SessionConnection,
}

// Tauri에서 전역 관리할 애플리케이션 상태 정의
pub struct AppState {
    sessions: Mutex<HashMap<String, TerminalSession>>,
    next_attempt_id: AtomicU64,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_attempt_id: AtomicU64::new(1),
        }
    }
}

fn cleanup_failed_attempt(state: &AppState, session_id: &str, attempt_id: u64) {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(session_id) {
        match session.connection {
            SessionConnection::Connecting {
                attempt_id: attr_id,
            }
            | SessionConnection::Cancelled {
                attempt_id: attr_id,
            } => {
                if attr_id == attempt_id {
                    sessions.remove(session_id);
                }
            }
            _ => {}
        }
    }
}

// 프론트엔드로 PTY 출력을 스트리밍할 때 사용하는 페이로드 구조체
#[derive(Clone, Serialize)]
struct PtyOutputPayload {
    #[serde(rename = "sessionId")]
    session_id: String,
    data: String,
}

// 파일 및 폴더 정보를 나타내는 구조체
#[derive(Serialize, Clone)]
struct FileEntry {
    name: String,
    path: String,
    #[serde(rename = "isDir")]
    is_dir: bool,
}

// SSH 채널에 데이터를 쓸 때 락 대기 및 WouldBlock 에러가 날 수 있으므로 try_lock 루프로 처리하는 헬퍼 함수
fn write_ssh_channel(channel: &Arc<Mutex<ssh2::Channel>>, data: &[u8]) -> Result<(), String> {
    let mut written = 0;
    while written < data.len() {
        // lock() 대신 try_lock()을 사용하여 백그라운드 리더 스레드와의 락 점유 교착(데드락)을 방지
        if let Ok(mut chan) = channel.try_lock() {
            match chan.write(&data[written..]) {
                Ok(0) => return Err("SSH 채널이 닫혔습니다.".to_string()),
                Ok(n) => {
                    written += n;
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // 비블로킹 소켓 쓰기 공간 확보 대기 (다음 루프 재시도)
                }
                Err(e) => return Err(format!("SSH 채널 쓰기 에러: {}", e)),
            }
        }

        if written < data.len() {
            // 락 양보 및 CPU 부하 경감을 위해 10ms 슬립
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    // 마지막 플러시 작업도 교착을 피하기 위해 try_lock으로 안전하게 실행
    if let Ok(mut chan) = channel.try_lock() {
        let _ = chan.flush();
    }
    Ok(())
}

// 로컬 드라이브 목록 조회 명령어
#[tauri::command]
fn get_local_drives() -> Result<Vec<String>, String> {
    let mut drives = Vec::new();
    for c in b'A'..=b'Z' {
        let path = format!("{}:\\", c as char);
        if std::path::Path::new(&path).exists() {
            drives.push(path);
        }
    }
    Ok(drives)
}

// 로컬 디렉토리 파일 목록 조회 명령어
#[tauri::command]
fn read_local_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for entry in dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        let file_path = entry.path().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        entries.push(FileEntry {
            name: file_name,
            path: file_path,
            is_dir,
        });
    }
    // 디렉토리가 항상 상단에 먼저 나오도록 정렬 후 이름순 정렬
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(entries)
}

// 로컬 파일 읽기 명령어
#[tauri::command]
fn read_local_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

// 로컬 파일 쓰기(저장) 명령어
#[tauri::command]
fn write_local_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| e.to_string())
}

// 로컬 파일/디렉토리 재귀 복사 헬퍼 함수
fn copy_dir_all(
    src: impl AsRef<std::path::Path>,
    dst: impl AsRef<std::path::Path>,
) -> std::io::Result<()> {
    std::fs::create_dir_all(&dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_all(entry.path(), dst.as_ref().join(entry.file_name()))?;
        } else {
            std::fs::copy(entry.path(), dst.as_ref().join(entry.file_name()))?;
        }
    }
    Ok(())
}

// 로컬 파일 또는 폴더 복사 명령어
#[tauri::command]
fn copy_local_item(src: String, dest: String) -> Result<(), String> {
    let src_path = std::path::Path::new(&src);
    let dest_path = std::path::Path::new(&dest);

    if src_path.is_dir() {
        copy_dir_all(src_path, dest_path).map_err(|e| e.to_string())
    } else {
        std::fs::copy(src_path, dest_path)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

// 로컬 파일 또는 폴더 이동 명령어
#[tauri::command]
fn move_local_item(src: String, dest: String) -> Result<(), String> {
    let src_path = std::path::Path::new(&src);
    let dest_path = std::path::Path::new(&dest);

    // 1. rename 시도
    if std::fs::rename(src_path, dest_path).is_ok() {
        return Ok(());
    }

    // 2. 실패 시 (다른 드라이브 간 등) Copy 후 Delete
    if src_path.is_dir() {
        copy_dir_all(src_path, dest_path).map_err(|e| e.to_string())?;
        std::fs::remove_dir_all(src_path).map_err(|e| e.to_string())?;
    } else {
        std::fs::copy(src_path, dest_path).map_err(|e| e.to_string())?;
        std::fs::remove_file(src_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// 로컬 파일 또는 폴더 삭제 명령어
#[tauri::command]
fn remove_local_item(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
}

// SSH 세션 파일/폴더 삭제 명령어
#[tauri::command]
async fn sftp_remove_item(
    session_id: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&session_id) {
        match &session.connection {
            SessionConnection::Ssh {
                session: ssh_sess, ..
            } => {
                let sftp = loop {
                    match ssh_sess.sftp() {
                        Ok(sftp) => break sftp,
                        Err(ref e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                        Err(e) => return Err(format!("SFTP 세션 실패: {}", e)),
                    }
                };

                let p = std::path::Path::new(&remote_path);
                let stat = loop {
                    match sftp.stat(p) {
                        Ok(s) => break s,
                        Err(ref e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                        Err(e) => return Err(format!("stat 실패: {}", e)),
                    }
                };

                let res = if stat.is_dir() {
                    loop {
                        match sftp.rmdir(p) {
                            Ok(_) => break Ok(()),
                            Err(ref e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                                std::thread::sleep(std::time::Duration::from_millis(10));
                            }
                            Err(e) => break Err(format!("rmdir 실패: {}", e)),
                        }
                    }
                } else {
                    loop {
                        match sftp.unlink(p) {
                            Ok(_) => break Ok(()),
                            Err(ref e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                                std::thread::sleep(std::time::Duration::from_millis(10));
                            }
                            Err(e) => break Err(format!("unlink 실패: {}", e)),
                        }
                    }
                };
                res
            }
            _ => Err("SSH 세션이 아닙니다.".to_string()),
        }
    } else {
        Err("세션을 찾을 수 없습니다.".to_string())
    }
}

// SSH 세션 파일/폴더 이동 (rename)
#[tauri::command]
async fn sftp_rename_item(
    session_id: String,
    src: String,
    dest: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&session_id) {
        match &session.connection {
            SessionConnection::Ssh {
                session: ssh_sess, ..
            } => {
                let sftp = loop {
                    match ssh_sess.sftp() {
                        Ok(sftp) => break sftp,
                        Err(ref e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                        Err(e) => return Err(format!("SFTP 세션 실패: {}", e)),
                    }
                };

                loop {
                    match sftp.rename(
                        std::path::Path::new(&src),
                        std::path::Path::new(&dest),
                        None,
                    ) {
                        Ok(_) => break Ok(()),
                        Err(ref e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                        Err(e) => break Err(format!("rename 실패: {}", e)),
                    }
                }
            }
            _ => Err("SSH 세션이 아닙니다.".to_string()),
        }
    } else {
        Err("세션을 찾을 수 없습니다.".to_string())
    }
}

// SSH 명령 실행 (복사 등에 활용)
#[tauri::command]
async fn ssh_exec_command(
    session_id: String,
    command: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&session_id) {
        match &session.connection {
            SessionConnection::Ssh {
                session: ssh_sess, ..
            } => {
                let mut channel = loop {
                    match ssh_sess.channel_session() {
                        Ok(c) => break c,
                        Err(ref e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                        Err(e) => return Err(format!("채널 열기 실패: {}", e)),
                    }
                };

                loop {
                    match channel.exec(&command) {
                        Ok(_) => break,
                        Err(ref e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                        Err(e) => return Err(format!("명령어 실행 실패: {}", e)),
                    }
                }

                let mut s = String::new();
                loop {
                    match channel.read_to_string(&mut s) {
                        Ok(_) => break,
                        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                        Err(_) => break,
                    }
                }

                let _ = channel.wait_close();
                Ok(s)
            }
            _ => Err("SSH 세션이 아닙니다.".to_string()),
        }
    } else {
        Err("세션을 찾을 수 없습니다.".to_string())
    }
}

// SSH 세션 내 원격 디렉토리 조회 명령어
#[tauri::command]
async fn sftp_read_dir(
    session_id: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<FileEntry>, String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&session_id) {
        match &session.connection {
            SessionConnection::Ssh {
                session: ssh_sess, ..
            } => {
                // 비블로킹 세션 상태를 그대로 유지한 채 WouldBlock 발생 시 안전 대기 루프로 처리하여 데드락 근절
                let sftp = loop {
                    match ssh_sess.sftp() {
                        Ok(sftp) => break sftp,
                        Err(ref e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                        Err(e) => return Err(format!("SFTP 세션 실패: {}", e)),
                    }
                };

                let path = std::path::Path::new(&remote_path);
                let files = loop {
                    match sftp.readdir(path) {
                        Ok(files) => break files,
                        Err(ref e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                        Err(e) => return Err(format!("readdir 실패: {}", e)),
                    }
                };

                let mut entries = Vec::new();
                for (file_path, stat) in files {
                    let file_name = file_path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "".to_string());
                    let full_path = file_path.to_string_lossy().to_string().replace("\\", "/");
                    let is_dir = stat.is_dir();

                    // . 과 .. 은 탐색 트리 간소화를 위해 제외
                    if file_name != "." && file_name != ".." {
                        entries.push(FileEntry {
                            name: file_name,
                            path: full_path,
                            is_dir,
                        });
                    }
                }

                entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
                Ok(entries)
            }
            _ => Err("SSH 세션이 아닙니다.".to_string()),
        }
    } else {
        Err("세션을 찾을 수 없습니다.".to_string())
    }
}

// SSH 세션 파일 전송(업로드/다운로드) 처리 및 진행도 전송 명령어
#[tauri::command]
async fn sftp_transfer_file(
    session_id: String,
    direction: String, // "upload" 또는 "download"
    local_path: String,
    remote_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&session_id) {
        match &session.connection {
            SessionConnection::Ssh {
                session: ssh_sess, ..
            } => {
                // 비블로킹 세션을 고수하여 PTY 리더 스레드의 락 대기 정체를 완전히 배제
                let sftp = loop {
                    match ssh_sess.sftp() {
                        Ok(sftp) => break sftp,
                        Err(ref e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                        Err(e) => return Err(format!("SFTP 세션 실패: {}", e)),
                    }
                };
                let app_clone = app.clone();
                let session_id_clone = session_id.clone();

                if direction == "upload" {
                    let mut local_file = std::fs::File::open(&local_path)
                        .map_err(|e| format!("로컬 파일 열기 실패: {}", e))?;
                    let total_size = local_file.metadata().map(|m| m.len()).unwrap_or(0);

                    let mut remote_file = loop {
                        match sftp.create(std::path::Path::new(&remote_path)) {
                            Ok(file) => break file,
                            Err(ref e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                                std::thread::sleep(std::time::Duration::from_millis(10));
                            }
                            Err(e) => return Err(format!("원격 파일 생성 실패: {}", e)),
                        }
                    };

                    // 대용량 파일 복사 시 UI 프리징 방지를 위해 백그라운드 태스크 기동
                    std::thread::spawn(move || {
                        let mut buffer = [0u8; 16384];
                        let mut transferred = 0u64;
                        loop {
                            match local_file.read(&mut buffer) {
                                Ok(0) => break,
                                Ok(n) => {
                                    // 비블로킹 소켓 쓰기 대기 루프
                                    let mut written = 0;
                                    while written < n {
                                        match remote_file.write(&buffer[written..n]) {
                                            Ok(0) => break,
                                            Ok(w) => {
                                                written += w;
                                            }
                                            Err(ref e)
                                                if e.kind() == std::io::ErrorKind::WouldBlock =>
                                            {
                                                std::thread::sleep(
                                                    std::time::Duration::from_millis(5),
                                                );
                                            }
                                            Err(_) => break,
                                        }
                                    }
                                    transferred += n as u64;
                                    let progress = if total_size > 0 {
                                        (transferred * 100 / total_size) as u8
                                    } else {
                                        100
                                    };
                                    let _ = app_clone.emit(
                                        &format!("sftp-progress-{}", session_id_clone),
                                        progress,
                                    );
                                }
                                Err(_) => break,
                            }
                        }
                    });
                } else {
                    // 원격 ➔ 로컬 파일 다운로드
                    let mut remote_file = loop {
                        match sftp.open(std::path::Path::new(&remote_path)) {
                            Ok(file) => break file,
                            Err(ref e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                                std::thread::sleep(std::time::Duration::from_millis(10));
                            }
                            Err(e) => return Err(format!("원격 파일 열기 실패: {}", e)),
                        }
                    };
                    let total_size = remote_file.stat().map(|s| s.size.unwrap_or(0)).unwrap_or(0);

                    let mut local_file = std::fs::File::create(&local_path)
                        .map_err(|e| format!("로컬 파일 생성 실패: {}", e))?;

                    std::thread::spawn(move || {
                        let mut buffer = [0u8; 16384];
                        let mut transferred = 0u64;
                        loop {
                            // 비블로킹 소켓 읽기 대기 루프
                            let mut read_res = None;
                            loop {
                                match remote_file.read(&mut buffer) {
                                    Ok(n) => {
                                        read_res = Some(n);
                                        break;
                                    }
                                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                        std::thread::sleep(std::time::Duration::from_millis(5));
                                    }
                                    Err(_) => break,
                                }
                            }

                            match read_res {
                                Some(0) | None => break, // EOF 또는 에러
                                Some(n) => {
                                    if local_file.write_all(&buffer[..n]).is_err() {
                                        break;
                                    }
                                    transferred += n as u64;
                                    let progress = if total_size > 0 {
                                        (transferred * 100 / total_size) as u8
                                    } else {
                                        100
                                    };
                                    let _ = app_clone.emit(
                                        &format!("sftp-progress-{}", session_id_clone),
                                        progress,
                                    );
                                }
                            }
                        }
                    });
                }
                Ok(())
            }
            _ => Err("SSH 세션이 아닙니다.".to_string()),
        }
    } else {
        Err("세션을 찾을 수 없습니다.".to_string())
    }
}

// 로컬 PTY 세션을 스폰하고 백그라운드 리더를 구동하는 명령어
#[tauri::command]
async fn start_pty_session(
    session_id: String,
    shell_path: String,
    cwd: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    println!(
        "[start_pty_session] 세션 시작 요청 수신: id={}, shell_path={}",
        session_id, shell_path
    );

    let attempt_id = state.next_attempt_id.fetch_add(1, Ordering::SeqCst);

    // 1. 상태 등록 (Connecting)
    {
        let mut sessions = state.sessions.lock().unwrap();
        sessions.insert(
            session_id.clone(),
            TerminalSession {
                id: session_id.clone(),
                connection: SessionConnection::Connecting { attempt_id },
            },
        );
    }

    let pty_system = native_pty_system();
    println!("[start_pty_session] 네이티브 PTY 시스템 생성 완료");

    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| {
            cleanup_failed_attempt(&state, &session_id, attempt_id);
            let err = format!("PTY 생성 실패: {}", e);
            println!("[start_pty_session] {}", err);
            err
        })?;
    println!("[start_pty_session] PTY openpty 페어 개설 완료");

    let mut actual_shell = shell_path.clone();
    let mut cmd = CommandBuilder::new(&shell_path);
    if let Some(working_dir) = cwd.as_ref() {
        cmd.cwd(working_dir);
    }
    
    let child = match pair.slave.spawn_command(cmd) {
        Ok(child) => child,
        Err(e) => {
            // 만약 pwsh.exe가 시스템 경로에 없어서 실행 실패한 경우 Windows PowerShell 절대 경로로 Fallback
            if shell_path == "pwsh.exe" {
                println!("[start_pty_session] pwsh.exe 실행 실패 ({:?}), powershell.exe 대체 구동을 실행합니다.", e);
                actual_shell =
                    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe".to_string();
                let mut fallback_cmd = CommandBuilder::new(&actual_shell);
                if let Some(working_dir) = cwd.as_ref() {
                    fallback_cmd.cwd(working_dir);
                }
                match pair.slave.spawn_command(fallback_cmd) {
                    Ok(c) => c,
                    Err(err) => {
                        cleanup_failed_attempt(&state, &session_id, attempt_id);
                        let err_msg = format!("차선책 쉘 powershell.exe 실행 최종 실패: {}", err);
                        println!("[start_pty_session] {}", err_msg);
                        return Err(err_msg);
                    }
                }
            } else {
                cleanup_failed_attempt(&state, &session_id, attempt_id);
                let err_msg = format!("쉘 프로세스 실행 실패: {}", e);
                println!("[start_pty_session] {}", err_msg);
                return Err(err_msg);
            }
        }
    };
    println!(
        "[start_pty_session] 쉘 프로세스 실행 성공, PID: {:?}",
        child.process_id()
    );

    // Windows ConPTY의 안정성을 보장하기 위해 slave 객체를 조기에 drop하지 않고
    // 세션 라이프사이클(sessions 맵)에 보관하여 파이프 클로즈를 막습니다.

    let mut reader = pair.master.try_clone_reader().map_err(|e| {
        cleanup_failed_attempt(&state, &session_id, attempt_id);
        let err = format!("PTY 리더 클론 실패: {}", e);
        println!("[start_pty_session] {}", err);
        err
    })?;
    let mut writer = pair.master.take_writer().map_err(|e| {
        cleanup_failed_attempt(&state, &session_id, attempt_id);
        let err = format!("PTY 라이터 획득 실패: {}", e);
        println!("[start_pty_session] {}", err);
        err
    })?;

    // powershell.exe가 최종 구동된 경우에만 UTF-8 인코딩 명령(chcp 65001) 주입
    let is_powershell = actual_shell.contains("powershell.exe");
    if is_powershell {
        // 프로세스가 로딩되어 프롬프트가 대기 상태가 되도록 비동기 슬립
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;

        let mut is_valid = false;
        {
            let sessions = state.sessions.lock().unwrap();
            if let Some(session) = sessions.get(&session_id) {
                if let SessionConnection::Connecting {
                    attempt_id: attr_id,
                } = session.connection
                {
                    if attr_id == attempt_id {
                        is_valid = true;
                    }
                }
            }
        }

        if is_valid {
            if let Err(e) = writer.write_all(b"chcp 65001\r\n") {
                println!("[start_pty_session] chcp 65001 주입 실패: {:?}", e);
            }
            let _ = writer.flush();
        } else {
            cleanup_failed_attempt(&state, &session_id, attempt_id);
            return Err("세션 시작이 취소되었습니다.".to_string());
        }
    }

    let session_id_clone = session_id.clone();
    let app_clone = app.clone();

    println!("[start_pty_session] PTY 리더 스레드 스폰 준비");
    // PTY 출력을 비동기적으로 읽어 프론트엔드로 Event를 발행하는 스레드 구동
    std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        println!(
            "[start_pty_session] 리더 스레드 시작, 세션 ID: {}",
            session_id_clone
        );
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    println!("[start_pty_session] reader.read가 0(EOF)을 반환했습니다. 루프 종료");
                    break;
                } // EOF 감지 시 탈출
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buffer[..n]).to_string();
                    println!("[start_pty_session] 읽은 데이터 ({} 바이트): {:?}", n, text);
                    let emit_res = app_clone.emit(
                        "pty-output",
                        PtyOutputPayload {
                            session_id: session_id_clone.clone(),
                            data: text,
                        },
                    );
                    if let Err(e) = emit_res {
                        println!("[start_pty_session] 이벤트 발행 실패: {:?}", e);
                    }
                }
                Err(e) => {
                    println!("[start_pty_session] reader.read 에러 발생: {:?}", e);
                    break;
                }
            }
        }

        println!(
            "[start_pty_session] 리더 스레드 종료 통보 중, 세션 ID: {}",
            session_id_clone
        );
        // PTY 정상 종료 통지 (사용자가 exit를 직접 쳤거나 비자발적으로 종료된 경우에만 발행)
        let is_still_active = {
            let app_state = app_clone.state::<AppState>();
            let sessions = app_state.sessions.lock().unwrap();
            sessions.contains_key(&session_id_clone)
        };
        if is_still_active {
            let _ = app_clone.emit("pty-closed", session_id_clone);
        }
    });

    // 전역 세션 맵에 등록
    {
        let mut sessions = state.sessions.lock().unwrap();
        if let Some(session) = sessions.get(&session_id) {
            match session.connection {
                SessionConnection::Connecting {
                    attempt_id: attr_id,
                } => {
                    if attr_id == attempt_id {
                        sessions.insert(
                            session_id.clone(),
                            TerminalSession {
                                id: session_id,
                                connection: SessionConnection::Local {
                                    master: pair.master,
                                    writer,
                                    slave: pair.slave, // slave를 보관하여 drop 방지
                                },
                            },
                        );
                        println!(
                            "[start_pty_session] 전역 AppState 세션 등록 성공: {}",
                            shell_path
                        );
                        return Ok(());
                    }
                }
                SessionConnection::Cancelled {
                    attempt_id: attr_id,
                } => {
                    if attr_id == attempt_id {
                        sessions.remove(&session_id);
                        println!("[start_pty_session] 등록 전 세션 취소가 감지되어 취소되었습니다: id={}", session_id);
                        return Err("세션이 취소되었습니다.".to_string());
                    }
                }
                _ => {}
            }
        }
        println!("[start_pty_session] 현재 시도가 최신이 아니거나 세션이 존재하지 않아 등록을 취소합니다: id={}", session_id);
        Err("다른 연결 시도로 인해 기존 세션 등록이 무시되었습니다.".to_string())
    }
}

// 터미널 세션을 명시적으로 해제하고 좀비 프로세스를 소멸시키는 명령어
#[tauri::command]
async fn close_pty_session(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    println!("[close_pty_session] 세션 종료 요청 수신: id={}", session_id);
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&session_id) {
        match session.connection {
            SessionConnection::Connecting { attempt_id } => {
                session.connection = SessionConnection::Cancelled { attempt_id };
                println!(
                    "[close_pty_session] 연결 중인 세션을 Cancelled로 표시했습니다: id={}",
                    session_id
                );
                Ok(())
            }
            SessionConnection::Cancelled { .. } => {
                println!(
                    "[close_pty_session] 이미 취소 표시된 세션입니다: id={}",
                    session_id
                );
                Ok(())
            }
            _ => {
                sessions.remove(&session_id);
                println!(
                    "[close_pty_session] 세션이 해제되었습니다: id={}",
                    session_id
                );
                Ok(())
            }
        }
    } else {
        println!(
            "[close_pty_session] 종료할 세션이 존재하지 않습니다: id={}",
            session_id
        );
        Err("세션을 찾을 수 없습니다.".to_string())
    }
}

// 터미널 입력 창 등에서 입력한 데이터를 PTY 또는 SSH 채널로 내보내는 명령어
#[tauri::command]
async fn write_to_pty(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    println!(
        "[write_to_pty] 입력 요청 수신: id={}, data={:?}",
        session_id, data
    );
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&session_id) {
        match &mut session.connection {
            SessionConnection::Connecting { .. } | SessionConnection::Cancelled { .. } => {
                let err = "세션이 아직 연결 중이거나 이미 취소되었습니다.".to_string();
                println!("[write_to_pty] {} (id: {})", err, session_id);
                Err(err)
            }
            SessionConnection::Local { writer, .. } => {
                writer.write_all(data.as_bytes()).map_err(|e| {
                    let err = format!("로컬 PTY 쓰기 실패: {}", e);
                    println!("[write_to_pty] {}", err);
                    err
                })?;
                writer.flush().map_err(|e| {
                    let err = format!("로컬 PTY 플러시 실패: {}", e);
                    println!("[write_to_pty] {}", err);
                    err
                })?;
                Ok(())
            }
            SessionConnection::Ssh { channel, .. } => {
                // 블로킹 모드 전환은 리더 스레드의 read 블로킹을 유발하여 Mutex 교착(데드락)을 발생시키므로,
                // 비블로킹 모드를 온전히 유지한 채 try_lock 기반의 write_ssh_channel 헬퍼 함수를 호출합니다.
                write_ssh_channel(channel, data.as_bytes()).map_err(|e| {
                    let err = format!("SSH 채널 쓰기 실패: {}", e);
                    println!("[write_to_pty] {}", err);
                    err
                })?;
                Ok(())
            }
        }
    } else {
        let err = "세션을 찾을 수 없습니다.".to_string();
        println!("[write_to_pty] {} (id: {})", err, session_id);
        Err(err)
    }
}

// 터미널 화면 크기 조정을 PTY/SSH 백엔드에 반영하는 명령어
#[tauri::command]
async fn resize_pty(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&session_id) {
        match &mut session.connection {
            SessionConnection::Connecting { .. } | SessionConnection::Cancelled { .. } => {}
            SessionConnection::Local { master, .. } => {
                master
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|e| e.to_string())?;
            }
            SessionConnection::Ssh { channel, .. } => {
                if let Ok(mut chan) = channel.lock() {
                    chan.request_pty_size(cols as u32, rows as u32, None, None)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    } else {
        Err("세션을 찾을 수 없습니다.".to_string())
    }
}

// 원격 서버에 SSH 연결을 수립하고 PTY 세션을 시작하는 명령어
#[tauri::command]
async fn connect_ssh(
    session_id: String,
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    private_key_path: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let attempt_id = state.next_attempt_id.fetch_add(1, Ordering::SeqCst);

    // 1. 상태 등록 (Connecting)
    {
        let mut sessions = state.sessions.lock().unwrap();
        sessions.insert(
            session_id.clone(),
            TerminalSession {
                id: session_id.clone(),
                connection: SessionConnection::Connecting { attempt_id },
            },
        );
    }

    let addr = format!("{}:{}", host, port);
    let tcp = match TcpStream::connect(&addr) {
        Ok(t) => t,
        Err(e) => {
            cleanup_failed_attempt(&state, &session_id, attempt_id);
            return Err(format!("TCP 연결 실패: {}", e));
        }
    };

    let mut sess = match ssh2::Session::new() {
        Ok(s) => s,
        Err(e) => {
            cleanup_failed_attempt(&state, &session_id, attempt_id);
            return Err(format!("SSH 세션 생성 실패: {}", e));
        }
    };
    let tcp_clone = match tcp.try_clone() {
        Ok(c) => c,
        Err(err) => {
            cleanup_failed_attempt(&state, &session_id, attempt_id);
            return Err(err.to_string());
        }
    };
    sess.set_tcp_stream(tcp_clone);
    if let Err(e) = sess.handshake() {
        cleanup_failed_attempt(&state, &session_id, attempt_id);
        return Err(format!("SSH Handshake 실패: {}", e));
    }

    // 개인키 인증 또는 패스워드 인증 진행
    if let Some(ref key_path) = private_key_path {
        if let Err(e) =
            sess.userauth_pubkey_file(&username, None, std::path::Path::new(key_path), None)
        {
            cleanup_failed_attempt(&state, &session_id, attempt_id);
            return Err(format!("SSH 개인키 인증 실패: {}", e));
        }
    } else if let Some(ref pwd) = password {
        if let Err(e) = sess.userauth_password(&username, pwd) {
            cleanup_failed_attempt(&state, &session_id, attempt_id);
            return Err(format!("SSH 비밀번호 인증 실패: {}", e));
        }
    } else {
        cleanup_failed_attempt(&state, &session_id, attempt_id);
        return Err("패스워드 또는 개인키가 제공되지 않았습니다.".to_string());
    }

    // 원격 PTY 및 쉘 세션 요청 (PTY 규격 80x24를 명시하여 에코백 유실/먹통 방지)
    let mut channel = match sess.channel_session() {
        Ok(c) => c,
        Err(e) => {
            cleanup_failed_attempt(&state, &session_id, attempt_id);
            return Err(format!("SSH 채널 열기 실패: {}", e));
        }
    };
    if let Err(e) = channel.request_pty("xterm-256color", None, Some((80, 24, 0, 0))) {
        cleanup_failed_attempt(&state, &session_id, attempt_id);
        return Err(format!("원격 PTY 요청 실패: {}", e));
    }
    if let Err(e) = channel.shell() {
        cleanup_failed_attempt(&state, &session_id, attempt_id);
        return Err(format!("원격 쉘 실행 실패: {}", e));
    }

    // SSH 비블로킹(Non-blocking) 모드 설정 -> 읽기/쓰기 락 교착 상태 방지
    sess.set_blocking(false);

    let shared_channel = Arc::new(Mutex::new(channel));

    let session_id_clone = session_id.clone();
    let app_clone = app.clone();
    let channel_read_clone = Arc::clone(&shared_channel);

    // 원격 SSH 출력을 계속 읽어 프론트엔드로 이벤트를 송신하는 스레드
    std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        loop {
            let mut has_data = false;
            let mut closed = false;

            {
                if let Ok(mut chan) = channel_read_clone.lock() {
                    match chan.read(&mut buffer) {
                        Ok(0) => {
                            closed = true;
                        }
                        Ok(n) => {
                            has_data = true;
                            let text = String::from_utf8_lossy(&buffer[..n]).to_string();
                            let _ = app_clone.emit(
                                "pty-output",
                                PtyOutputPayload {
                                    session_id: session_id_clone.clone(),
                                    data: text,
                                },
                            );
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            // 읽을 데이터가 현재 없음 (WouldBlock)
                        }
                        Err(_) => {
                            closed = true;
                        }
                    }
                } else {
                    break;
                }
            }

            if closed {
                break;
            }

            // 데이터가 들어오지 않았다면 CPU 부하 방지를 위해 20ms 대기
            if !has_data {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }

        let is_still_active = {
            let app_state = app_clone.state::<AppState>();
            let sessions = app_state.sessions.lock().unwrap();
            sessions.contains_key(&session_id_clone)
        };
        if is_still_active {
            let _ = app_clone.emit("pty-closed", session_id_clone);
        }
    });

    // 세션 보관
    {
        let mut sessions = state.sessions.lock().unwrap();
        if let Some(session) = sessions.get(&session_id) {
            match session.connection {
                SessionConnection::Connecting {
                    attempt_id: attr_id,
                } => {
                    if attr_id == attempt_id {
                        sessions.insert(
                            session_id.clone(),
                            TerminalSession {
                                id: session_id.clone(),
                                connection: SessionConnection::Ssh {
                                    session: sess,
                                    channel: shared_channel,
                                    _tcp: tcp,
                                },
                            },
                        );

                        // SSH 연결 성공 이벤트를 프론트엔드로 발행하여 파일 트리 로드 유도 (레이스 컨디션 방지)
                        let _ = app.emit("ssh-connected", session_id);
                        return Ok(());
                    }
                }
                SessionConnection::Cancelled {
                    attempt_id: attr_id,
                } => {
                    if attr_id == attempt_id {
                        sessions.remove(&session_id);
                        println!(
                            "[connect_ssh] 등록 전 세션 취소가 감지되어 취소되었습니다: id={}",
                            session_id
                        );
                        return Err("세션 연결이 취소되었습니다.".to_string());
                    }
                }
                _ => {}
            }
        }
        println!("[connect_ssh] 현재 시도가 최신이 아니거나 세션이 존재하지 않아 등록을 취소합니다: id={}", session_id);
        Err("다른 연결 시도로 인해 기존 세션 등록이 무시되었습니다.".to_string())
    }
}



// 로컬 디렉토리 생성 명령어
#[tauri::command]
fn create_local_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("폴더 생성 실패: {}", e))
}

// SSH 원격 디렉토리 생성 명령어
#[tauri::command]
fn sftp_create_dir(session_id: String, path: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&session_id) {
        match &session.connection {
            SessionConnection::Ssh { session: ssh_sess, .. } => {
                let sftp = loop {
                    match ssh_sess.sftp() {
                        Ok(sftp) => break sftp,
                        Err(ref e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                        Err(e) => return Err(format!("SFTP 세션 실패: {}", e)),
                    }
                };
                let p = std::path::Path::new(&path);
                loop {
                    match sftp.mkdir(p, 0o755) {
                        Ok(_) => break Ok(()),
                        Err(ref e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                        Err(e) => {
                            let is_dir = loop {
                                match sftp.stat(p) {
                                    Ok(stat) => break stat.is_dir(),
                                    Err(ref se) if se.code() == ssh2::ErrorCode::Session(-37) => {
                                        std::thread::sleep(std::time::Duration::from_millis(10));
                                    }
                                    Err(_) => break false,
                                }
                            };
                            if is_dir {
                                break Ok(());
                            }
                            break Err(format!("원격 폴더 생성 실패: {}", e));
                        }
                    }
                }
            }
            _ => Err("SSH 세션이 아닙니다.".to_string()),
        }
    } else {
        Err("세션을 찾을 수 없습니다.".to_string())
    }
}

// SSH 원격 파일 읽기 명령어 (에디터용)
#[tauri::command]
async fn sftp_read_file(session_id: String, path: String, state: State<'_, AppState>) -> Result<String, String> {
    let sftp = {
        let mut sessions = state.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(&session_id) {
            match &session.connection {
                SessionConnection::Ssh { session: ssh_sess, .. } => {
                    loop {
                        match ssh_sess.sftp() {
                            Ok(sftp) => break sftp,
                            Err(ref e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                                std::thread::sleep(std::time::Duration::from_millis(10));
                            }
                            Err(e) => return Err(format!("SFTP 세션 실패: {}", e)),
                        }
                    }
                }
                _ => return Err("SSH 세션이 아닙니다.".to_string()),
            }
        } else {
            return Err("세션을 찾을 수 없습니다.".to_string());
        }
    }; // Lock dropped

    let res = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let mut remote_file = loop {
            match sftp.open(std::path::Path::new(&path)) {
                Ok(file) => break file,
                Err(ref e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(e) => return Err(format!("원격 파일 열기 실패: {}", e)),
            }
        };

        let mut content = String::new();
        loop {
            match std::io::Read::read_to_string(&mut remote_file, &mut content) {
                Ok(_) => break,
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                Err(e) => return Err(format!("원격 파일 읽기 실패: {}", e)),
            }
        }
        Ok(content)
    }).await;

    match res {
        Ok(inner) => inner,
        Err(e) => Err(format!("비동기 작업 실행 실패: {}", e))
    }
}


// 이미지 파일을 base64로 읽는 명령어 (ThemeEditor 배경 이미지 용)
#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(base64_encode(&buf))
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
        result.push(CHARS[(b0 >> 2)] as char);
        result.push(CHARS[((b0 & 3) << 4) | (b1 >> 4)] as char);
        result.push(if chunk.len() > 1 { CHARS[((b1 & 15) << 2) | (b2 >> 6)] as char } else { '=' });
        result.push(if chunk.len() > 2 { CHARS[b2 & 63] as char } else { '=' });
    }
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new()) // 전역 상태 등록
        .invoke_handler(tauri::generate_handler![
            start_pty_session,
            close_pty_session, // 추가
            write_to_pty,
            resize_pty,
            connect_ssh,
            read_local_dir,
            read_local_file,
            write_local_file,
            sftp_read_dir,
            sftp_read_file,
            create_local_dir,
            sftp_create_dir,
            sftp_transfer_file,
            copy_local_item,
            move_local_item,
            remove_local_item,
            sftp_remove_item,
            sftp_rename_item,
            ssh_exec_command,
            get_local_drives,
            read_file_base64
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
