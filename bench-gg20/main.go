// gg20bench — đo chi phí thật của ECDSA threshold (GG20) bằng thư viện kiểm toán
// bnb-chain/tss-lib v2. Đo 3 thành phần off-chain đặc thù của GG20:
//   preParams  — sinh số nguyên tố an toàn Paillier (chi phí nặng nhất của keygen)
//   keygen     — giao thức DKG đầy đủ (KÈM ZK proof — KHÔNG tắt SetNoProof*)
//   signing    — ký ngưỡng với đúng t bên (MtA + range proof)
//
// Khác Schnorr/BLS: GG20 tương tác nhiều vòng nên đo theo thời gian thực (wall-clock)
// của toàn giao thức chạy cục bộ, cùng preParams trung bình mỗi bên.
//
// Usage: go run . -t 5 -n 7 -json
package main

import (
	"crypto/ecdsa"
	"encoding/json"
	"flag"
	"fmt"
	"math/big"
	"runtime"
	"sync/atomic"
	"time"

	"github.com/bnb-chain/tss-lib/v2/common"
	ckg "github.com/bnb-chain/tss-lib/v2/ecdsa/keygen"
	csigning "github.com/bnb-chain/tss-lib/v2/ecdsa/signing"
	"github.com/bnb-chain/tss-lib/v2/test"
	"github.com/bnb-chain/tss-lib/v2/tss"
)

func main() {
	tPtr := flag.Int("t", 5, "ngưỡng t (số bên cần để ký)")
	nPtr := flag.Int("n", 7, "tổng số bên n")
	jsonOut := flag.Bool("json", false, "in JSON")
	mode := flag.String("mode", "full", "full | preparams")
	iter := flag.Int("iter", 1, "số lần lặp (lấy mẫu variance)")
	nozk := flag.Bool("nozk", false, "tắt ZK proof keygen (Mod/Fac) — KHÔNG an toàn, chỉ để phân rã chi phí")
	flag.Parse()
	t, n := *tPtr, *nPtr
	threshold := t - 1 // tss-lib: cần threshold+1 bên để ký

	// preParams ĐỘC LẬP với n (mỗi bên tự sinh Paillier safe primes). Đo riêng nhiều lần
	// để lấy trung vị + dải (variance tìm số nguyên tố rất cao).
	if *mode == "preparams" {
		for k := 0; k < *iter; k++ {
			s := time.Now()
			if _, err := ckg.GeneratePreParams(10 * time.Minute); err != nil {
				panic(err)
			}
			fmt.Printf("{\"preparams_ms\":%d}\n", time.Since(s).Milliseconds())
		}
		return
	}

	for k := 0; k < *iter; k++ {
		runOnce(t, n, threshold, *jsonOut, *nozk)
	}
}

