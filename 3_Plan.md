# Development Implementation Plan
## 프로젝트명: Terminal Avy (터미널 에이비) 개발 계획서

본 문서는 `2_PRD.md`에 정의된 요구사항을 실현하기 위한 구체적인 시스템 아키텍처 설계 및 단계별 개발 구현 계획(Plan)을 정의합니다. 본 프로젝트는 경량화와 고성능을 동시에 달성하기 위해 **Tauri(Rust Backend + Web Frontend)** 아키텍처를 기반으로 설계되었습니다.

---

## 1. 시스템 아키텍처 및 모듈 구성 (System Architecture)

Terminal Avy는 Rust로 빌드되는 네이티브 백엔드 영역과 HTML/JS(React+TS)로 구동되는 크로스 플랫폼 프론트엔드 영역이 Tauri의 IPC(Inter-Process Communication)를 통해 고성능으로 통신하는 구조입니다.

```mermaid
graph TD
    subgraph Frontend [Tauri Frontend (React + TS)]
        UI[Workspace UI / Split Panes]
        Term[xterm.js Terminals]
        Editor[Monaco Editor]
        FT[File Tree UI]
        AI[AI Chat Panel]
        State[State Manager: Zustand/Redux]
    end

    subgraph Backend [Tauri Backend (Rust Core)]
        TauriBridge[Tauri Commands / IPC Bridge]
        PTY[PTY Manager: conpty/portable-pty]
        SSH[SSH/SFTP Client: russh/ssh2-rs]
        FS[Local File System API]
        Db[SQLite/JSON Config Store]
        LLM[Local LLM Client]
    end

    UI -->|IPC Commands| TauriBridge
    TauriBridge --> PTY
    TauriBridge --> SSH
    TauriBridge --> FS
    TauriBridge --> Db
    TauriBridge --> LLM

    PTY <-->|Stdout/Stderr Data Stream| Term
    SSH <-->|SFTP Stream / Shell PTY| Term
```

### 1.1. 주요 구성 모듈 설명
* **PTY Manager (Rust)**: Windows OS의 `ConPTY`를 활용하여 로컬 쉘(PowerShell, Cmd, WSL 등)의 세션을 제어하고 입출력 바이트 스트림을 프론트엔드로 전달합니다.
* **SSH/SFTP Client (Rust)**: 원격 서버와의 SSH 연결을 수립하고, SFTP 프로토콜을 백그라운드 스레드로 실행하여 파일 탐색 및 파일 전송(업로드/다운로드)을 고성능으로 처리합니다.
* **Block Parser (Frontend/Backend)**: 사용자의 Enter 입력 및 프롬프트 감지 로직을 기반으로 명령어 실행 단위별로 데이터를 버퍼링하고 UI 상에서 '블록' 단위로 분할하여 관리합니다.
* **Layout Manager (Frontend)**: CSS Grid/Flexbox 및 Pane Splitter 라이브러리를 이용하여 가로/세로 화면 분할 상태를 동적으로 제어합니다.
* **LLM Connector (Backend/Frontend)**: 로컬 호스트(`http://localhost:11434` 등)에서 구동되는 Ollama나 LM Studio 등 로컬 AI 모델 API와 직접 통신하며 컨텍스트(에러 로그 등)를 담은 프롬프트를 전송합니다.

---

## 2. 단계별 개발 구현 로드맵 (Phased Roadmap)

### [Phase 1] 개발 환경 셋업 및 기본 터미널 구축 (Core Terminal)
* **목표**: Tauri 개발 환경 구축 및 로컬 PowerShell/CMD 연동 터미널 화면 렌더링
* **세부 작업**:
  1. Tauri 프로젝트 초기화 (`tauri` + `vite` + `react` + `typescript`)
  2. 프론트엔드 디자인 시스템 및 Tailwind CSS 세팅
  3. `xterm.js` 컴포넌트 연동 및 WebGL 렌더링 가속 설정
  4. Rust 백엔드에 `portable-pty` 라이브러리를 사용한 Windows ConPTY 세션 바인딩 구현
  5. IPC 채널을 통한 터미널 양방향 데이터 스트리밍(Input -> PTY, Output -> xterm.js) 구현
  6. 한글 및 IME 특성 분석 및 타이핑 버그 수정 (한글 자모 분리 방지)

