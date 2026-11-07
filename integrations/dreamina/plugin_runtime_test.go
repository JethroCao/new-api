package dreamina_test

import (
	"encoding/base64"
	"maps"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/billingexpr"
	runtime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/relay/channel"
	adaptor "github.com/QuantumNous/new-api/relay/channel/task/jsplugin"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/billing_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCreditPluginStockHostLifecycle(t *testing.T) {
	dir := t.TempDir()
	config := filepath.Join(dir, "reservations.json")
	artifact := filepath.Join(dir, "plugin.js")
	require.NoError(t, os.WriteFile(config, []byte(`{"models":["seedance_2.5"]}`), 0600))
	output, err := exec.Command("node", "build-credit-plugin.mjs", config, artifact).CombinedOutput()
	require.NoError(t, err, string(output))
	source, err := os.ReadFile(artifact)
	require.NoError(t, err)
	plugin, err := runtime.CompilePlugin(string(source), runtime.Options{})
	require.NoError(t, err)
	assert.Equal(t, "dreamina-cli", plugin.Meta.Key)
	t.Run("protocol decoding rejects new promotions before billing", func(t *testing.T) {
		for _, body := range []map[string]any{
			{"kind": "json", "value": map[string]any{"mode": "promote", "draft_task_id": "task_draft"}},
			{"kind": "multipart", "fields": map[string]any{"mode": []string{"promote"}, "draft_task_id": []string{"task_draft"}}, "files": []any{}},
		} {
			intent, err := plugin.Engine.CallPath(t.Context(), "protocols", []string{"openai_video", "decodeRequest"}, map[string]any{"operation": "create", "model": "seedance_2.5", "body": body})
			require.ErrorContains(t, err, "暂不支持样片转正，请直接创建普通视频任务")
			assert.Nil(t, intent)
		}
	})
	ctx := map[string]any{"publicTaskId": "task_gateway", "model": "seedance_2.5", "upstreamModel": "seedance_2.5", "requestBody": map[string]any{"model": "seedance_2.5", "prompt": "waves", "seconds": 5, "n": 2, "resolution": "480p"}}
	estimated, err := plugin.Engine.Call(t.Context(), "extractUsage", ctx)
	require.NoError(t, err)
	estimatedJSON, err := common.Marshal(estimated)
	require.NoError(t, err)
	assert.JSONEq(t, `{"credits":120,"resolution":"480p"}`, string(estimatedJSON))
	ack := map[string]any{"id": "bridge-job", "object": "video", "billing_mode": "credits", "status": "queued", "model": "seedance_2.5", "seconds": 5, "n": 2, "mode": "t2v", "ratio": "16:9", "resolution": "480p", "video_count": 0, "billing": map[string]any{"version": 2, "request_id": "task_gateway", "reserved_credits": 120}}
	submitted, err := plugin.Engine.Call(t.Context(), "parseSubmitResponse", ctx, map[string]any{"body": ack})
	require.NoError(t, err)
	state, err := common.Marshal(submitted.(map[string]any)["state"])
	require.NoError(t, err)
	task := &model.Task{TaskID: "task_gateway", Properties: model.Properties{OriginModelName: "seedance_2.5", UpstreamModelName: "seedance_2.5"}, PrivateData: model.TaskPrivateData{UpstreamTaskID: "bridge-job", PluginState: state}}
	// Exercise the official SQL value/scanner and task adaptor, not just Node.
	persisted, err := task.PrivateData.Value()
	require.NoError(t, err)
	restored := *task
	restored.PrivateData = model.TaskPrivateData{}
	require.NoError(t, restored.PrivateData.Scan(persisted))
	require.NotEmpty(t, restored.PrivateData.PluginState)
	host := adaptor.New(plugin)
	host.Init(&relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{ChannelBaseUrl: "https://bridge.example", ApiKey: "test-only"}, TaskRelayInfo: &relaycommon.TaskRelayInfo{}})
	t.Run("historical promotions retain query settlement and download through the stock host", func(t *testing.T) {
		for _, unit := range []string{"seconds", "credits"} {
			t.Run(unit, func(t *testing.T) {
				// These are persisted old tasks; do not recreate them through the now-disabled admission path.
				stored := *task
				stored.PrivateData.PluginState = nil
				previous := map[string]any{"id": "bridge-job", "object": "video", "status": "queued", "model": "seedance_2.5", "seconds": 5, "n": 1, "mode": "promote", "ratio": "16:9", "resolution": "1080p"}
				receipt := map[string]any{"version": 1, "request_id": "task_gateway", "reserved_credits": 200}
				if unit == "credits" {
					frozen := maps.Clone(receipt)
					for _, key := range []string{"model", "seconds", "n", "mode", "ratio", "resolution"} {
						frozen[key] = previous[key]
					}
					frozen["job_id"] = "bridge-job"
					stored.PrivateData.PluginState, err = common.Marshal(map[string]any{"billing": frozen})
					require.NoError(t, err)
				}
				stored.Data, err = common.Marshal(previous)
				require.NoError(t, err)
				for _, stage := range []struct{ upstream, expected string }{{"in_progress", "IN_PROGRESS"}, {"failed", "FAILURE"}, {"completed", "SUCCESS"}} {
					body := maps.Clone(previous)
					body["status"], body["video_count"] = stage.upstream, 0
					body["billing_mode"] = "legacy_seconds"
					body["error"] = map[string]any{"message": "20115:本次生成的输出视频未通过版权审核"}
					if unit == "credits" {
						body["billing_mode"], body["billing"] = "credits", maps.Clone(receipt)
					}
					if stage.upstream == "completed" {
						body["video_count"], body["terminal_proof"], body["delivery_verified"] = 1, true, true
						if unit == "credits" {
							body["billing"].(map[string]any)["credits"] = 80
							body["billing"].(map[string]any)["basis"] = "accepted_quote"
						}
					}
					payload, err := common.Marshal(body)
					require.NoError(t, err)
					result, err := host.ParseTaskResult(&stored, &http.Response{StatusCode: 200, Header: make(http.Header)}, payload)
					require.NoError(t, err)
					require.Equal(t, stage.expected, result.Status)
					if stage.upstream != "completed" {
						assert.Empty(t, result.UsageFacts)
						continue
					}
					expr, initial, finalQuota := `u("seconds") * 0.8`, 5.0, 2000000
					if unit == "credits" {
						expr, initial, finalQuota = `u("credits") * 0.025`, 200, 1000000
						assert.EqualValues(t, 80, result.UsageFacts["credits"])
					} else {
						assert.EqualValues(t, 5, result.UsageFacts["seconds"])
					}
					snapshot := &billingexpr.BillingSnapshot{ExprString: expr, ExprHash: billingexpr.ExprHashString(expr), GroupRatio: 1, QuotaPerUnit: 500000, ExprVersion: 1, TaskUsageBilling: true, UsageFacts: map[string]any{unit: initial, "mode": "promote", "resolution": "1080p"}}
					settled, facts, err := service.EvaluateTaskCompletionUsage(snapshot, result.UsageFacts)
					require.NoError(t, err)
					assert.Equal(t, finalQuota, settled.ActualQuotaAfterGroup)
					assert.Equal(t, "promote", facts["mode"])
					stored.Status, stored.Data = model.TaskStatusSuccess, payload
					artifacts, err := host.ListArtifacts(&stored)
					require.NoError(t, err)
					require.Len(t, artifacts, 1)
					download, err := host.BuildContentRequest(t.Context(), &stored, artifacts[0].Key, channel.TaskArtifactClientRequest{Method: http.MethodGet})
					require.NoError(t, err)
					assert.Equal(t, "https://bridge.example/v1/jobs/bridge-job/content/0", download.URL)
				}
			})
		}
	})
	for _, tc := range []struct {
		name        string
		credits     int
		count       int
		status      string
		want        string
		wantCredits float64
		wantQuota   int
	}{
		{"quoted batch", 73, 2, "completed", "SUCCESS", 73, 1426542},
		{"zero quote", 0, 2, "completed", "SUCCESS", 0, 0},
		{"exceeds estimate", 180, 2, "completed", "SUCCESS", 180, 3517500},
		{"partial delivery", 73, 1, "completed", "SUCCESS", 36.5, 713271},
		{"partial delivery exceeds estimate", 300, 1, "completed", "SUCCESS", 150, 2931250},
		{"empty delivery", 73, 0, "completed", "UNKNOWN", 0, 0},
		{"upstream failure", 73, 0, "failed", "FAILURE", 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ack["status"] = tc.status
			ack["video_count"] = tc.count
			ack["terminal_proof"], ack["delivery_verified"] = true, true
			ack["billing"] = map[string]any{"version": 2, "request_id": "task_gateway", "reserved_credits": 120, "credits": tc.credits, "basis": "accepted_quote"}
			raw, err := common.Marshal(ack)
			require.NoError(t, err)
			result, err := host.ParseTaskResult(&restored, &http.Response{StatusCode: 200, Header: make(http.Header)}, raw)
			require.NoError(t, err)
			assert.Equal(t, tc.want, result.Status)
			if tc.want != "SUCCESS" {
				assert.Empty(t, result.UsageFacts)
				return
			}
			assert.EqualValues(t, tc.wantCredits, result.UsageFacts["credits"])
			expression := standardCreditExpressions(t)["dreamina-cli::seedance_2.5"]
			snapshot := &billingexpr.BillingSnapshot{ExprString: expression, ExprHash: billingexpr.ExprHashString(expression), GroupRatio: 1, QuotaPerUnit: 500000, ExprVersion: 1, TaskUsageBilling: true, UsageFacts: map[string]any{"credits": 120.0, "resolution": "480p"}}
			reserve, err := billingexpr.ComputeTieredQuotaWithRequest(snapshot, billingexpr.TokenParams{}, billingexpr.RequestInput{Usage: map[string]any{"credits": 120.0, "resolution": "480p"}})
			require.NoError(t, err)
			settled, facts, err := service.EvaluateTaskCompletionUsage(snapshot, result.UsageFacts)
			require.NoError(t, err)
			assert.Equal(t, 2345000, reserve.ActualQuotaAfterGroup)
			assert.Equal(t, tc.wantQuota, settled.ActualQuotaAfterGroup)
			assert.EqualValues(t, tc.wantCredits, facts["credits"])
			assert.Equal(t, tc.wantQuota-2345000, settled.ActualQuotaAfterGroup-reserve.ActualQuotaAfterGroup)
		})
	}
	t.Run("private header receipt reaches stock completion hook in the same poll", func(t *testing.T) {
		acknowledgement := map[string]any{"id": "bridge-job", "object": "video", "billing_mode": "credits", "status": "queued", "model": "seedance_2.5", "seconds": 5, "n": 2, "mode": "t2v", "ratio": "16:9", "resolution": "480p", "video_count": 0}
		receipt := map[string]any{"version": 2, "request_id": "task_gateway", "reserved_credits": 120}
		receiptBytes, err := common.Marshal(map[string]any{"id": "bridge-job", "billing": receipt})
		require.NoError(t, err)
		header := make(http.Header)
		header.Set("X-Dreamina-Billing-Receipt", base64.StdEncoding.EncodeToString(receiptBytes))
		response, err := plugin.Engine.Call(t.Context(), "parseSubmitResponse", ctx, map[string]any{"body": acknowledgement, "headers": header})
		require.NoError(t, err)
		parsed := response.(map[string]any)
		assert.NotContains(t, parsed["taskData"], "billing")
		stored := *task
		stored.PrivateData.PluginState, err = common.Marshal(parsed["state"])
		require.NoError(t, err)
		stored.Data, err = common.Marshal(parsed["taskData"])
		require.NoError(t, err)
		for _, tc := range []struct {
			name    string
			credits int
			count   int
			want    float64
		}{
			{"partial", 73, 1, 36.5},
			{"zero", 0, 2, 0},
			{"supplement", 300, 1, 150},
			{"failed", 73, 0, 0},
		} {
			t.Run(tc.name, func(t *testing.T) {
				body := map[string]any{}
				maps.Copy(body, acknowledgement)
				body["status"], body["video_count"] = "completed", tc.count
				if tc.name == "failed" {
					body["status"] = "failed"
				}
				body["terminal_proof"], body["delivery_verified"] = true, true
				currentReceipt := map[string]any{}
				maps.Copy(currentReceipt, receipt)
				currentReceipt["credits"], currentReceipt["basis"] = tc.credits, "accepted_quote"
				currentHeader, err := common.Marshal(map[string]any{"id": "bridge-job", "billing": currentReceipt})
				require.NoError(t, err)
				header.Set("X-Dreamina-Billing-Receipt", base64.StdEncoding.EncodeToString(currentHeader))
				payload, err := common.Marshal(body)
				require.NoError(t, err)
				result, err := host.ParseTaskResult(&stored, &http.Response{StatusCode: 200, Header: header}, payload)
				require.NoError(t, err)
				if tc.name == "failed" {
					assert.Equal(t, "FAILURE", result.Status)
					assert.Empty(t, result.UsageFacts)
				} else {
					require.Equal(t, "SUCCESS", result.Status)
					assert.EqualValues(t, tc.want, result.UsageFacts["credits"])
					assert.Equal(t, "480p", result.UsageFacts["resolution"])
				}
				wrongID, err := common.Marshal(map[string]any{"id": "other-job", "billing": currentReceipt})
				require.NoError(t, err)
				header.Set("X-Dreamina-Billing-Receipt", base64.StdEncoding.EncodeToString(wrongID))
				mismatched, err := host.ParseTaskResult(&stored, &http.Response{StatusCode: 200, Header: header}, payload)
				require.NoError(t, err)
				assert.Equal(t, "UNKNOWN", mismatched.Status)
				assert.Empty(t, mismatched.UsageFacts)
				header.Del("X-Dreamina-Billing-Receipt")
				missing, err := host.ParseTaskResult(&stored, &http.Response{StatusCode: 200, Header: header}, payload)
				require.NoError(t, err)
				assert.Equal(t, "UNKNOWN", missing.Status)
				assert.Empty(t, missing.UsageFacts)
			})
		}
	})

	t.Run("old task keeps its original price and bills delivered seconds", func(t *testing.T) {
		secondsTask := *task
		secondsTask.PrivateData.PluginState = nil // previous plugin had no state
		secondsTask.Data = []byte(`{"id":"bridge-job","object":"video","status":"queued","model":"seedance_2.5","seconds":5,"n":2,"mode":"t2v","ratio":"16:9","resolution":"480p"}`)
		completed := []byte(`{"id":"bridge-job","object":"video","status":"completed","model":"seedance_2.5","seconds":5,"n":2,"mode":"t2v","ratio":"16:9","resolution":"480p","billing_mode":"legacy_seconds","video_count":1}`)
		result, err := host.ParseTaskResult(&secondsTask, &http.Response{StatusCode: 200, Header: make(http.Header)}, completed)
		require.NoError(t, err)
		require.Equal(t, "SUCCESS", result.Status)
		assert.EqualValues(t, 5, result.UsageFacts["seconds"])
		assert.NotContains(t, result.UsageFacts, "credits")
		expr := `u("resolution") == "480p" ? tier("480p", u("seconds") * 0.8) : tier("other", u("seconds") * 2)`
		snapshot := &billingexpr.BillingSnapshot{ExprString: expr, ExprHash: billingexpr.ExprHashString(expr), GroupRatio: 0.5, QuotaPerUnit: 500000, ExprVersion: 1, TaskUsageBilling: true, UsageFacts: map[string]any{"seconds": 10.0, "resolution": "480p"}}
		settled, facts, err := service.EvaluateTaskCompletionUsage(snapshot, result.UsageFacts)
		require.NoError(t, err)
		assert.Equal(t, 1000000, settled.ActualQuotaAfterGroup)
		assert.Equal(t, "480p", facts["resolution"])

		secondsTask.Data = nil
		unidentified, err := host.ParseTaskResult(&secondsTask, &http.Response{StatusCode: 200, Header: make(http.Header)}, completed)
		require.NoError(t, err)
		assert.Equal(t, "UNKNOWN", unidentified.Status)
		assert.Empty(t, unidentified.UsageFacts)
	})

	t.Run("first authenticated quote and fractional settlement survive polling", func(t *testing.T) {
		copyTask := *task
		header := make(http.Header)
		setQuote := func(credits int, unitCost string) {
			q, err := common.Marshal(map[string]any{"source": "dreamina_canvas_cli", "credits": credits, "quote_stage": "before_generation", "quoted_at_ms": 12345, "model": "seedance_2.5", "mode": "t2v", "seconds": 5, "ratio": "16:9", "resolution": "480p", "count": 2, "submit_id": "upstream-operation", "cost_cny_per_credit": unitCost})
			require.NoError(t, err)
			header.Set("X-Upstream-Credit-Quote", base64.StdEncoding.EncodeToString(q))
		}
		status := func(stage string, count int, credits int) *relaycommon.TaskInfo {
			resultData := map[string]any{"id": "bridge-job", "object": "video", "status": stage, "terminal_proof": true, "delivery_verified": true, "model": "seedance_2.5", "seconds": 5, "n": 2, "mode": "t2v", "ratio": "16:9", "resolution": "480p", "video_count": count, "billing_mode": "credits", "billing": map[string]any{"version": 2, "request_id": "task_gateway", "reserved_credits": 120, "credits": credits, "basis": "accepted_quote"}}
			raw, err := common.Marshal(resultData)
			require.NoError(t, err)
			result, err := host.ParseTaskResult(&copyTask, &http.Response{StatusCode: 200, Header: header}, raw)
			require.NoError(t, err)
			if result.Status != string(model.TaskStatusUnknown) {
				copyTask.Data = raw
			}
			if result.PluginState != nil {
				copyTask.PrivateData.PluginState = result.PluginState
			}
			return result
		}
		setQuote(80, "0.025")
		conflict := status("completed", 1, 73) // header first appears in this poll
		assert.Equal(t, "UNKNOWN", conflict.Status)
		assert.Empty(t, conflict.UsageFacts)

		copyTask = *task
		setQuote(73, "0.025")
		require.Equal(t, "IN_PROGRESS", status("in_progress", 0, 73).Status)
		var saved map[string]any
		require.NoError(t, common.Unmarshal(copyTask.PrivateData.PluginState, &saved))
		require.Contains(t, saved, "creditQuote")
		setQuote(73, "0.05") // later pricing metadata does not replace the first snapshot
		result := status("completed", 1, 73)
		require.Equal(t, "SUCCESS", result.Status)
		assert.EqualValues(t, 36.5, result.UsageFacts["credits"])
		require.NoError(t, common.Unmarshal(result.PluginState, &saved))
		assert.Equal(t, "0.025", saved["creditQuote"].(map[string]any)["cost_cny_per_credit"])
		assert.EqualValues(t, 36.5, saved["settledCredits"])
		assert.EqualValues(t, 1, saved["deliveredCount"])

		// A later header cannot replace an amount already accepted from the
		// authenticated receipt in an earlier poll without audit metadata.
		copyTask = *task
		header.Del("X-Upstream-Credit-Quote")
		require.Equal(t, "IN_PROGRESS", status("in_progress", 0, 73).Status)
		setQuote(80, "0.05")
		conflict = status("in_progress", 0, 80)
		assert.Equal(t, "UNKNOWN", conflict.Status)
		assert.Empty(t, conflict.UsageFacts)
		result = status("completed", 1, 80)
		assert.Equal(t, "UNKNOWN", result.Status)
		assert.Empty(t, result.UsageFacts)

		// A contradictory authenticated quote must not authorize a refund.
		result = status("failed", 0, 73)
		assert.Equal(t, "UNKNOWN", result.Status)
		assert.Empty(t, result.UsageFacts)
		setQuote(73, "0.025")
		result = status("failed", 0, 73)
		assert.Equal(t, "FAILURE", result.Status)
		assert.Empty(t, result.UsageFacts)
	})

}

