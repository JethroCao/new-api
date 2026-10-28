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
		"model": "dreamina-image", "upstreamModel": "dreamina-image", "publicTaskId": "task-public-123",
		"baseUrl": "http://127.0.0.1:8787", "apiKey": "bridge-test-key",
		"requestBody": map[string]any{"model": "dreamina-image", "kind": "image", "prompt": "a paper boat", "n": 2},
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
	assert.Equal(t, "image", body["kind"])
}
