# 홈 화면 아트

| 파일 | 내용 | 규격 |
|---|---|---|
| `bg.webp` | 마을 배경(세로). 건물이 그려져 있고, 그 위에 버튼 그림이 정확히 겹친다 | 866×1817 |
| `play.webp` | PLAY(아케이드) 건물 버튼 | 863×900 투명 |
| `store.webp` | MY STORE(가게) 건물 버튼 | 900×881 투명 |

원본은 `../../../art-src/`. 변환: `node tools/to-webp.js <src> <out.webp> <maxW> <maxH> <trim> [q]`

**배경을 바꾸면** 버튼 좌표를 다시 맞춰야 한다:
1. `src/ui/menu.js`의 `BG = { w, h }`를 새 배경 크기로
2. `tools/home-calibrate.html`을 열어 `?play=left,top,width&store=...&op=0.6`으로 눈으로 맞춘다(390×780 기준)
3. 세로값만 스테이지 기준으로 환산: `top_stage% = top_screen% × 780 / (H × 390 / W)`
4. `src/shell.html`의 `.hm-spot.play` / `.hm-spot.store`에 반영
