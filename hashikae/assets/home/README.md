# 홈 화면 아트

| 파일 | 내용 | 규격 |
|---|---|---|
| `bg.webp` | 마을 배경(세로). 건물이 그려져 있고, 그 위에 버튼 그림이 정확히 겹친다 | 866×1817 |
| `play.webp` | PLAY(아케이드) 건물 버튼 | 863×900 투명 |
| `store.webp` | MY STORE(가게) 건물 버튼 | 900×881 투명 |

원본은 `../../../art-src/`. 변환: `node tools/to-webp.js <src> <out.webp> <maxW> <maxH> <trim> [q]`

버튼 PNG는 **누르는 동안만** 배경 위에 떠오른다(평소엔 배경 그림만).

**배경을 바꾸면** 버튼 좌표를 다시 맞춰야 한다:
1. `src/ui/menu.js`의 `BG = { w, h }`를 새 배경 크기로
2. `NODE_PATH=… node tools/home-fit.js public/assets/home/bg.webp public/assets/home/play.webp <left> <top> <width> 4` 로 자동 탐색
   (결과 best가 스테이지 % — 그대로 쓴다). 눈으로 확인하려면 `tools/home-calibrate.html`
3. (수동 측정 시에만) 세로값 환산: `top_stage% = top_screen% × 780 / (H × 390 / W)`
4. `src/shell.html`의 `.hm-spot.play` / `.hm-spot.store`에 반영