### [Phase 2] Warp 스타일 블록형 터미널 구현 (Block System)
* **목표**: 터미널 출력 결과를 명령어 단위로 그룹화하여 블록 UI로 시각화 및 제어 기능 구현
* **세부 작업**:
  1. 사용자 입력(Command input)과 출력 데이터(Output buffer)를 감지하여 명령어 경계를 파싱하는 알고리즘 설계
  2. 전체 스크롤 방식 대신 개별 명령어 블록 컴포넌트(Block Container) 단위로 렌더링하는 UI 구조 구현
  3. 개별 블록 우측 컨트롤러 바 추가:
     * 명령어 복사 (Copy Command)
     * 출력 복사 (Copy Output)
     * 블록 재실행 (Re-run Block)
  4. 대용량 출력 블록 접기/펼치기(Collapse/Expand) 기능 및 스크롤 성능 최적화

### [Phase 3] 화면 분할 및 세션 구성 저장 (Layout & Session)
* **목표**: 자유로운 다중 화면 분할 레이아웃 제어 및 전체 세션 상태 영구 저장
* **세부 작업**:
  1. 모듈러 터미널 컨테이너 설계 및 분할 뷰 라이브러리(예: `react-resizable-panels` 등) 연동
  2. 세션별 독립적인 글꼴 크기 제어 시스템 구축 (`Ctrl + '+'`, `Ctrl + '-'` 단축키 바인딩)
  3. 세션 구성 상태 저장을 위한 JSON 기반 스토리지 설계 (Rust 백엔드 내부 파일 저장소 활용)
     * 저장 항목: 화면 분할 트리 구조, 각 세션의 종류(Local/SSH), 접속 경로, 세션 커스텀 제목
  4. 저장된 세션 프로필 로딩 및 다중 연결 복구 자동화 스크립트 작성

### [Phase 4] 내장 파일 관리자, 에디터 및 SSH 드래그 앤 드롭 (File & Editor)
* **목표**: 파일 탐색기와 내장 에디터를 통한 파일 즉각 수정 및 원활한 SSH 파일 전송 구현
* **세부 작업**:
  1. 사이드바 영역에 로컬 디렉터리 트리 UI 구현 (Rust FS API 연동)
  2. Monaco Editor 컴포넌트 임베딩 및 파일 확장자별 구문 강조(Syntax Highlighting) 제공
  3. Rust 백엔드 내 SSH2/SFTP 통신 모듈 구축 (서버 접속 및 파일 트리 동기화)
  4. 드래그 앤 드롭(Drag and Drop) 이벤트 버블링 처리:
     * Windows OS 탐색기에서 파일 드래그 시 Tauri API(`tauri-plugin-drag-drop` 등)로 감지 후, 현재 포커스된 SSH 세션에 SFTP 업로드
     * SSH 파일 트리에서 파일을 드래그하여 로컬 디렉토리 영역으로 가져올 시 SFTP 다운로드 실행
  5. 파일 전송 상태 및 속도를 모니터링하기 위한 상태 관리 채널 및 UI 프로그레스 바 구현

### [Phase 5] AI 어시스턴트 및 로컬 LLM 통합 (AI Assistant)
* **목표**: 하단 고정 AI 대화창 구축 및 로컬 LLM 연동 최적화
* **세부 작업**:
  1. 화면 하단에 고정된 접이식 AI Chat Panel UI 구현
  2. 로컬 LLM (Ollama: `localhost:11434` / LM Studio: `localhost:1234`) 설정을 관리할 수 있는 LLM Config 모달 메뉴 개발
  3. 터미널 에러 로그 발생 시 마우스 우클릭을 통해 에러 텍스트를 AI 컨텍스트로 바로 추가하는 기능 개발
  4. 프롬프트 템플릿 최적화 (터미널 명령어 가이드 및 문제 해결용 시스템 프롬프트 탑재)
  5. 최종 통합 빌드(Windows MSI 및 단일 실행 파일 빌드 설정) 및 최종 QA 테스트 진행

