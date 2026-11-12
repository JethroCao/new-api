package ustori_test

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/billingexpr"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/relay/channel"
	adaptor "github.com/QuantumNous/new-api/relay/channel/task/jsplugin"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/types"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestUStoriVideoPlugin(t *testing.T) {
	source, err := os.ReadFile("plugin.js")
	require.NoError(t, err)
	registry := jsplugin.NewRegistry()
	plugin, err := registry.Register(string(source), jsplugin.Options{})
	require.NoError(t, err)
	assert.Equal(t, "ustori", plugin.Meta.Key)
	for _, name := range []string{"Seedance-2.0", "Seedance-2.0-Fast", "Seedance-2.0-mini", "Seedance-2.5", "Wan-3.0"} {
		_, found := registry.Generation().LookupEndpoint(http.MethodPost, "/v1/videos", name)
		assert.True(t, found, name)
	}
	_, found := registry.Generation().LookupEndpoint(http.MethodPost, "/v1/videos", "seedance_2.5")
	assert.False(t, found, "the UStori plugin must not claim the existing Dreamina model name")

	for _, tc := range []struct {
		name, upstreamModel, request, expectedInput, validationError string
	}{
		{"image and audio references", "Seedance-2.5", `{"seconds":5,"resolution":"480p","ratio":"9:16","mode":"m2v","references":[{"type":"image","url":"https://media.example/ref.png"},{"type":"audio","url":"https://media.example/ref.wav"}]}`, `{"duration":5,"resolution":"480p","aspect_ratio":"9:16","images":["https://media.example/ref.png"],"audios":["https://media.example/ref.wav"]}`, ""},
		{"reference video in references", "Seedance-2.5", `{"resolution":"480p","references":[{"type":"video","url":"https://media.example/ref.mp4"}]}`, "", "reference video duration"},
		{"reference video in videos", "Wan-3.0", `{"duration":-1,"videos":["https://media.example/ref.mp4"]}`, "", "reference video duration"},
		{"first and last frames", "Seedance-2.0", `{"prompt":"waves","resolution":"4k","mode":"first_last_frame","references":[{"type":"image","url":"https://media.example/first.png"},{"type":"image","url":"https://media.example/last.png"}]}`, `{"prompt":"waves","duration":5,"resolution":"2160p","first_image":"https://media.example/first.png","last_image":"https://media.example/last.png"}`, ""},
		{"fixed resolution", "Seedance-2.0-Fast", `{"prompt":"waves","references":[]}`, `{"prompt":"waves","duration":5,"resolution":"720p"}`, ""},
		{"OpenAI size", "Seedance-2.0-mini", `{"prompt":"waves","size":"720x1280"}`, `{"prompt":"waves","duration":5,"resolution":"720p","aspect_ratio":"9:16"}`, ""},
		{"automatic duration and false flags", "Wan-3.0", `{"prompt":"waves","duration":-1,"generate_audio":false,"watermark":false}`, `{"prompt":"waves","duration":-1,"resolution":"1080p","generate_audio":false,"watermark":false}`, ""},
		{"invalid model duration", "Seedance-2.0", `{"prompt":"waves","seconds":16,"resolution":"720p"}`, "", "duration"},
		{"invalid resolution", "Seedance-2.0-mini", `{"prompt":"waves","resolution":"1080p"}`, "", "resolution"},
		{"conflicting duration aliases", "Seedance-2.5", `{"prompt":"waves","seconds":5,"duration":8,"resolution":"720p"}`, "", "conflicts"},
		{"unsupported batch", "Seedance-2.5", `{"prompt":"waves","resolution":"720p","n":2}`, "", "n must be 1"},
		{"audio only on 2.0", "Seedance-2.0", `{"resolution":"720p","audios":["https://media.example/ref.wav"]}`, "", "image or video"},
		{"tail without first frame", "Seedance-2.5", `{"resolution":"720p","last_image":"https://media.example/last.png"}`, "", "first_image"},
		{"credentials in URL", "Wan-3.0", `{"images":["https://user:secret@media.example/ref.png"]}`, "", "HTTP(S) URL"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var request map[string]any
			require.NoError(t, common.UnmarshalJsonStr(tc.request, &request))
			protocol := jsplugin.ProtocolRequestContext{
				RouteRequestContext: jsplugin.RouteRequestContext{Body: map[string]any{"kind": "json", "value": request}},
				Protocol:            "openai_video", Operation: "create", Model: "test-alias", UpstreamModel: tc.upstreamModel,
			}
			value, err := plugin.Engine.CallPath(t.Context(), "protocols", []string{"openai_video", "decodeRequest"}, protocol.JSValue())
			if tc.validationError != "" {
				require.ErrorContains(t, err, tc.validationError)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, "test-alias", value.(map[string]any)["model"])
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/videos", nil)
			c.Set(jsplugin.ContextKeyPinnedEndpoint, jsplugin.PinnedEndpoint{Plugin: plugin, Protocol: protocol.Protocol, Model: protocol.Model})
			c.Set(jsplugin.ContextKeyProtocolRequest, protocol)
			info := &relaycommon.RelayInfo{
				OriginModelName: protocol.Model,
				ChannelMeta:     &relaycommon.ChannelMeta{ChannelBaseUrl: "https://api.example/", ApiKey: "mock-only", UpstreamModelName: tc.upstreamModel},
				TaskRelayInfo:   &relaycommon.TaskRelayInfo{PublicTaskID: "task_gateway"},
			}
			host := adaptor.New(plugin)
			host.Init(info)
			require.Nil(t, host.ValidateRequestAndSetAction(c, info))
			address, err := host.BuildRequestURL(info)
			require.NoError(t, err)
			assert.Equal(t, "https://api.example/api/v1/tasks", address)
			body, err := host.BuildRequestBody(c, info)
			require.NoError(t, err)
			outgoing, err := http.NewRequest(http.MethodPost, address, body)
			require.NoError(t, err)
			require.NoError(t, host.BuildRequestHeader(c, outgoing, info))
			assert.Equal(t, "Bearer mock-only", outgoing.Header.Get("Authorization"))
			assert.Equal(t, "task_gateway", outgoing.Header.Get("Idempotency-Key"))
			var outbound struct {
				Model string         `json:"model"`
				Input map[string]any `json:"input"`
			}
			wire, err := io.ReadAll(outgoing.Body)
			require.NoError(t, err)
			require.NoError(t, common.Unmarshal(wire, &outbound))
			assert.Equal(t, tc.upstreamModel, outbound.Model)
			input, err := common.Marshal(outbound.Input)
			require.NoError(t, err)
			assert.JSONEq(t, tc.expectedInput, string(input))
			facts, err := host.ExtractUsageFactsValidated(c, info)
			require.NoError(t, err)
			assert.Equal(t, outbound.Input["resolution"], facts["resolution"])
			assert.Equal(t, "none", facts["video_input"])
			expectedCredits := map[string]float64{"Seedance-2.5": 16.5, "Seedance-2.0": 110, "Seedance-2.0-Fast": 8.3, "Seedance-2.0-mini": 8.3, "Wan-3.0": 360}
			assert.EqualValues(t, expectedCredits[tc.upstreamModel], facts["credits"])
			assert.NotContains(t, facts, "seconds")
		})
	}

	t.Run("poll, render, and download using only fixtures", func(t *testing.T) {
		driver := map[string]any{"model": "Wan-3.0", "requestBody": map[string]any{"duration": -1}}
		ack := map[string]any{"statusCode": 202, "body": map[string]any{"id": "upstream-id", "status": "queued"}}
		value, err := plugin.Engine.Call(t.Context(), "parseSubmitResponse", driver, ack)
		require.NoError(t, err)
		parsed := value.(map[string]any)
		assert.Equal(t, "upstream-id", parsed["taskId"])
		// Keep a valid receipt even if the initial status is a newly introduced value.
		ack["body"] = map[string]any{"id": "upstream-id", "status": "accepted"}
		replay, err := plugin.Engine.Call(t.Context(), "parseSubmitResponse", driver, ack)
		require.NoError(t, err)
		assert.Equal(t, "upstream-id", replay.(map[string]any)["taskId"])
		// Historical tasks have only autoDuration, without the new credit marker.
		state, err := common.Marshal(map[string]any{"autoDuration": true})
		require.NoError(t, err)
		value, err = plugin.Engine.Call(t.Context(), "buildQueryRequest", map[string]any{"baseUrl": "https://api.example", "taskId": "upstream-id", "apiKey": "mock-only"})
		require.NoError(t, err)
		query := value.(map[string]any)
		assert.Equal(t, "https://api.example/api/v1/tasks/upstream-id", query["url"])
		assert.Equal(t, "GET", query["method"])
		assert.Equal(t, "Bearer mock-only", query["headers"].(map[string]any)["Authorization"])

		task := &model.Task{TaskID: "task_gateway", PrivateData: model.TaskPrivateData{UpstreamTaskID: "upstream-id", PluginState: state}}
		host := adaptor.New(plugin)
		host.Init(&relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{ChannelBaseUrl: "https://api.example", ApiKey: "mock-only"}})
		for _, tc := range []struct{ body, status, reason string }{
			{`{"id":"upstream-id","status":"queued"}`, "QUEUED", ""},
			{`{"id":"upstream-id","status":"running","error_message":"transient"}`, "IN_PROGRESS", ""},
			{`{"id":"upstream-id","status":"failed","error_message":"素材审核未通过"}`, "FAILURE", "素材审核未通过"},
			{`{"id":"upstream-id","status":"completed","result":{"videos":[]}}`, "UNKNOWN", ""},
			{`{"id":"upstream-id","status":"completed","result":{"videos":["https://cdn.example/first.mp4"]}}`, "UNKNOWN", "UStori did not return a valid automatic output duration"},
			{`{"id":"upstream-id","status":"completed","usage":{"video_seconds":31},"result":{"videos":["https://cdn.example/first.mp4"]}}`, "UNKNOWN", "UStori did not return a valid automatic output duration"},
			{`{"id":"different-id","status":"failed","error_message":"other task"}`, "UNKNOWN", ""},
		} {
			result, err := host.ParseTaskResult(task, &http.Response{StatusCode: http.StatusOK}, []byte(tc.body))
			require.NoError(t, err)
			assert.Equal(t, tc.status, result.Status)
			if tc.reason != "" {
				assert.Equal(t, tc.reason, result.Reason)
			}
			if tc.status == "FAILURE" {
				failedTask := *task
				failedTask.Status, failedTask.FailReason = model.TaskStatusFailure, result.Reason
				wire, err := host.ConvertToOpenAIVideo(&failedTask)
				require.NoError(t, err)
				var rendered struct {
					Error struct{ Code, Message string }
				}
				require.NoError(t, common.Unmarshal(wire, &rendered))
				assert.Equal(t, "video_generation_failed", rendered.Error.Code)
				assert.Equal(t, tc.reason, rendered.Error.Message)
			}
			assert.Empty(t, result.UsageFacts)
		}

		task.Data = []byte(`{"id":"upstream-id","status":"completed","usage":{"video_seconds":8},"result":{"videos":["https://cdn.example/first.mp4","https://cdn.example/second.mp4"]}}`)
		result, err := host.ParseTaskResult(task, &http.Response{StatusCode: http.StatusOK}, task.Data)
		require.NoError(t, err)
		require.Equal(t, "SUCCESS", result.Status)
		assert.EqualValues(t, 8, result.UsageFacts["seconds"])
		fixed := *task
		fixed.PrivateData.PluginState = []byte(`{"autoDuration":false}`)
		fixedResult, err := host.ParseTaskResult(&fixed, &http.Response{StatusCode: http.StatusOK}, []byte(`{"id":"upstream-id","status":"completed","result":{"videos":["https://cdn.example/first.mp4"]}}`))
		require.NoError(t, err)
		assert.Equal(t, "SUCCESS", fixedResult.Status)
		assert.Empty(t, fixedResult.UsageFacts)
		task.Status = model.TaskStatusSuccess
		artifacts, err := host.ListArtifacts(task)
		require.NoError(t, err)
		require.Len(t, artifacts, 2)
		assert.Equal(t, "video", artifacts[0].Key)
		content, err := host.BuildContentRequest(t.Context(), task, artifacts[1].Key, channel.TaskArtifactClientRequest{Method: http.MethodHead})
		require.NoError(t, err)
		assert.Equal(t, "https://cdn.example/second.mp4", content.URL)
		assert.Equal(t, http.MethodHead, content.Method)
		assert.True(t, content.Credentialless)
		assert.Empty(t, content.Headers)
		var data map[string]any
		require.NoError(t, common.Unmarshal(task.Data, &data))
		view := map[string]any{"status": "SUCCESS", "data": data}
		value, err = plugin.Engine.CallPath(t.Context(), "protocols", []string{"openai_video", "render"}, map[string]any{}, view)
		require.NoError(t, err)
		assert.Equal(t, "https://cdn.example/first.mp4", value.(map[string]any)["video_url"])
		assert.NotContains(t, value, "id")
	})
}

