package router

import (
	"github.com/QuantumNous/new-api/controller"
	"github.com/gin-gonic/gin"
)

// Call only on the existing authenticated, no-cache dashboard user group.
func registerNexoraPromotionRoutes(self *gin.RouterGroup) {
	self.GET("/promotion", controller.GetNexoraPromotion)
}