---

## 3. 핵심 기술 도전 과제 및 해결 방안 (Technical Challenges)

### 3.1. Windows ConPTY 연동 및 한글 깨짐 이슈
* **이슈**: Windows 개발 환경에서 PTY 바이트 스트림을 UTF-8 인코딩으로 정확히 변환하지 않으면 한글 및 완성형 문자가 깨져 출력됨.
* **해결책**:
  * Rust의 `portable-pty` 라이브러리를 사용하여 PTY 프로세스 시작 시 UTF-8 코드페이지를 강제 지정하고, 스트림 리더에서 무손실 UTF-8 변환 라이브러리를 거쳐 프론트엔드로 전달합니다.
  * xterm.js 옵션 중 `convertEol: true` 속성을 지정하여 Windows 개행문자(`\r\n`)가 깨지지 않도록 방지합니다.

### 3.2. 터미널 블록 파싱의 정확도 확보
* **이슈**: 터미널 출력은 무작위 바이트 스트림으로 전달되므로 언제 명령어가 시작되고 끝났는지 파싱하기가 기술적으로 모호함.
* **해결책**:
  * 프론트엔드에서 명령어 입력 단축키(Enter) 이벤트 시점을 캡처하고, 쉘의 프롬프트 문자열 패턴(예: `C:\Users\..>` 혹은 `ubuntu@server:~$`)을 정규식으로 실시간 매칭 감지하여 하나의 블록 시작과 끝을 마킹합니다.

### 3.3. SSH 드래그 앤 드롭 파일 전송 처리
* **이슈**: 외부 운영체제(Windows 탐색기)에서 드래그하여 브라우저 컴포넌트(Tauri webview) 안의 특정 영역(SSH 세션)으로 떨군 파일 경로를 추출해야 함.
* **해결책**:
  * Tauri의 `tauri::window::Window` 인스턴스에 `on_drag_drop_event` 리스너를 바인딩하여 드롭된 파일의 절대 경로 배열을 Rust 백엔드로 수신합니다.
  * 드롭이 감지된 시점에 현재 활성화된(Focus) 탭/세션이 SSH인 경우, 해당 SSH 세션의 SFTP 객체를 참조하여 비동기 파일 업로드 태스크(Tauri Thread Pool 활용)를 트리거합니다.

---

## 4. 검증 및 테스트 계획 (Verification Plan)

### 4.1. 단위 기능 검증
* **PTY Stream Test**: PowerShell을 띄워 대용량 텍스트 출력 실행 시 프리징 현상 유무 점검.
* **SFTP Transfer Test**: 100MB 이상의 파일을 로컬에서 SSH 서버로 드래그 앤 드롭 전송 후, MD5 체크섬 비교를 통해 무결성 검증.
* **Korean IME Test**: 한글 모아쓰기가 빈번한 긴 문장을 고속 타이핑하여 한글 누락 현상 검증.

### 4.2. 시나리오 및 통합 테스트
1. **세션 저장 및 복구**:
   * 로컬 분할 세션 2개와 SSH 분할 세션 1개를 배치한 뒤, 현재 세션 구성 프로필을 '운영서버환경'으로 저장.
   * 앱 종료 후 재실행 시, 저장 목록에서 '운영서버환경'을 클릭했을 때 패널 분할 구성과 SSH 자동 로그인이 완료되는지 테스트.
2. **AI 에러 디버깅 시나리오**:
   * 터미널에 일부러 틀린 명령어(예: `npm run devv`)를 입력하고 출력된 에러 코드를 마우스 우클릭하여 'AI에게 해결 요청'을 수행.
   * 하단 AI 창에 에러 내용이 자동으로 들어가며 적절한 해결 명령어(`npm run dev`)가 가이드로 도출되는지 확인.
