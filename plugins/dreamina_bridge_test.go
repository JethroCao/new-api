package plugins_test

import (
	"os"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Load the uploadable integration through the actual gateway engine, including
// manifest/protocol validation and its isolated JavaScript implementation.
func TestDreaminaBridgePlugin(t *testing.T) {
	source, err := os.ReadFile("../integrations/dreamina/plugin.js")
	require.NoError(t, err)
	plugin, err := jsplugin.NewRegistry().RegisterFactory(string(source), jsplugin.Options{Key: "dreamina-cli"})
	require.NoError(t, err)
	value, err := plugin.Engine.Call(t.Context(), "buildSubmitRequest", map[string]any{
		"model": "seedance_2.5", "upstreamModel": "seedance_2.5", "publicTaskId": "task-public-123",
		"baseUrl": "http://127.0.0.1:8787", "apiKey": "bridge-test-key",
		"requestBody": map[string]any{"model": "seedance_2.5", "kind": "video", "prompt": "a paper boat", "seconds": 10, "n": 2, "resolution": "1080p", "ratio": "9:16"},
	})
	require.NoError(t, err)
	encoded, err := common.Marshal(value)
	require.NoError(t, err)
	var request map[string]any
	require.NoError(t, common.Unmarshal(encoded, &request))
	assert.Equal(t, "http://127.0.0.1:8787/v1/jobs", request["url"])
	headers, ok := request["headers"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "task-public-123", headers["Idempotency-Key"])
	body, ok := request["body"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, float64(2), body["n"])
	assert.Equal(t, "video", body["kind"])
	assert.Equal(t, "1080p", body["resolution"])
}

// Exercise the same decoded snapshot through host hooks: multipart placeholders
// must survive the JS runtime, and settlement must count delivered outputs.
func TestDreaminaVideoHostHooks(t *testing.T) {
	source, err := os.ReadFile("../integrations/dreamina/plugin.js")
	require.NoError(t, err)
	plugin, err := jsplugin.NewRegistry().RegisterFactory(string(source), jsplugin.Options{Key: "dreamina-cli"})
	require.NoError(t, err)
	value, err := plugin.Engine.CallPath(t.Context(), "protocols", []string{"openai_video", "decodeRequest"}, map[string]any{
		"operation": "create", "model": "seedance_2.5",
		"body": map[string]any{"kind": "multipart", "fields": map[string]any{
			"prompt": []string{"waves"}, "seconds": []string{"12"}, "n": []string{"3"}, "resolution": []string{"1080p"},
		}, "files": []any{map[string]any{"ref": "request_file:input_reference", "field": "input_reference", "mimeType": "image/png", "size": 100}}},
	})
	require.NoError(t, err)
	encoded, err := common.Marshal(value)
	require.NoError(t, err)
	var intent map[string]any
	require.NoError(t, common.Unmarshal(encoded, &intent))
	ctx := map[string]any{"model": "seedance_2.5", "requestBody": intent["requestBody"], "publicTaskId": "task_host", "baseUrl": "http://bridge", "apiKey": "test"}
	for _, tc := range []struct {
		hook string
		args []any
		want string
	}{
		{"buildSubmitRequest", []any{ctx}, `"__fileRef":"request_file:input_reference"`},
		{"extractUsage", []any{ctx}, `"seconds":36`},
		{"extractUsageOnComplete", []any{ctx, map[string]any{}, map[string]any{"object": "video", "status": "completed", "seconds": 12, "video_count": 2}}, `"seconds":24`},
		{"listArtifacts", []any{map[string]any{"status": "SUCCESS", "data": map[string]any{"object": "video", "video_count": 2}}}, `"key":"video-2"`},
	} {
		t.Run(tc.hook, func(t *testing.T) {
			v, err := plugin.Engine.Call(t.Context(), tc.hook, tc.args...)
			require.NoError(t, err)
			b, err := common.Marshal(v)
			require.NoError(t, err)
			assert.Contains(t, string(b), tc.want)
		})
	}

	// Promotion is not authorized by merely knowing a public ID. The host
	// must resolve and supply the owned source task before this hook succeeds.
	ctx["requestBody"] = map[string]any{"mode": "promote", "draft_task_id": "task_draft", "resolution": "1080p"}
	_, err = plugin.Engine.Call(t.Context(), "buildSubmitRequest", ctx)
	require.ErrorContains(t, err, "owned")
	ctx["originTasks"] = []any{map[string]any{"taskId": "task_draft", "upstreamTaskId": "bridge_source", "status": "SUCCESS", "data": map[string]any{
		"model": "seedance_2.5_draft", "n": 1, "video_count": 1, "seconds": 12, "ratio": "9:16",
	}}}
	value, err = plugin.Engine.Call(t.Context(), "buildSubmitRequest", ctx)
	require.NoError(t, err)
	encoded, err = common.Marshal(value)
	require.NoError(t, err)
	assert.Contains(t, string(encoded), `"source_job_id":"bridge_source"`)
	assert.Contains(t, string(encoded), `"seconds":12`)
}
