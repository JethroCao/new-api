package controller

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTaskCapacityErrorPreservesSpecificBridgeReason(t *testing.T) {
	require.NoError(t, i18n.Init())
	for _, tc := range []struct {
		name                 string
		status               int
		input, code, message string
	}{
		{"active queue", 429, `{"error":{"code":"active_queue_full","message":"unsafe upstream detail"}}`, "active_queue_full", "Active video queue is full. Please retry after existing tasks finish."},
		{"admission", 429, `{"error":{"code":"submission_admission_full"}}`, "submission_admission_full", "Too many simultaneous submission requests. Please retry shortly."},
		{"storage", 503, `{"error":{"code":"job_storage_unavailable","message":"/private/path"}}`, "job_storage_unavailable", "Task storage is unavailable. Please contact the operator."},
		{"other upstream", 429, `{"error":{"code":"vendor_limit","message":"private"}}`, "fail_to_fetch_task", "The upstream of the current group is at capacity. Please try again later"},
		{"wrong status", 429, `{"error":{"code":"job_storage_unavailable"}}`, "fail_to_fetch_task", "The upstream of the current group is at capacity. Please try again later"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/videos", nil)
			c.Request.Header.Set("Accept-Language", "en")
			respondTaskError(c, &dto.TaskError{Code: "fail_to_fetch_task", Message: tc.input, StatusCode: tc.status})
			assert.Equal(t, tc.status, w.Code)
			var body dto.TaskError
			require.NoError(t, common.Unmarshal(w.Body.Bytes(), &body))
			assert.Equal(t, tc.code, body.Code)
			assert.Equal(t, tc.message, body.Message)
		})
	}
}
