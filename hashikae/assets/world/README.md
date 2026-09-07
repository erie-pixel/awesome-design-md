# 홈 월드 레이어 (쿼터뷰, 사용자 아트 2026-09-07 · docs/prompts/03_quarterview.md)
#   ground.webp        지면판 940×1672(건물 없음, 이벤트 부스는 그려져 있음) — 원본 art-src/world/ground_src.png
#   bd_house.webp      집(782×752, 좌우반전은 CSS)      bd_shop.webp  가게(798×771, 글로우 헤일로 제거 dehalo)
#   bd_arcade.webp     게임센터(1000×750, 좌우반전은 CSS)
#   bd_<id>_night.webp 밤 버전(v70) · cloud_*.webp 구름 · deco_*.webp 시즌 장식
# 변환: NODE_PATH=… node tools/to-webp.js <src> <out> <maxW> <maxH> <trim 1> [q] [dehalo 1]
# 좌표: data/locations.js pos(스테이지 %). 중심(px)·폭(px)에서 % 환산은 scratch compose67.js 참고(README v68)