// These fixtures model the authenticated task response, not a new paid generation.
func TestUStoriActualCreditSettlement(t *testing.T) {
	// A real isolated SQLite wallet exercises the stock accounting functions.
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	conn, err := db.DB()
	require.NoError(t, err)
	conn.SetMaxOpenConns(1)
	oldDB, oldLogDB := model.DB, model.LOG_DB
	oldMainType, oldLogType := common.MainDatabaseType(), common.LogDatabaseType()
	common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	oldRedis, oldBatch, oldLog := common.RedisEnabled, common.BatchUpdateEnabled, common.LogConsumeEnabled
	model.DB, model.LOG_DB = db, db
	common.RedisEnabled, common.BatchUpdateEnabled, common.LogConsumeEnabled = false, false, true
	oldMemoryCache, oldMaxFailures, oldAdaptorFactory := common.MemoryCacheEnabled, constant.TaskPollMaxFailures, service.GetTaskAdaptorFunc
	common.MemoryCacheEnabled, constant.TaskPollMaxFailures = false, 20
	t.Cleanup(func() {
		model.DB, model.LOG_DB = oldDB, oldLogDB
		common.SetDatabaseTypes(oldMainType, oldLogType)
		common.RedisEnabled, common.BatchUpdateEnabled, common.LogConsumeEnabled = oldRedis, oldBatch, oldLog
		common.MemoryCacheEnabled, constant.TaskPollMaxFailures, service.GetTaskAdaptorFunc = oldMemoryCache, oldMaxFailures, oldAdaptorFactory
		require.NoError(t, conn.Close())
	})
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.Token{}, &model.Task{}, &model.Channel{}, &model.Log{}))
	source, err := os.ReadFile("plugin.js")
	require.NoError(t, err)
	plugin, err := jsplugin.NewRegistry().Register(string(source), jsplugin.Options{})
	require.NoError(t, err)
	host := adaptor.New(plugin)
	host.Init(&relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{ChannelBaseUrl: "https://mock.example", ApiKey: "mock-only"}})
	const expression = `tier("credits", u("credits") * 0.1)`
	for _, tc := range []struct {
		model, resolution string
		duration          int
		credits           float64
	}{
		{"Seedance-2.0", "720p", 5, 19.3}, {"Seedance-2.0", "1080p", 5, 45.5}, {"Seedance-2.0", "2160p", 5, 110},
		{"Seedance-2.0-Fast", "720p", 5, 8.3}, {"Seedance-2.0-mini", "720p", 5, 8.3},
		{"Seedance-2.5", "480p", 5, 16.5}, {"Seedance-2.5", "720p", 5, 24.8}, {"Seedance-2.5", "1080p", 5, 88},
		{"Wan-3.0", "480p", -1, 90}, {"Wan-3.0", "720p", -1, 180}, {"Wan-3.0", "1080p", -1, 360},
	} {
		t.Run(tc.model+tc.resolution, func(t *testing.T) {
			value, err := plugin.Engine.Call(t.Context(), "extractUsage", map[string]any{"usagePurpose": "facts", "model": "alias", "upstreamModel": tc.model, "requestBody": map[string]any{"duration": tc.duration, "resolution": tc.resolution}})
			require.NoError(t, err)
			facts := value.(map[string]any)
			assert.EqualValues(t, tc.credits, facts["credits"])
			// All models, including automatic Wan without video_seconds, use
			// the final charged amount rather than output-duration estimates.
			ack, err := plugin.Engine.Call(t.Context(), "parseSubmitResponse", map[string]any{"model": "alias", "upstreamModel": tc.model, "requestBody": map[string]any{"duration": tc.duration}}, map[string]any{"body": map[string]any{"id": "receipt", "status": "queued"}})
			require.NoError(t, err)
			savedState, err := common.Marshal(ack.(map[string]any)["state"])
			require.NoError(t, err)
			existing := &model.Task{TaskID: "task_receipt", PrivateData: model.TaskPrivateData{UpstreamTaskID: "receipt", PluginState: savedState}}
			raw, err := common.Marshal(map[string]any{"id": "receipt", "model_name": tc.model, "status": "completed", "billing_status": "charged", "billing_rule_version": "discount_cent_v1", "charged_amount": 1650000, "result": map[string]any{"videos": []string{"https://cdn.example/result.mp4"}}})
			require.NoError(t, err)
			final, err := host.ParseTaskResult(existing, &http.Response{StatusCode: 200}, raw)
			require.NoError(t, err)
			require.Equal(t, "SUCCESS", final.Status)
			assert.EqualValues(t, 16.5, final.UsageFacts["credits"])
			assert.NotContains(t, final.UsageFacts, "seconds")
			// An un-migrated seconds expression must fail before sending a paid request.
			_, _, err = billingexpr.RunExprWithRequest(`u("seconds") * 0.33`, billingexpr.TokenParams{}, billingexpr.RequestInput{Usage: facts})
			require.Error(t, err)
		})
	}
	_, err = plugin.Engine.Call(t.Context(), "extractUsage", map[string]any{"usagePurpose": "billing_ratios"})
	require.Error(t, err, "per-call pricing must not silently bypass credit pricing")
	driver := map[string]any{"model": "alias", "upstreamModel": "Seedance-2.5", "requestBody": map[string]any{"duration": 5, "resolution": "480p"}}
	value, err := plugin.Engine.Call(t.Context(), "parseSubmitResponse", driver, map[string]any{"statusCode": 202, "body": map[string]any{"id": "paid-task", "status": "queued"}})
	require.NoError(t, err)
	state, err := common.Marshal(value.(map[string]any)["state"])
	require.NoError(t, err)
	task := &model.Task{TaskID: "task_local", PrivateData: model.TaskPrivateData{UpstreamTaskID: "paid-task", PluginState: state}}
	snap := &billingexpr.BillingSnapshot{ExprString: expression, ExprHash: billingexpr.ExprHashString(expression), GroupRatio: 1, QuotaPerUnit: 500000, TaskUsageBilling: true, UsageFacts: map[string]any{"credits": 16.5}}
	pre, _, err := service.EvaluateTaskCompletionUsage(snap, nil)
	require.NoError(t, err)
	require.Equal(t, 825000, pre.ActualQuotaAfterGroup)
	for _, tc := range []struct {
		name    string
		patch   map[string]any
		status  string
		credits float64
		quota   int
	}{
		{"same charge", nil, "SUCCESS", 16.5, 825000},
		{"discount refund", map[string]any{"charged_amount": 830000}, "SUCCESS", 8.3, 415000},
		{"supplement", map[string]any{"charged_amount": 2000000}, "SUCCESS", 20, 1000000},
		{"zero charge", map[string]any{"charged_amount": 0}, "SUCCESS", 0, 0},
		{"still reserved", map[string]any{"billing_status": "reserved", "charged_amount": 0}, "IN_PROGRESS", 0, 0},
		{"reserved with invalid amount", map[string]any{"billing_status": "reserved", "charged_amount": -1}, "UNKNOWN", 0, 0},
		{"reserved with unsupported version", map[string]any{"billing_status": "reserved", "billing_rule_version": "unknown"}, "UNKNOWN", 0, 0},
		{"missing amount", map[string]any{"charged_amount": nil}, "IN_PROGRESS", 0, 0},
		{"missing units version", map[string]any{"billing_rule_version": nil}, "IN_PROGRESS", 0, 0},
		{"negative amount", map[string]any{"charged_amount": -1}, "UNKNOWN", 0, 0},
		{"fractional microyuan", map[string]any{"charged_amount": 1.5}, "UNKNOWN", 0, 0},
		{"string amount", map[string]any{"charged_amount": "1650000"}, "UNKNOWN", 0, 0},
		{"unsafe amount", map[string]any{"charged_amount": 1e20}, "UNKNOWN", 0, 0},
		{"missing billing state", map[string]any{"billing_status": nil}, "UNKNOWN", 0, 0},
		{"wrong units version", map[string]any{"billing_rule_version": "unknown"}, "UNKNOWN", 0, 0},
		{"wrong version and missing amount", map[string]any{"billing_rule_version": "unknown", "charged_amount": nil}, "UNKNOWN", 0, 0},
		{"invalid amount and missing version", map[string]any{"charged_amount": -1, "billing_rule_version": nil}, "UNKNOWN", 0, 0},
		{"other receipt", map[string]any{"id": "other-task"}, "UNKNOWN", 0, 0},
		{"other model", map[string]any{"model_name": "Wan-3.0"}, "UNKNOWN", 0, 0},
		{"completed but refunded", map[string]any{"billing_status": "refunded"}, "UNKNOWN", 0, 0},
		{"failed refunds without usage", map[string]any{"status": "failed", "billing_status": "refunded", "charged_amount": nil, "error_message": "generation failed"}, "FAILURE", 0, 0},
		{"no video", map[string]any{"result": map[string]any{"videos": []string{}}}, "UNKNOWN", 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := map[string]any{"id": "paid-task", "model_name": "Seedance-2.5", "status": "completed", "billing_status": "charged", "billing_rule_version": "discount_cent_v1", "charged_amount": 1650000, "reserved_amount": 9999999, "standard_amount": 8888888, "usage": map[string]any{"video_seconds": 30}, "result": map[string]any{"videos": []string{"https://cdn.example/video.mp4"}}}
			for k, v := range tc.patch {
				if v == nil {
					delete(body, k)
				} else {
					body[k] = v
				}
			}
			raw, err := common.Marshal(body)
			require.NoError(t, err)
			result, err := host.ParseTaskResult(task, &http.Response{StatusCode: 200}, raw)
			require.NoError(t, err)
			require.Equal(t, tc.status, result.Status)
			if tc.status != "SUCCESS" {
				assert.Empty(t, result.UsageFacts)
			}
			if tc.status == "UNKNOWN" {
				assert.Contains(t, result.Reason, "ustori_")
				assert.Contains(t, result.Reason, "管理员")
			}
			if tc.status != "SUCCESS" && tc.status != "FAILURE" {
				return
			}
			// Reserve using the actual host billing session, then settle through
			// the same asynchronous adjustment/refund functions as polling.
			const initial = 5000000
			user := model.User{Username: tc.name, AffCode: tc.name, Quota: initial, Status: common.UserStatusEnabled}
			require.NoError(t, db.Create(&user).Error)
			token := model.Token{UserId: user.Id, Key: fmt.Sprintf("local-ustori-%d", user.Id), Name: "local", RemainQuota: initial, Status: common.TokenStatusEnabled}
			require.NoError(t, db.Create(&token).Error)
			ch := model.Channel{Name: "mock-ustori", Key: "mock-only", Status: common.ChannelStatusEnabled}
			require.NoError(t, db.Create(&ch).Error)
			info := &relaycommon.RelayInfo{UserId: user.Id, TokenId: token.Id, TokenKey: token.Key, ChannelMeta: &relaycommon.ChannelMeta{ChannelId: ch.Id}, OriginModelName: "Seedance-2.5", TaskRelayInfo: &relaycommon.TaskRelayInfo{Action: "generate"}, ForcePreConsume: true, UserSetting: dto.UserSetting{BillingPreference: "wallet_only"}, TieredBillingSnapshot: snap, PriceData: types.PriceData{Quota: 825000, GroupRatioInfo: types.GroupRatioInfo{GroupRatio: 1}}}
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest("POST", "/v1/videos", nil)
			require.Nil(t, service.PreConsumeBilling(c, 825000, info))
			require.NoError(t, db.First(&user, user.Id).Error)
			assert.Equal(t, initial-825000, user.Quota)
			require.NoError(t, info.Billing.Settle(825000))
			chargedTask := *task
			chargedTask.TaskID = fmt.Sprintf("task_local_%d", user.Id)
			chargedTask.UserId, chargedTask.ChannelId = user.Id, ch.Id
			chargedTask.Quota = 825000
			chargedTask.PrivateData.TokenId = token.Id
			chargedTask.PrivateData.BillingSource = service.BillingSourceWallet
			chargedTask.Status = model.TaskStatusSubmitted
			// Use a separate persisted snapshot, as real submission does.
			snapshotJSON, err := common.Marshal(snap)
			require.NoError(t, err)
			frozen := new(billingexpr.BillingSnapshot)
			require.NoError(t, common.Unmarshal(snapshotJSON, frozen))
			chargedTask.PrivateData.BillingContext = &model.TaskBillingContext{TieredSnapshot: frozen}
			chargedTask.PrivateData.PollFailures = 19
			require.NoError(t, db.Create(&chargedTask).Error)
			service.LogTaskConsumption(c, info, &chargedTask)
			poller := &ustoriPollingFixture{TaskAdaptor: host}
			service.GetTaskAdaptorFunc = func(constant.TaskPlatform) service.TaskPollingAdaptor { return poller }
			for _, pendingFields := range []string{
				`"billing_status":"charged","billing_rule_version":"discount_cent_v1"`,
				`"billing_status":"reserved"`,
				`"billing_status":"charged","charged_amount":830000`,
			} {
				poller.body = []byte(`{"id":"paid-task","model_name":"Seedance-2.5","status":"completed","result":{"videos":["https://cdn.example/video.mp4"]},` + pendingFields + `}`)
				require.NoError(t, service.UpdateVideoTasks(t.Context(), "ustori", map[int][]string{ch.Id: {"paid-task"}}, map[string]*model.Task{"paid-task": &chargedTask}))
				require.NoError(t, db.First(&chargedTask, chargedTask.ID).Error)
				require.EqualValues(t, model.TaskStatusInProgress, chargedTask.Status, "known settlement delay must not trigger the 20th-error refund")
				assert.Zero(t, chargedTask.PrivateData.PollFailures)
				assert.Equal(t, 825000, chargedTask.Quota)
				require.NoError(t, db.First(&user, user.Id).Error)
				require.NoError(t, db.First(&token, token.Id).Error)
				assert.Equal(t, initial-825000, user.Quota)
				assert.Equal(t, initial-825000, token.RemainQuota)
			}
			poller.body = raw
			require.NoError(t, service.UpdateVideoTasks(t.Context(), "ustori", map[int][]string{ch.Id: {"paid-task"}}, map[string]*model.Task{"paid-task": &chargedTask}))
			require.NoError(t, db.First(&chargedTask, chargedTask.ID).Error)
			require.Equal(t, model.TaskStatus(tc.status), chargedTask.Status)
			require.Equal(t, tc.quota, chargedTask.Quota)
			actual := 0
			if tc.status == "FAILURE" {
				require.True(t, service.RefundTaskQuota(t.Context(), &chargedTask, result.Reason))
				require.True(t, service.RefundTaskQuota(t.Context(), &chargedTask, result.Reason))
			} else {
				settlement, _, err := service.EvaluateTaskCompletionUsage(snap, result.UsageFacts)
				require.NoError(t, err)
				actual = settlement.ActualQuotaAfterGroup
				service.RecalculateTaskQuota(t.Context(), &chargedTask, actual, common.NewMessage("UStori actual credits"))
				service.RecalculateTaskQuota(t.Context(), &chargedTask, actual, common.NewMessage("UStori actual credits"))
			}
			require.NoError(t, db.First(&user, user.Id).Error)
			require.NoError(t, db.First(&token, token.Id).Error)
			require.NoError(t, db.First(&chargedTask, chargedTask.ID).Error)
			assert.Equal(t, initial-tc.quota, user.Quota)
			assert.Equal(t, initial-tc.quota, token.RemainQuota)
			assert.Equal(t, tc.quota, chargedTask.Quota)
			assert.Equal(t, tc.quota, user.UsedQuota)
			if tc.status == "FAILURE" {
				return
			}
			require.EqualValues(t, tc.credits, result.UsageFacts["credits"])
			settled, facts, err := service.EvaluateTaskCompletionUsage(snap, result.UsageFacts)
			require.NoError(t, err)
			assert.Equal(t, tc.quota, settled.ActualQuotaAfterGroup)
			assert.EqualValues(t, tc.credits, facts["credits"])
			assert.EqualValues(t, 16.5, snap.UsageFacts["credits"], "frozen reservation is not overwritten")
		})
	}
}