func runOnce(t, n, threshold int, jsonOut, nozk bool) {

	pIDs := tss.GenerateTestPartyIDs(n)
	p2pCtx := tss.NewPeerContext(pIDs)

	// ── 1) preParams: sinh safe primes Paillier cho mỗi bên (đo trung bình) ──
	preParams := make([]*ckg.LocalPreParams, n)
	var preSum time.Duration
	for i := 0; i < n; i++ {
		s := time.Now()
		pp, err := ckg.GeneratePreParams(10 * time.Minute)
		if err != nil {
			panic(fmt.Sprintf("preparams %d: %v", i, err))
		}
		preSum += time.Since(s)
		preParams[i] = pp
	}
	preAvgMs := float64(preSum.Milliseconds()) / float64(n)

	// ── 2) keygen: giao thức DKG đầy đủ (kèm ZK proof) ──
	keygenStart := time.Now()
	keys := make([]*ckg.LocalPartySaveData, n)
	{
		parties := make([]*ckg.LocalParty, 0, n)
		errCh := make(chan *tss.Error, n)
		outCh := make(chan tss.Message, n)
		endCh := make(chan *ckg.LocalPartySaveData, n)
		updater := test.SharedPartyUpdater

		for i := 0; i < n; i++ {
			params := tss.NewParameters(tss.S256(), p2pCtx, pIDs[i], n, threshold)
			if nozk {
				// chỉ để phân rã chi phí — KHÔNG dùng trong môi trường không tin cậy
				params.SetNoProofMod()
				params.SetNoProofFac()
			}
			P := ckg.NewLocalParty(params, outCh, endCh, *preParams[i]).(*ckg.LocalParty)
			parties = append(parties, P)
			go func(P *ckg.LocalParty) {
				if err := P.Start(); err != nil {
					errCh <- err
				}
			}(P)
		}

		var ended int32
	keygenLoop:
		for {
			select {
			case err := <-errCh:
				panic(fmt.Sprintf("keygen error: %v", err))
			case msg := <-outCh:
				dest := msg.GetTo()
				if dest == nil {
					for _, P := range parties {
						if P.PartyID().Index == msg.GetFrom().Index {
							continue
						}
						go updater(P, msg, errCh)
					}
				} else {
					go updater(parties[dest[0].Index], msg, errCh)
				}
			case save := <-endCh:
				idx, _ := save.OriginalIndex()
				keys[idx] = save
				if atomic.AddInt32(&ended, 1) == int32(n) {
					break keygenLoop
				}
			}
		}
	}
	keygenMs := float64(time.Since(keygenStart).Milliseconds())

	// ── 3) signing: ký ngưỡng với đúng t bên đầu tiên ──
	signStart := time.Now()
	{
		signPIDsUnsorted := make(tss.UnSortedPartyIDs, t)
		copy(signPIDsUnsorted, pIDs[:t])
		signPIDs := tss.SortPartyIDs(signPIDsUnsorted)
		signCtx := tss.NewPeerContext(signPIDs)

		parties := make([]*csigning.LocalParty, 0, t)
		errCh := make(chan *tss.Error, t)
		outCh := make(chan tss.Message, t)
		endCh := make(chan *common.SignatureData, t)
		updater := test.SharedPartyUpdater

		for i := 0; i < t; i++ {
			params := tss.NewParameters(tss.S256(), signCtx, signPIDs[i], t, threshold)
			subset := ckg.BuildLocalSaveDataSubset(*keys[i], signPIDs)
			P := csigning.NewLocalParty(big.NewInt(42), params, subset, outCh, endCh).(*csigning.LocalParty)
			parties = append(parties, P)
			go func(P *csigning.LocalParty) {
				if err := P.Start(); err != nil {
					errCh <- err
				}
			}(P)
		}

		var ended int32
		var sigData *common.SignatureData
	signLoop:
		for {
			select {
			case err := <-errCh:
				panic(fmt.Sprintf("signing error: %v", err))
			case msg := <-outCh:
				dest := msg.GetTo()
				if dest == nil {
					for _, P := range parties {
						if P.PartyID().Index == msg.GetFrom().Index {
							continue
						}
						go updater(P, msg, errCh)
					}
				} else {
					go updater(parties[dest[0].Index], msg, errCh)
				}
			case sd := <-endCh:
				sigData = sd
				if atomic.AddInt32(&ended, 1) == int32(t) {
					break signLoop
				}
			}
		}

		// xác minh chữ ký gộp đúng (sanity)
		pk := ecdsa.PublicKey{Curve: tss.S256(), X: keys[0].ECDSAPub.X(), Y: keys[0].ECDSAPub.Y()}
		ok := ecdsa.Verify(&pk, big.NewInt(42).Bytes(),
			new(big.Int).SetBytes(sigData.R), new(big.Int).SetBytes(sigData.S))
		if !ok {
			panic("aggregate ECDSA signature failed to verify")
		}
	}
	signingMs := float64(time.Since(signStart).Milliseconds())

	res := map[string]interface{}{
		"t": t, "n": n, "nozk": nozk,
		"preparams_avg_ms_per_party": preAvgMs,
		"keygen_wall_ms":             keygenMs,
		"signing_wall_ms":            signingMs,
		"cpu_cores":                  runtime.NumCPU(),
	}
	if jsonOut {
		b, _ := json.Marshal(res)
		fmt.Println(string(b))
	} else {
		fmt.Printf("GG20 %d-of-%d | preParams ~%.0f ms/party | keygen %.0f ms | signing %.0f ms\n",
			t, n, preAvgMs, keygenMs, signingMs)
	}
}
