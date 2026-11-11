package ustori_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/relay/channel"
	adaptor "github.com/QuantumNous/new-api/relay/channel/task/jsplugin"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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
			if tc.upstreamModel == "Wan-3.0" {
				assert.EqualValues(t, 30, facts["seconds"])
			} else {
				assert.EqualValues(t, 5, facts["seconds"])
			}
		})
	}

	t.Run("poll, render, and download using only fixtures", func(t *testing.T) {
		driver := map[string]any{"requestBody": map[string]any{"duration": -1}}
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
		state, err := common.Marshal(parsed["state"])
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
