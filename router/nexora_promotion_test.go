package router

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// Run against disposable databases only. Production queries are SELECT-only;
// the fixture creates the existing official tables, never new feature tables.
func TestNexoraPromotion(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			var driver gorm.Dialector
			switch dialect {
			case "sqlite":
				driver = sqlite.Open(":memory:")
			case "mysql":
				dsn := os.Getenv("NEXORA_PROMOTION_MYSQL_DSN")
				if dsn == "" {
					t.Skip("disposable MySQL DSN not configured")
				}
				driver = mysql.Open(dsn)
			case "postgres":
				dsn := os.Getenv("NEXORA_PROMOTION_POSTGRES_DSN")
				if dsn == "" {
					t.Skip("disposable PostgreSQL DSN not configured")
				}
				driver = postgres.Open(dsn)
			}
			db, err := gorm.Open(driver, &gorm.Config{})
			require.NoError(t, err)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			sqlDB.SetMaxOpenConns(1)
			oldDB, oldLog, oldRedis, oldSecret := model.DB, model.LOG_DB, common.RedisEnabled, common.SessionSecret
			model.DB, model.LOG_DB, common.RedisEnabled, common.SessionSecret = db, db, false, "promotion-local-test-only"
			t.Cleanup(func() {
				model.DB, model.LOG_DB, common.RedisEnabled, common.SessionSecret = oldDB, oldLog, oldRedis, oldSecret
				assert.NoError(t, sqlDB.Close())
			})
			require.NoError(t, db.AutoMigrate(&model.User{}, &model.Task{}, &model.TopUp{}, &model.Redemption{}, &model.UserSession{}, &model.Option{}, &model.UserAccessToken{}, &model.AuditLog{}, &model.Midjourney{}, &model.SubscriptionOrder{}))
			require.NoError(t, model.EnsureLegacyAccessTokenRetireAt(time.Now().Unix()))
			versionQuery := "SELECT version()"
			if dialect == "sqlite" {
				versionQuery = "SELECT sqlite_version()"
			}
			var version string
			require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
			t.Log("DB:", version)
			suffix := fmt.Sprintf("%d", time.Now().UnixNano())
			inviter := model.User{Username: "owner-" + suffix, AffCode: "a" + suffix, Role: common.RoleCommonUser, Status: common.UserStatusEnabled, AuthVersion: 1}
			require.NoError(t, db.Create(&inviter).Error)
			other := model.User{Username: "other-" + suffix, AffCode: "b" + suffix, Role: common.RoleCommonUser, Status: common.UserStatusEnabled, AuthVersion: 1}
			require.NoError(t, db.Create(&other).Error)
			child := model.User{Username: "invitee-" + suffix, InviterId: inviter.Id, UsedQuota: 1000, Quota: 4000, AffCode: "c" + suffix}
			require.NoError(t, db.Create(&child).Error)
			deleted := model.User{Username: "deleted-private-name-" + suffix, InviterId: inviter.Id, UsedQuota: 200, AffCode: "d" + suffix}
			require.NoError(t, db.Create(&deleted).Error)
			require.NoError(t, db.Delete(&deleted).Error)
			unrelated := model.User{Username: "outsider-" + suffix, InviterId: other.Id, UsedQuota: 999999, AffCode: "e" + suffix}
			require.NoError(t, db.Create(&unrelated).Error)
			grandchild := model.User{Username: "grandchild-" + suffix, InviterId: child.Id, UsedQuota: 888888, AffCode: "f" + suffix}
			require.NoError(t, db.Create(&grandchild).Error)
			ids := []int{inviter.Id, other.Id, child.Id, deleted.Id, unrelated.Id, grandchild.Id}
			t.Cleanup(func() {
				assert.NoError(t, db.Where("user_id IN ?", ids).Delete(&model.Task{}).Error)
				assert.NoError(t, db.Where("user_id IN ?", ids).Delete(&model.Midjourney{}).Error)
				assert.NoError(t, db.Where("user_id IN ?", ids).Delete(&model.SubscriptionOrder{}).Error)
				assert.NoError(t, db.Where("user_id IN ?", ids).Delete(&model.UserAccessToken{}).Error)
				assert.NoError(t, db.Where("user_id IN ?", ids).Delete(&model.TopUp{}).Error)
				assert.NoError(t, db.Unscoped().Where("used_user_id IN ?", ids).Delete(&model.Redemption{}).Error)
				assert.NoError(t, db.Where("user_id IN ?", ids).Delete(&model.UserSession{}).Error)
				assert.NoError(t, db.Unscoped().Where("id IN ?", ids).Delete(&model.User{}).Error)
			})
			for i, item := range []model.Task{
				{UserId: child.Id, Status: model.TaskStatusInProgress, Quota: 300},
				{UserId: child.Id, Status: model.TaskStatusFailure, Quota: 50}, // refund still outstanding
				{UserId: child.Id, Status: model.TaskStatusFailure, Quota: 0},  // refund done
				{UserId: child.Id, Status: model.TaskStatusSuccess, Quota: 650},
				{UserId: unrelated.Id, Status: model.TaskStatusQueued, Quota: 9999},
			} {
				item.TaskID = fmt.Sprintf("promotion-%s-%d", suffix, i)
				require.NoError(t, db.Create(&item).Error)
			}
			for i, item := range []model.TopUp{
				{UserId: child.Id, Amount: 2, Money: 100, PaymentProvider: "epay", PaymentMethod: "alipay", Status: common.TopUpStatusSuccess, CreateTime: 1},
				{UserId: child.Id, Amount: 900, Money: 3, PaymentProvider: "stripe", PaymentMethod: "stripe", Status: common.TopUpStatusSuccess},
				{UserId: child.Id, Amount: 4, Money: 700, PaymentProvider: "creem", PaymentMethod: "creem", Status: common.TopUpStatusSuccess},
				{UserId: child.Id, Amount: 99, Status: common.TopUpStatusPending},
				{UserId: deleted.Id, Amount: 1, PaymentMethod: "wxpay", Status: common.TopUpStatusSuccess},
				{UserId: unrelated.Id, Amount: 999, PaymentProvider: "epay", Status: common.TopUpStatusSuccess},
				{UserId: child.Id, Amount: 999, PaymentProvider: "unknown", Status: common.TopUpStatusSuccess},
			} {
				item.TradeNo = fmt.Sprintf("promotion-%s-%d", suffix, i)
				require.NoError(t, db.Create(&item).Error)
			}
			redemption := model.Redemption{Key: "promotion-" + suffix, UsedUserId: child.Id, Status: common.RedemptionCodeStatusUsed, Quota: 75}
			require.NoError(t, db.Create(&redemption).Error)
			require.NoError(t, db.Delete(&redemption).Error)
			session := model.UserSession{SID: "promotion-" + suffix, UserID: inviter.Id, Version: 1, UserAuthVersion: 1, Status: model.UserSessionStatusActive, RefreshHash: strings.Repeat("0", 64), LoginMethod: "password", ExpiresAt: time.Now().Unix() + 3600}
			require.NoError(t, db.Create(&session).Error)
			token, _, err := service.IssueAccessToken(service.AuthIdentity{UserID: inviter.Id, SessionID: session.SID, UserAuthVersion: 1, SessionVersion: 1})
			require.NoError(t, err)
			gin.SetMode(gin.TestMode)
			engine := gin.New()
			group := engine.Group("/api/user", middleware.DisableCache(), middleware.UserAuth())
			registerNexoraPromotionRoutes(group)
			request := func(path, credential string) *httptest.ResponseRecorder {
				t.Helper()
				req := httptest.NewRequest(http.MethodGet, path, nil)
				if credential != "" {
					req.Header.Set("Authorization", "Bearer "+credential)
				}
				rec := httptest.NewRecorder()
				engine.ServeHTTP(rec, req)
				return rec
			}
			path := "/api/user/promotion"
			t.Run("anonymous and forged credentials cannot read invitees", func(t *testing.T) {
				for _, credential := range []string{"", "invalid-token"} {
					res := request(path, credential)
					assert.Equal(t, http.StatusUnauthorized, res.Code)
					assert.NotContains(t, res.Body.String(), child.Username)
				}
			})
			t.Run("all history and only direct own invitees", func(t *testing.T) {
				res := request(path+"?page_size=1", token)
				require.Equal(t, 200, res.Code, res.Body.String())
				assert.Contains(t, res.Header().Get("Cache-Control"), "no-store")
				var body struct {
					Success bool                  `json:"success"`
					Data    model.NexoraPromotion `json:"data"`
				}
				require.NoError(t, common.Unmarshal(res.Body.Bytes(), &body))
				require.True(t, body.Success, res.Body.String())
				assert.EqualValues(t, 2, body.Data.Total)
				require.Len(t, body.Data.Items, 1)
				assert.Equal(t, "", body.Data.Items[0].Username)
				assert.True(t, body.Data.Items[0].Deleted)
				assert.EqualValues(t, 850, *body.Data.Summary.ConsumptionQuota)
				assert.EqualValues(t, 350, body.Data.Summary.PendingQuota)
				assert.EqualValues(t, 75, body.Data.Summary.RedemptionQuota)
				assert.EqualValues(t, 6*common.QuotaPerUnit, body.Data.Summary.RechargeQuota)
				assert.EqualValues(t, 2, body.Data.Summary.UnverifiedOrders)
				assert.NotContains(t, res.Body.String(), "deleted-private-name")
				assert.NotContains(t, res.Body.String(), unrelated.Username)
				res = request(path+"?page=2&page_size=1", token)
				require.NoError(t, common.Unmarshal(res.Body.Bytes(), &body))
				require.Len(t, body.Data.Items, 1)
				assert.Equal(t, child.Username, body.Data.Items[0].Username)
				assert.EqualValues(t, 650, *body.Data.Items[0].ConsumptionQuota)
			})
			t.Run("reject tampered scope and invalid pagination", func(t *testing.T) {
				for _, query := range []string{"?inviter_id=1", "?user_id=1", "?page=-1", "?page_size=101", "?page_size=0", "?page=99999999999999999999"} {
					res := request(path+query, token)
					assert.Equal(t, 400, res.Code, query)
				}
			})
			t.Run("no invitees returns zero totals and an empty list", func(t *testing.T) {
				data, err := model.GetNexoraPromotion(t.Context(), grandchild.Id, 1, 20)
				require.NoError(t, err)
				assert.Empty(t, data.Items)
				assert.Zero(t, data.Total)
				require.NotNil(t, data.Summary.ConsumptionQuota)
				assert.Zero(t, *data.Summary.ConsumptionQuota)
			})
			t.Run("subscription payment does not credit the wallet", func(t *testing.T) {
				order := model.SubscriptionOrder{UserId: child.Id, TradeNo: "subscription-" + suffix, Money: 50, PaymentMethod: "stripe", Status: common.TopUpStatusSuccess}
				require.NoError(t, db.Create(&order).Error)
				topup := model.TopUp{UserId: child.Id, TradeNo: order.TradeNo, Amount: 0, Money: 50, PaymentMethod: "stripe", Status: common.TopUpStatusSuccess}
				require.NoError(t, db.Create(&topup).Error)
				data, err := model.GetNexoraPromotion(t.Context(), inviter.Id, 1, 20)
				require.NoError(t, err)
				assert.EqualValues(t, 6*common.QuotaPerUnit, data.Summary.RechargeQuota)
				assert.EqualValues(t, 2, data.Summary.UnverifiedOrders)
			})
			t.Run("legacy Midjourney reserves are excluded until charged or refunded", func(t *testing.T) {
				require.NoError(t, db.Model(&model.User{}).Where("id = ?", child.Id).Update("used_quota", 1080).Error)
				t.Cleanup(func() {
					assert.NoError(t, db.Model(&model.User{}).Where("id = ?", child.Id).Update("used_quota", 1000).Error)
				})
				for _, task := range []model.Midjourney{{UserId: child.Id, Status: "IN_PROGRESS", Quota: 60}, {UserId: child.Id, Status: "FAILURE", Quota: 20}, {UserId: child.Id, Status: "SUCCESS", Quota: 100}} {
					require.NoError(t, db.Create(&task).Error)
				}
				t.Cleanup(func() { assert.NoError(t, db.Where("user_id = ?", child.Id).Delete(&model.Midjourney{}).Error) })
				data, err := model.GetNexoraPromotion(t.Context(), inviter.Id, 1, 20)
				require.NoError(t, err)
				assert.EqualValues(t, 430, data.Summary.PendingQuota)
				assert.EqualValues(t, 850, *data.Summary.ConsumptionQuota)
			})
			t.Run("valid PAT and legacy tokens cannot bypass session-only policy", func(t *testing.T) {
				raw := model.AccessTokenPrefix + strings.Repeat("z", 43)
				pat := model.UserAccessToken{Name: "promotion-test", TokenHash: model.AccessTokenFingerprint(raw), TokenHint: model.AccessTokenHint(raw)}
				require.NoError(t, pat.SetScopes([]string{"wallet:read"}))
				require.NoError(t, model.CreateUserAccessToken(inviter.Id, &pat, service.AccessTokenMaxPerUser))
				legacy := "legacy-" + suffix
				require.NoError(t, db.Model(&model.User{}).Where("id = ?", inviter.Id).Update("access_token", legacy).Error)
				for _, credential := range []string{raw, legacy} {
					res := request(path, credential)
					assert.Equal(t, http.StatusForbidden, res.Code, res.Body.String())
					assert.NotContains(t, res.Body.String(), child.Username)
				}
			})
			t.Run("revoked sessions cannot read invitee finances", func(t *testing.T) {
				require.NoError(t, db.Model(&model.UserSession{}).Where("sid = ?", session.SID).Update("status", model.UserSessionStatusRevoked).Error)
				res := request(path, token)
				assert.Equal(t, http.StatusUnauthorized, res.Code)
				require.NoError(t, db.Model(&model.UserSession{}).Where("sid = ?", session.SID).Update("status", model.UserSessionStatusActive).Error)
			})

			t.Run("transient counter lag is unknown instead of a negative charge", func(t *testing.T) {
				require.NoError(t, db.Model(&model.User{}).Where("id = ?", child.Id).Update("used_quota", 100).Error)
				data, err := model.GetNexoraPromotion(t.Context(), inviter.Id, 1, 20)
				require.NoError(t, err)
				assert.Nil(t, data.Summary.ConsumptionQuota)
				assert.Nil(t, data.Items[1].ConsumptionQuota)
			})
			t.Run("expired session cannot read financial data", func(t *testing.T) {
				require.NoError(t, db.Model(&model.UserSession{}).Where("sid = ?", session.SID).Update("expires_at", time.Now().Unix()-1).Error)
				res := request(path, token)
				assert.Equal(t, 401, res.Code)
				assert.NotContains(t, res.Body.String(), child.Username)
			})
		})
	}
}
