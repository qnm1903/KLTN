"""
Vẽ biểu đồ thực nghiệm throughput + so sánh on-chain cho KLTN.

Đọc dữ liệu thật từ:
  - experiments/throughput-260614-5of7.csv       (saturation sweep 5-of-7)
  - experiments/throughput-260614-by-config.csv  (throughput theo nhiều t-of-n)
  - gas_benchmark_results.json                    (gas đo từ Hardhat, N=20)

Xuất PNG vào experiments/charts/:
  1. saturation-5of7.png        — throughput vs số worker (điểm bão hòa + sụp đổ)
  2. latency-vs-threshold.png   — latency/op vs t (đường thẳng → chứng minh O(t) off-chain)
  3. throughput-vs-n.png        — throughput đỉnh vs n, kèm trần on-chain để tương phản
  4. onchain-ceiling.png        — trần throughput on-chain TSS vs MultiSig (settlement/s)
  5. gas-per-settlement.png     — gas/settlement TSS (1 tx) vs MultiSig 5-of-7 (5 tx)

Chạy:
  python scripts/plot_experiment_charts.py
"""
import csv, json, os
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[1]
EXP = ROOT / "experiments"
OUT = EXP / "charts"
OUT.mkdir(parents=True, exist_ok=True)

# Tham số mạng Ethereum (chỉnh tại đây nếu cần)
BLOCK_GAS_LIMIT = 30_000_000   # gas/block (Ethereum mainnet)
BLOCK_TIME_S = 12              # giây/block

plt.rcParams.update({"figure.dpi": 130, "font.size": 11, "axes.grid": True, "grid.alpha": 0.3})


