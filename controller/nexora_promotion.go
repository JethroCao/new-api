package controller

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

func GetNexoraPromotion(c *gin.Context) {
	id := c.GetInt("id")
	if id <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Unauthorized"))
		return
	}
	page, size := 1, 20
	for key, values := range c.Request.URL.Query() {
		if len(values) != 1 || (key != "page" && key != "page_size") {
			common.ApiErrorStatus(c, http.StatusBadRequest, common.NewMessage("Invalid promotion query"))
			return
		}
		value, err := strconv.Atoi(values[0])
		limit := 1_000_000
		if key == "page_size" {
			limit = 100
		}
		if err != nil || value < 1 || value > limit {
			common.ApiErrorStatus(c, http.StatusBadRequest, common.NewMessage("Invalid promotion query"))
			return
		}
		if key == "page" {
			page = value
		} else {
			size = value
		}
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()
	data, err := model.GetNexoraPromotion(ctx, id, page, size)
	if err != nil {
		common.ApiErrorStatus(c, http.StatusInternalServerError, common.NewMessage("Unable to load promotion statistics"))
		return
	}
	common.ApiSuccess(c, data)
}
