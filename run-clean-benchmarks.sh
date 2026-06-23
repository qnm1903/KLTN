#!/usr/bin/env bash
# Chạy TUẦN TỰ (không song song) các benchmark CPU-bound để tránh tranh CPU làm sai số đo.
set -u
export PATH="$PATH:/c/Program Files/Go/bin"
ROOT="c:/Users/LENOVO/Downloads/KLTN/escrow-tss"
GG="$ROOT/bench-gg20"

echo "===== [1/3] GG20 preParams (n-independent, 15 mẫu lấy trung vị) ====="
"$GG/gg20bench.exe" -mode preparams -iter 15 > "$GG/gg20_preparams.jsonl" 2>>"$GG/gg20_err.log"
echo "preparams done"

echo "===== [2/3] GG20 keygen+signing theo dải n ====="
: > "$GG/gg20_range.jsonl"
# n nhỏ: 2 mẫu; n lớn: 1 mẫu (chi phí cao, wall-clock đã có caveat tranh CPU 1 máy)
run_gg() { echo "  gg20 $1-of-$2 (iter $3)..."; "$GG/gg20bench.exe" -t "$1" -n "$2" -iter "$3" -json >> "$GG/gg20_range.jsonl" 2>>"$GG/gg20_err.log"; }
run_gg 3 5 2
run_gg 5 7 2
run_gg 7 11 2
run_gg 9 15 2
run_gg 13 21 2
run_gg 17 25 1
run_gg 21 31 1
run_gg 27 40 1
run_gg 37 55 1
echo "gg20 range done"

echo "===== [3/3] Schnorr throughput-vs-n (chạy riêng, sạch) ====="
: > "$ROOT/schnorr_throughput_vs_n.log"
for n in 5 7 11 15 21 25 31 40 55; do
  t=$((2*((n-1)/3)+1))
  node "$ROOT/scripts/experiment-throughput.js" --config "$t,$n" --workers "12" --duration 3000 --warmup 800 2>/dev/null \
    | grep -E "Điểm bão hòa" | sed "s/^/${t}-of-${n}: /" >> "$ROOT/schnorr_throughput_vs_n.log"
done
echo "ALL_CLEAN_DONE"