def read_csv(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def threshold_of(config):          # "5-of-7" -> 5
    return int(config.split("-of-")[0])


def n_of(config):                  # "5-of-7" -> 7
    return int(config.split("-of-")[-1])


# ─── 1. Saturation curve (5-of-7) ───────────────────────────────────────────────
def plot_saturation():
    rows = read_csv(EXP / "throughput-260614-5of7.csv")
    w = [int(r["workers"]) for r in rows]
    tp = [float(r["throughput_sig_per_s"]) for r in rows]
    cores = int(rows[0]["cpu_cores"])
    peak = max(range(len(tp)), key=lambda i: tp[i])

    fig, ax = plt.subplots(figsize=(7, 4.2))
    ax.plot(w, tp, "o-", color="#1f77b4", lw=2)
    ax.axvline(cores, color="#888", ls="--", lw=1, label=f"{cores} logical core")
    ax.annotate(f"đỉnh ~{tp[peak]:.0f} sig/s\n@ {w[peak]} worker",
                xy=(w[peak], tp[peak]), xytext=(w[peak]+1, tp[peak]*0.8),
                arrowprops=dict(arrowstyle="->", color="#d62728"), color="#d62728")
    ax.set_xlabel("Số worker (luồng song song)")
    ax.set_ylabel("Throughput (chữ ký/giây)")
    ax.set_title("Điểm bão hòa aggregator off-chain (TSS 5-of-7)")
    ax.legend()
    fig.tight_layout(); fig.savefig(OUT / "saturation-5of7.png"); plt.close(fig)


# ─── 2 & 3. Theo cấu hình (t,n) ─────────────────────────────────────────────────
def by_config():
    rows = read_csv(EXP / "throughput-260614-by-config.csv")
    one, peak = {}, {}
    for r in rows:
        cfg = r["config"]
        if int(r["workers"]) == 1:
            one[cfg] = float(r["avg_lat_ms"])
        else:
            peak[cfg] = float(r["throughput_sig_per_s"])
    cfgs = sorted(one, key=threshold_of)
    return cfgs, one, peak


def onchain_tps(gas_per_settlement):
    return BLOCK_GAS_LIMIT / gas_per_settlement / BLOCK_TIME_S


def plot_latency_vs_threshold():
    cfgs, one, _ = by_config()
    ts = [threshold_of(c) for c in cfgs]
    lat = [one[c] for c in cfgs]

    fig, ax = plt.subplots(figsize=(7, 4.2))
    ax.plot(ts, lat, "s-", color="#2ca02c", lw=2)
    for t, l in zip(ts, lat):
        ax.annotate(f"{l:.1f}", (t, l), textcoords="offset points", xytext=(0, 7), ha="center", fontsize=9)
    ax.set_xlabel("Ngưỡng t (số bên ký)")
    ax.set_ylabel("Thời gian / chữ ký (ms, đơn luồng)")
    ax.set_title("Chi phí off-chain tuyến tính theo t — O(t)")
    fig.tight_layout(); fig.savefig(OUT / "latency-vs-threshold.png"); plt.close(fig)


def plot_throughput_vs_n():
    cfgs, _, peak = by_config()
    ns = [n_of(c) for c in cfgs]
    tp = [peak[c] for c in cfgs]
    tss_ceiling = onchain_tps(TSS_RELEASE)

    fig, ax = plt.subplots(figsize=(7, 4.2))
    ax.plot(ns, tp, "o-", color="#1f77b4", lw=2, label="Off-chain peak (đo thực)")
    ax.axhline(tss_ceiling, color="#d62728", ls="--", lw=1.5,
               label=f"Trần on-chain TSS ~{tss_ceiling:.0f} tx/s")
    for c, x, y in zip(cfgs, ns, tp):
        ax.annotate(c, (x, y), textcoords="offset points", xytext=(0, 7), ha="center", fontsize=8)
    ax.set_xlabel("Số bên tham gia n")
    ax.set_ylabel("Throughput (chữ ký/giây)")
    ax.set_title("Năng lực off-chain vs trần on-chain (log scale)")
    ax.set_yscale("log")
    ax.legend()
    fig.tight_layout(); fig.savefig(OUT / "throughput-vs-n.png"); plt.close(fig)


# ─── 4 & 5. On-chain TSS vs MultiSig ─────────────────────────────────────────────
def load_gas():
    d = json.load(open(ROOT / "gas_benchmark_results.json"))
    tss_release = d["tss"]["release"]["mean"]
    ms = d["multisig_5of7"]
    ms_release = sum(ms[f"signRelease_{i}"]["mean"] if isinstance(ms[f"signRelease_{i}"], dict)
                     else ms[f"signRelease_{i}"] for i in range(1, 6))
    return tss_release, ms_release


def plot_onchain_ceiling():
    tss_tps = onchain_tps(TSS_RELEASE)
    ms_tps = onchain_tps(MS_RELEASE)
    fig, ax = plt.subplots(figsize=(6, 4.2))
    bars = ax.bar(["TSS (1 tx)", "MultiSig 5-of-7 (5 tx)"], [tss_tps, ms_tps],
                  color=["#1f77b4", "#ff7f0e"])
    for b, v in zip(bars, [tss_tps, ms_tps]):
        ax.annotate(f"{v:.1f} tx/s", (b.get_x()+b.get_width()/2, v),
                    textcoords="offset points", xytext=(0, 4), ha="center")
    ax.set_ylabel("Trần settlement on-chain (tx/giây)")
    ax.set_title(f"Trần throughput on-chain (block {BLOCK_GAS_LIMIT//10**6}M gas / {BLOCK_TIME_S}s)\nTSS cao hơn {tss_tps/ms_tps:.1f}×")
    fig.tight_layout(); fig.savefig(OUT / "onchain-ceiling.png"); plt.close(fig)


def plot_gas_per_settlement():
    fig, ax = plt.subplots(figsize=(6, 4.2))
    bars = ax.bar(["TSS (1 tx)", "MultiSig 5-of-7 (5 tx)"], [TSS_RELEASE, MS_RELEASE],
                  color=["#1f77b4", "#ff7f0e"])
    for b, v in zip(bars, [TSS_RELEASE, MS_RELEASE]):
        ax.annotate(f"{v:,} gas", (b.get_x()+b.get_width()/2, v),
                    textcoords="offset points", xytext=(0, 4), ha="center")
    save = (1 - TSS_RELEASE / MS_RELEASE) * 100
    ax.set_ylabel("Gas / settlement (release)")
    ax.set_title(f"Gas mỗi lần giải ngân — TSS tiết kiệm {save:.1f}%")
    fig.tight_layout(); fig.savefig(OUT / "gas-per-settlement.png"); plt.close(fig)


# ─── Mô hình độ trễ E2E (tham số có thể chỉnh) ───────────────────────────────────
BLOCK_TIME_MS = 12_000          # 1 block Ethereum
ROUNDTRIPS_SIGN = 2.5           # R1 (post+ack) + broadcast challenge (0.5) + R2 (post+sig)
ROUNDTRIPS_DKG = 4             # commitments + phát share + verify + final
RTT_LEVELS = [0.5, 5, 20, 50, 100, 200]  # localhost / LAN / ... / WAN-mobile (ms)
RTT_BUDGET = 100               # RTT dùng cho biểu đồ phân rã (WAN ~100ms)


def baselines():
    """Đọc số đo thật cho 5-of-7: client ký, client DKG (per-party), backend aggregate (ms)."""
    cl = {r["phase"]: float(r["avg_ms"]) for r in read_csv(EXP / "party-compute-260614.csv")
          if r["config"] == "5-of-7"}
    be = next(float(r["avg_lat_ms"]) for r in read_csv(EXP / "throughput-260614-by-config.csv")
              if r["config"] == "5-of-7" and r["workers"] == "1")
    return cl.get("SIGN_TOTAL", cl.get("R1", 0) + cl.get("R2", 0)), cl.get("DKG_TOTAL", 0), be


# ─── 7. Phân rã độ trễ E2E 1 giao dịch ───────────────────────────────────────────
def plot_latency_budget():
    fe_sign, _, be_agg = baselines()
    net = ROUNDTRIPS_SIGN * RTT_BUDGET
    comps = [("Client/bên (ký)", fe_sign), ("Backend (tổng hợp)", be_agg),
             (f"Mạng ({ROUNDTRIPS_SIGN}×{RTT_BUDGET}ms RTT)", net), ("On-chain (1 block)", BLOCK_TIME_MS)]
    labels = [c[0] for c in comps][::-1]
    vals = [c[1] for c in comps][::-1]
    colors = ["#d62728", "#f58518", "#54a24b", "#4c78a8"]

    fig, ax = plt.subplots(figsize=(7.5, 3.8))
    bars = ax.barh(labels, vals, color=colors)
    ax.set_xscale("log")
    for b, v in zip(bars, vals):
        ax.annotate(f"{v:,.1f} ms", (v, b.get_y() + b.get_height() / 2),
                    textcoords="offset points", xytext=(5, 0), va="center", fontsize=9)
    off = fe_sign + be_agg + net
    ax.set_xlabel("Thời gian (ms, log scale)")
    ax.set_title(f"Phân rã độ trễ E2E 1 giao dịch ký (WAN {RTT_BUDGET}ms)\n"
                 f"Off-chain tổng ~{off:.0f}ms = {off/BLOCK_TIME_MS*100:.1f}% on-chain → blockchain là nút cổ chai")
    fig.tight_layout(); fig.savefig(OUT / "latency-budget.png"); plt.close(fig)


# ─── 8. Độ nhạy theo RTT mạng ─────────────────────────────────────────────────────
def plot_rtt_sensitivity():
    fe_sign, fe_dkg, be_agg = baselines()
    sign_wall = [fe_sign + be_agg + ROUNDTRIPS_SIGN * r for r in RTT_LEVELS]
    dkg_wall = [fe_dkg + ROUNDTRIPS_DKG * r for r in RTT_LEVELS]

    fig, ax = plt.subplots(figsize=(7.5, 4.4))
    ax.plot(RTT_LEVELS, sign_wall, "o-", color="#d62728", lw=2, label="Ký 1 giao dịch (off-chain)")
    ax.plot(RTT_LEVELS, dkg_wall, "s-", color="#f58518", lw=2, label="DKG (1 lần, off-chain)")
    ax.axhline(BLOCK_TIME_MS, color="#4c78a8", ls="--", lw=1.5, label=f"On-chain 1 block ({BLOCK_TIME_MS}ms)")
    for r, y in zip(RTT_LEVELS, sign_wall):
        ax.annotate(f"{y:.0f}", (r, y), textcoords="offset points", xytext=(0, 6), ha="center", fontsize=8)
    ax.set_xlabel("RTT mạng giữa các bên (ms)")
    ax.set_ylabel("Wall-time off-chain (ms, log)")
    ax.set_yscale("log")
    ax.set_title("Độ nhạy độ trễ theo RTT mạng (giao thức 2-round)\nNgay cả WAN 200ms, off-chain vẫn ≪ 1 block")
    ax.legend(fontsize=9)
    fig.tight_layout(); fig.savefig(OUT / "rtt-sensitivity.png"); plt.close(fig)


# ─── 6. Per-party compute (generic, quét t-of-n) ─────────────────────────────────
def plot_party_compute():
    path = EXP / "party-compute-260614.csv"
    if not path.exists():
        print("(bỏ qua per-party chart — chưa có CSV)"); return
    rows = read_csv(path)
    phases = ["GEN", "DIST", "VERIFY", "AGG", "R1", "R2"]
    labels = {"GEN": "GEN poly+commit", "DIST": "DIST tính share", "VERIFY": "VERIFY (Feldman)",
              "AGG": "AGG tổng hợp+pubkey", "R1": "R1 nonce", "R2": "R2 z-share"}
    data = {}  # config -> {phase: avg}
    for r in rows:
        if r["phase"] in phases:
            data.setdefault(r["config"], {})[r["phase"]] = float(r["avg_ms"])
    cfgs = sorted(data, key=n_of)
    fig, ax = plt.subplots(figsize=(7.5, 4.4))
    bottom = [0.0] * len(cfgs)
    colors = ["#4c78a8", "#72b7b2", "#e45756", "#54a24b", "#f58518", "#b279a2"]
    for ph, col in zip(phases, colors):
        vals = [data[c].get(ph, 0) for c in cfgs]
        ax.bar(cfgs, vals, bottom=bottom, label=labels[ph], color=col)
        bottom = [b + v for b, v in zip(bottom, vals)]
    for c, tot in zip(cfgs, bottom):
        ax.annotate(f"{tot:.0f}ms", (c, tot), textcoords="offset points", xytext=(0, 3), ha="center", fontsize=9)
    ax.set_xlabel("Cấu hình t-of-n (ngưỡng BFT)")
    ax.set_ylabel("Thời gian / bên (ms)")
    ax.set_title("Chi phí tính toán mỗi bên (mô phỏng generic, VSS/EC)\nTổng < 70ms ở mọi (t,n) — không đáng kể vs 12.000ms/block")
    ax.legend(fontsize=8, ncol=2)
    fig.tight_layout(); fig.savefig(OUT / "party-compute.png"); plt.close(fig)


# ─── 9. Gas scaling: TSS O(1) vs MultiSig O(t) ───────────────────────────────────
def plot_gas_scaling():
    # TSS release = O(1): contract verify 1 chữ ký tổng hợp → gas không đổi theo t/n.
    # MultiSig = O(t): cần t giao dịch signRelease (mỗi signer 1 tx).
    d = json.load(open(ROOT / "gas_benchmark_results.json"))
    ms = d["multisig_5of7"]
    per_sig = sum((ms[f"signRelease_{i}"]["mean"] if isinstance(ms[f"signRelease_{i}"], dict)
                   else ms[f"signRelease_{i}"]) for i in range(1, 6)) / 5
    ts = [1, 3, 5, 7, 9, 11, 13]
    tss = [TSS_RELEASE] * len(ts)
    msig = [t * per_sig for t in ts]

    fig, ax = plt.subplots(figsize=(7.5, 4.4))
    ax.plot(ts, msig, "s-", color="#ff7f0e", lw=2, label=f"MultiSig — O(t), ~{per_sig:,.0f} gas/chữ ký")
    ax.plot(ts, tss, "o-", color="#1f77b4", lw=2, label=f"TSS — O(1), ~{TSS_RELEASE:,} gas")
    ax.scatter([5], [MS_RELEASE], marker="*", s=240, color="#d62728", zorder=5,
               label=f"MultiSig 5-of-7 đo thực ({MS_RELEASE:,})")
    save5 = (1 - TSS_RELEASE / msig[2]) * 100
    save13 = (1 - TSS_RELEASE / msig[-1]) * 100
    ax.annotate(f"tiết kiệm {save5:.0f}%", (5, msig[2]), textcoords="offset points", xytext=(6, -4), fontsize=9, color="#d62728")
    ax.annotate(f"tiết kiệm {save13:.0f}%", (13, msig[-1]), textcoords="offset points", xytext=(-70, 4), fontsize=9, color="#d62728")
    ax.set_xlabel("Ngưỡng t (số bên ký bắt buộc)")
    ax.set_ylabel("Gas giải ngân (release)")
    ax.set_title("Gas on-chain theo ngưỡng: TSS O(1) phẳng vs MultiSig O(t)\nKhoảng cách càng giãn khi t tăng")
    ax.legend(fontsize=9)
    fig.tight_layout(); fig.savefig(OUT / "gas-scaling-vs-threshold.png"); plt.close(fig)


# ─── 10 & 11. Fault tolerance / liveness ──────────────────────────────────────────
def _load_fault():
    path = EXP / "fault-tolerance-260614.csv"
    if not path.exists():
        return None
    return read_csv(path)


def plot_fault_spof(focus="5-of-7"):
    rows = _load_fault()
    if not rows:
        print("(bỏ qua fault chart — chưa có CSV)"); return
    series = {"mediator_only": [], "random_release": []}
    for r in rows:
        if r["config"] == focus and r["scenario"] in series:
            series[r["scenario"]].append((int(r["k"]), float(r["success_rate"]) * 100))
    fig, ax = plt.subplots(figsize=(7.5, 4.4))
    styles = {"mediator_only": ("o-", "#1f77b4", "Lỗi chỉ ở mediator (best case)"),
              "random_release": ("s-", "#d62728", "Lỗi ngẫu nhiên (release cần buyer+seller)")}
    for sc, pts in series.items():
        pts.sort()
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        st, col, lab = styles[sc]
        ax.plot(xs, ys, st, color=col, lw=2, label=lab)
    ax.set_xlabel("Số bên lỗi/offline (k)")
    ax.set_ylabel("Tỉ lệ ký release thành công (%)")
    ax.set_title(f"Dung sai lỗi & SPOF core party ({focus})\nKhoảng cách 2 đường = tác động SPOF của buyer/seller")
    ax.set_ylim(-5, 105)
    ax.legend(fontsize=9)
    fig.tight_layout(); fig.savefig(OUT / "fault-tolerance-spof.png"); plt.close(fig)


def plot_fault_tolerance_summary():
    rows = _load_fault()
    if not rows:
        return
    meta = {r["config"]: r for r in rows if r["scenario"] == "meta"}
    cfgs = sorted(meta, key=n_of)
    crash = [int(meta[c]["crash_tolerance"]) for c in cfgs]
    fbyz = [int(meta[c]["f_byzantine"]) for c in cfgs]
    x = range(len(cfgs))
    fig, ax = plt.subplots(figsize=(7.5, 4.4))
    ax.bar([i - 0.2 for i in x], crash, 0.4, label="Dung sai crash (n−t, best case)", color="#4c78a8")
    ax.bar([i + 0.2 for i in x], fbyz, 0.4, label="Dung sai Byzantine (f=⌊(n−1)/3⌋)", color="#f58518")
    for i, (cr, fb) in enumerate(zip(crash, fbyz)):
        ax.annotate(str(cr), (i - 0.2, cr), textcoords="offset points", xytext=(0, 3), ha="center", fontsize=9)
        ax.annotate(str(fb), (i + 0.2, fb), textcoords="offset points", xytext=(0, 3), ha="center", fontsize=9)
    ax.set_xticks(list(x)); ax.set_xticklabels(cfgs)
    ax.set_xlabel("Cấu hình t-of-n")
    ax.set_ylabel("Số bên lỗi tối đa chịu được")
    ax.set_title("Dung sai lỗi theo cấu hình: crash (liveness) vs Byzantine")
    ax.legend(fontsize=9)
    fig.tight_layout(); fig.savefig(OUT / "fault-tolerance-summary.png"); plt.close(fig)


# ─── 12. Độ nhạy theo mất gói (mở rộng RTT) ──────────────────────────────────────
def plot_packet_loss():
    fe_sign, _, be_agg = baselines()
    base = fe_sign + be_agg
    ploss = [0, 0.01, 0.02, 0.05, 0.1, 0.2]
    fig, ax = plt.subplots(figsize=(7.5, 4.4))
    colors = {50: "#54a24b", 100: "#f58518", 200: "#d62728"}
    for rtt in (50, 100, 200):
        rto = max(200, 3 * rtt)  # TCP retransmit timeout (min ~200ms)
        wall = [base + ROUNDTRIPS_SIGN * (rtt + (p / (1 - p)) * rto) for p in ploss]
        ax.plot([p * 100 for p in ploss], wall, "o-", color=colors[rtt], lw=2, label=f"RTT {rtt}ms")
    ax.axhline(BLOCK_TIME_MS, color="#4c78a8", ls="--", lw=1.5, label=f"On-chain 1 block ({BLOCK_TIME_MS}ms)")
    ax.set_xlabel("Tỉ lệ mất gói (%)")
    ax.set_ylabel("Wall-time ký off-chain (ms, log)")
    ax.set_yscale("log")
    ax.set_title("Độ nhạy độ trễ ký theo mất gói (TCP retransmit ~RTO)\nNgay cả mất 20% gói + WAN 200ms vẫn ≪ 1 block")
    ax.legend(fontsize=9)
    fig.tight_layout(); fig.savefig(OUT / "rtt-packet-loss.png"); plt.close(fig)


if __name__ == "__main__":
    TSS_RELEASE, MS_RELEASE = load_gas()
    plot_gas_scaling()
    plot_fault_spof()
    plot_fault_tolerance_summary()
    plot_packet_loss()
    plot_party_compute()
    plot_latency_budget()
    plot_rtt_sensitivity()
    plot_saturation()
    plot_latency_vs_threshold()
    plot_throughput_vs_n()
    plot_onchain_ceiling()
    plot_gas_per_settlement()
    print(f"TSS release  = {TSS_RELEASE:,} gas/tx")
    print(f"MultiSig 5/7 = {MS_RELEASE:,} gas (5 tx)")
    print(f"On-chain ceiling: TSS ~{onchain_tps(TSS_RELEASE):.1f} tx/s | MultiSig ~{onchain_tps(MS_RELEASE):.1f} tx/s")
    print(f"Charts saved -> {OUT}")
