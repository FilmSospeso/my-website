# Film Sospeso Website

영상 제작 스튜디오 **필름 소스페소(Film Sospeso)** 홈페이지 — https://filmsospeso.github.io/my-website/

## 구성
| 경로 | 내용 |
|---|---|
| `index.html` | 홈페이지 전체 (HTML · CSS · JS 한 파일) |
| `assets/` | 히어로 영상(`reel-1080.mp4` PC, `reel-720.mp4` 모바일), 포스터, 로고, 파비콘, 공유 썸네일 |
| `apps-script/Code.gs` | 문의 폼 → 구글 시트 '문의' 탭 + 알림 메일 (Apps Script 웹 앱) |
| `admin-app/` | 문의·고객·프로젝트·일정·정산 관리 웹앱 (Apps Script, 팀원 전용) |

## 포트폴리오 추가하는 법
`index.html` 에서 `<!-- ===== 작업 =====` 아래의 `<article class="work-item" ...>` 블록을 하나 복사해
유튜브 영상 ID(`watch?v=` 뒤 문자열, 링크와 썸네일 주소 두 곳), 제목, 역할, 설명만 바꾸면 됩니다.
- 대표작은 `data-featured` 를 붙여 맨 앞에 둡니다 (맨 앞 하나가 크게 보임). 처음엔 6개가 보이고 나머지는 '더 보기'
- `data-category`: `mv` 뮤직비디오 · `brand` 브랜드/광고 · `pr` 기업홍보 · `film` 영화 · `vj` VJ · `event` 행사

## 디자인 기준 (2026-11 개편)
- 남색 바탕 `#0a0d14` · 흰 글자 `#e9edf3` · 강조색은 콘플라워 블루 `#5a9bfc` 하나 (버튼 · 문의 영역에만)
- 글꼴: 영문 General Sans + 한글 Pretendard. 글자 크기는 `:root` 의 `--step-*` 여섯 단계만 사용
- 그라데이션 · 빛번짐 · 그림자 · 번호 카드(01/02) · 영문 작은 라벨은 쓰지 않습니다 (AI 템플릿 느낌)
- `assets/frames/` 는 릴 영상에서 뽑은 장면

## 히어로 영상 교체
원본에 위아래 레터박스가 있으면 잘라내고, 소리 없이 압축합니다.
```bash
ffmpeg -i 원본.mp4 -an -vf "crop=3840:1600:0:280,scale=1920:-2" -c:v libx264 -crf 31 -movflags +faststart assets/reel-1080.mp4
ffmpeg -i 원본.mp4 -an -vf "crop=3840:1600:0:280,scale=1280:-2" -c:v libx264 -crf 31 -movflags +faststart assets/reel-720.mp4
ffmpeg -ss 1.5 -i assets/reel-1080.mp4 -frames:v 1 assets/hero-poster.jpg
```

## 로컬 미리보기
```bash
python3 -m http.server 8000   # http://localhost:8000
```