// Only the upstream HTTP response is simulated; the stock poller, JS parser,
// frozen expression and SQLite wallet/refund path are real.
type ustoriPollingFixture struct {
	*adaptor.TaskAdaptor
	body []byte
}

func (f *ustoriPollingFixture) FetchTask(_ string, _ string, _ *model.Task, _ string) (*http.Response, error) {
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(f.body))}, nil
}

func TestUStoriBillingRecheck(t *testing.T) {
	source, err := os.ReadFile("plugin.js")
	require.NoError(t, err)
	plugin, err := jsplugin.NewRegistry().Register(string(source), jsplugin.Options{})
	require.NoError(t, err)
	host := adaptor.New(plugin)
	host.Init(&relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{ChannelBaseUrl: "https://mock.example", ApiKey: "mock-only"}})
	for _, tc := range []struct {
		name, fields, code string
	}{
		{"reserved", `"billing_status":"reserved","charged_amount":0`, "ustori_billing_pending"},
		{"amount not published", `"billing_status":"charged","billing_rule_version":"discount_cent_v1"`, "ustori_billing_amount_pending"},
		{"null amount", `"billing_status":"charged","billing_rule_version":"discount_cent_v1","charged_amount":null`, "ustori_billing_amount_pending"},
		{"units not published", `"billing_status":"charged","charged_amount":830000`, "ustori_billing_version_pending"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			task := &model.Task{TaskID: "task_recheck", PrivateData: model.TaskPrivateData{UpstreamTaskID: "original-job", PluginState: []byte(`{"autoDuration":false,"billingMode":"ustori_credits_v1","model":"Seedance-2.5"}`)}}
			pending := []byte(`{"id":"original-job","model_name":"Seedance-2.5","status":"completed","result":{"videos":["https://cdn.example/video.mp4"]},` + tc.fields + `}`)
			result, err := host.ParseTaskResult(task, &http.Response{StatusCode: 200}, pending)
			require.NoError(t, err)
			require.Equal(t, "IN_PROGRESS", result.Status)
			assert.Empty(t, result.UsageFacts, "a pending invoice must neither settle at estimate nor refund")
			assert.Contains(t, result.Reason, tc.code)
			task.Status, task.Progress, task.Data = model.TaskStatus(result.Status), result.Progress, pending
			wire, err := host.ConvertToOpenAIVideo(task)
			require.NoError(t, err)
			var view map[string]any
			require.NoError(t, common.Unmarshal(wire, &view))
			assert.Equal(t, "in_progress", view["status"])
			require.Contains(t, view, "billing")
			notice := view["billing"].(map[string]any)
			assert.Equal(t, "pending", notice["status"])
			assert.Equal(t, tc.code, notice["code"])
			assert.Contains(t, notice["message"], "请勿重复提交")
			assert.Contains(t, notice["message"], "管理员")
			assert.NotContains(t, view, "video_url")
			assert.NotContains(t, view, "error")
			artifacts, err := host.ListArtifacts(task)
			require.NoError(t, err)
			assert.Empty(t, artifacts)
			query, err := plugin.Engine.Call(t.Context(), "buildQueryRequest", map[string]any{"baseUrl": "https://mock.example", "taskId": "original-job", "apiKey": "mock-only"})
			require.NoError(t, err)
			assert.Equal(t, "GET", query.(map[string]any)["method"])
			assert.Equal(t, "https://mock.example/api/v1/tasks/original-job", query.(map[string]any)["url"])
			// A later invoice settles only actual credits; the pending notice disappears.
			completed := []byte(`{"id":"original-job","model_name":"Seedance-2.5","status":"completed","billing_status":"charged","billing_rule_version":"discount_cent_v1","charged_amount":830000,"result":{"videos":["https://cdn.example/video.mp4"]}}`)
			result, err = host.ParseTaskResult(task, &http.Response{StatusCode: 200}, completed)
			require.NoError(t, err)
			require.Equal(t, "SUCCESS", result.Status)
			assert.EqualValues(t, 8.3, result.UsageFacts["credits"])
			task.Status, task.Data = model.TaskStatusSuccess, completed
			wire, err = host.ConvertToOpenAIVideo(task)
			require.NoError(t, err)
			view = nil
			require.NoError(t, common.Unmarshal(wire, &view))
			assert.NotContains(t, view, "billing")
			assert.Equal(t, "https://cdn.example/video.mp4", view["video_url"])
		})
	}
}