func standardCreditExpressions(t *testing.T) map[string]string {
	t.Helper()
	data, err := os.ReadFile("standard-credit-pricing.json")
	require.NoError(t, err)
	var artifact struct {
		Expressions map[string]string `json:"billing_setting.plugin_billing_expr"`
	}
	require.NoError(t, common.Unmarshal(data, &artifact))
	require.Len(t, artifact.Expressions, 9)
	return artifact.Expressions
}

func TestStandardCreditPricingAllTiers(t *testing.T) {
	artifact := filepath.Join(t.TempDir(), "plugin.js")
	output, err := exec.Command("node", "build-credit-plugin.mjs", "reservations.example.json", artifact).CombinedOutput()
	require.NoError(t, err, string(output))
	source, err := os.ReadFile(artifact)
	require.NoError(t, err)
	plugin, err := runtime.CompilePlugin(string(source), runtime.Options{})
	require.NoError(t, err)
	expressions := standardCreditExpressions(t)
	for name, expression := range expressions {
		schema, _ := plugin.Meta.UsageForModel(strings.TrimPrefix(name, "dreamina-cli::"))
		require.NoError(t, billing_setting.SmokeTestTaskExpr(expression, schema), name)
	}
	for _, tc := range []struct {
		model      string
		resolution string
		credits    float64
		quota      int
	}{
		{"seedance_2.5", "480p", 120, 2345000},
		{"seedance_2.5", "720p", 200, 5285000},
		{"seedance_2.5", "1080p", 640, 13090000},
		{"seedance_2.5_draft", "480p", 90, 2345000},
		{"seedance_2.0_vip", "720p", 140, 3465000},
		{"seedance_2.0_vip", "1080p", 330, 8680000},
		{"seedance_2.0_vip", "4k", 800, 17675000},
		{"seedance_2.0_fast_vip", "720p", 60, 2800000},
		{"seedance_2.0_mini", "720p", 60, 1750000},
		{"seedance_pro_fast", "720p", 20, 302702},
		{"seedance_pro_fast", "1080p", 40, 719712},
		{"happyhorse_1.1", "720p", 140, 3150000},
		{"happyhorse_1.1", "1080p", 180, 4200000},
		{"wan_3.0", "720p", 140, 2100000},
		{"wan_3.0", "1080p", 330, 4200000},
		{"dreamina-video", "480p", 120, 2345000},
	} {
		t.Run(tc.model+"/"+tc.resolution, func(t *testing.T) {
			ctx := map[string]any{"model": tc.model, "upstreamModel": tc.model, "requestBody": map[string]any{"prompt": "waves", "seconds": 5, "n": 2, "resolution": strings.ToUpper(tc.resolution)}}
			usage, err := plugin.Engine.Call(t.Context(), "extractUsage", ctx)
			require.NoError(t, err)
			facts, ok := usage.(map[string]any)
			require.True(t, ok)
			assert.EqualValues(t, tc.credits, facts["credits"])
			assert.Equal(t, tc.resolution, facts["resolution"])
			expression := expressions["dreamina-cli::"+tc.model]
			snapshot := &billingexpr.BillingSnapshot{ExprString: expression, ExprHash: billingexpr.ExprHashString(expression), ExprVersion: 1, TaskUsageBilling: true, GroupRatio: 1, QuotaPerUnit: 500000, UsageFacts: facts}
			reserved, err := billingexpr.ComputeTieredQuotaWithRequest(snapshot, billingexpr.TokenParams{}, billingexpr.RequestInput{Usage: facts})
			require.NoError(t, err)
			assert.Equal(t, tc.quota, reserved.ActualQuotaAfterGroup)
			// Missing completion dimensions retain the original frozen tier.
			settled, final, err := service.EvaluateTaskCompletionUsage(snapshot, map[string]any{"credits": tc.credits / 2})
			require.NoError(t, err)
			assert.Equal(t, common.QuotaRound(float64(tc.quota)/2), settled.ActualQuotaAfterGroup)
			assert.Equal(t, tc.resolution, final["resolution"])
			assert.Equal(t, expression, snapshot.ExprString)
			assert.Equal(t, 1, snapshot.ExprVersion)
		})
	}

	t.Run("same credit amount retains its distinct frozen resolution price", func(t *testing.T) {
		expression := expressions["dreamina-cli::seedance_2.5"]
		for resolution, want := range map[string]int{"480p": 2345000, "720p": 3171000} {
			facts := map[string]any{"credits": 120.0, "resolution": resolution}
			snapshot := &billingexpr.BillingSnapshot{ExprString: expression, ExprHash: billingexpr.ExprHashString(expression), ExprVersion: 1, TaskUsageBilling: true, GroupRatio: 1, QuotaPerUnit: 500000, UsageFacts: facts}
			// A later price draft cannot alter a task's submitted expression.
			expressions["dreamina-cli::seedance_2.5"] = `v1:tier("changed", u("credits") * 999)`
			settled, _, err := service.EvaluateTaskCompletionUsage(snapshot, map[string]any{"credits": 120.0})
			require.NoError(t, err)
			assert.Equal(t, want, settled.ActualQuotaAfterGroup)
		}
	})

	t.Run("normalized defaults and reference credits use the same sale price", func(t *testing.T) {
		for _, tc := range []struct {
			request map[string]any
			credits float64
			tier    string
			quota   int
		}{
			{map[string]any{"prompt": "waves"}, 60, "480p", 1172500},
			{map[string]any{"prompt": "waves", "size": "720x1280"}, 100, "720p", 2642500},
			{map[string]any{"prompt": "waves", "references": []any{map[string]any{"type": "video", "url": "https://example.com/ref.mp4"}}}, 315, "480p", 6155625},
		} {
			ctx := map[string]any{"model": "seedance_2.5", "requestBody": tc.request}
			usage, err := plugin.Engine.Call(t.Context(), "extractUsage", ctx)
			require.NoError(t, err)
			facts := usage.(map[string]any)
			assert.EqualValues(t, tc.credits, facts["credits"])
			assert.Equal(t, tc.tier, facts["resolution"])
			expression := standardCreditExpressions(t)["dreamina-cli::seedance_2.5"]
			snapshot := &billingexpr.BillingSnapshot{ExprString: expression, ExprHash: billingexpr.ExprHashString(expression), ExprVersion: 1, TaskUsageBilling: true, GroupRatio: 1, QuotaPerUnit: 500000, UsageFacts: facts}
			reserved, err := billingexpr.ComputeTieredQuotaWithRequest(snapshot, billingexpr.TokenParams{}, billingexpr.RequestInput{Usage: facts})
			require.NoError(t, err)
			assert.Equal(t, tc.quota, reserved.ActualQuotaAfterGroup)
		}
		for _, invalid := range []map[string]any{{"resolution": "8k"}, {"resolution": ""}, {"resolution": nil}, {"resolution": "480p", "size": "1280x720"}, {"seconds": -1}, {"n": 0}} {
			body := map[string]any{"prompt": "waves"}
			maps.Copy(body, invalid)
			_, err := plugin.Engine.Call(t.Context(), "extractUsage", map[string]any{"model": "seedance_2.5", "requestBody": body})
			require.Error(t, err)
		}
	})
}
