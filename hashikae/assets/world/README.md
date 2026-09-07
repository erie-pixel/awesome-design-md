# 홈 월드 레이어 (docs/HOMEWORLD_PLAN.md 5~6장)
#   ground.webp        빈 지면판(건물 없음) — 있으면 layered 모드: 전 건물 스프라이트 상시 표시, 없으면 home/bg.webp 사용
#   far.webp / front.webp   원경 / 전경 소품 띠(투명)
#   bd_<id>.webp       건물 낮 스프라이트 (arcade·shop은 v62 사용자 아트 그대로) · bd_<id>_night.webp 밤 버전
#   cloud_1~3.webp     구름(v68)   deco_<season>.webp 시즌 장식(v69)
# 위치·히트 영역은 src/data/locations.js. 건물 좌표 재측정: NODE_PATH=… node tools/home-fit.js <ground> <bd> <left> <top> <width> 4
